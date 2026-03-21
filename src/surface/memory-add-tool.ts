import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { isLikelyEntityName } from "../entity/entity-quality-filter.js";
import { ensureWorldModelReady, findEntityMatches } from "../entity/world-model.js";
import { resolveSourceAgentIdFromSessionContext } from "../memory/agent-namespace.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import { upsertMemoryTrigger } from "../memory/memory-triggers.js";
import {
  reindexNativeMemoryLayer,
  syncNativeMemoryLayer,
  type NativeSyncResult,
} from "../memory/native-file-sync.js";
import {
  classifyValue,
  detectJunk,
  hasTemporalContext,
  hashNormalized,
  inferKind,
  normalizeContent,
  type MemoryKind,
  type ValueLabel,
  VALID_KINDS,
} from "../memory/memory-utils.js";
import { reindexMemoryVectorById } from "../memory/vector-search.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const MemoryAddSchema = Type.Object({
  content: Type.String({
    description: "The memory content to store. Required. Must be meaningful text, not system noise.",
  }),
  kind: Type.Optional(
    Type.String({
      description:
        "Memory kind/type. One of: USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT.",
      enum: VALID_KINDS,
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description: 'Memory scope. Defaults to "shared".',
    }),
  ),
  entities: Type.Optional(
    Type.Array(Type.String(), {
      description: "Named entities to associate with this memory.",
    }),
  ),
  confidence: Type.Optional(
    Type.Number({
      description: "Optional confidence override between 0 and 1.",
      minimum: 0,
      maximum: 1,
    }),
  ),
  dedupeMode: Type.Optional(
    Type.String({
      description: "Duplicate handling mode. Defaults to global semantic dedupe.",
      enum: ["none", "global", "session"],
    }),
  ),
  triggerPattern: Type.Optional(
    Type.String({
      description:
        "Optional proactive trigger. If future prompts match this pattern, Engram surfaces the memory automatically.",
    }),
  ),
  triggerPatterns: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional additional proactive trigger patterns for this memory.",
    }),
  ),
});

export type { MemoryKind } from "../memory/memory-utils.js";

export type MemoryProvenance = Record<string, unknown>;

export type StoreMemoryParams = {
  config: LcmConfig;
  content: string;
  kind?: string | MemoryKind;
  scope?: string;
  entities?: string[];
  source?: string;
  sourceAgent?: string;
  sourceSession?: string;
  sourceTrigger?: string;
  confidence?: number;
  component?: string;
  provenance?: MemoryProvenance;
  sourceLayer?: string;
  sourcePath?: string | null;
  sourceLine?: number | null;
  contentTime?: string | null;
  dedupeMode?: "none" | "global" | "session";
  skipArchiveCandidates?: boolean;
};

export type StoreMemoryResult = {
  stored: boolean;
  reason?: string;
  gate?: string;
  detail?: string;
  matchedPattern?: string;
  content?: string;
  memoryId?: string;
  kind?: MemoryKind;
  scope?: string;
  status?: string;
  value_label?: ValueLabel;
  value_score?: number;
  reason_codes?: string[];
  episodeId?: string | null;
  entityIds?: string[];
};

type MemoryColumnInfo = {
  name?: string;
};

const SEMANTIC_DEDUPE_THRESHOLD = 0.8;
const SEMANTIC_DEDUPE_SCAN_LIMIT = 120;

function resolveConfidence(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function ensureCompatColumns(config: LcmConfig): void {
  const db = getLcmConnection(config.databasePath);
  ensureMemoryTables(db);
  const memoryColumns = db.prepare("PRAGMA table_info(memory_current)").all() as MemoryColumnInfo[];
  if (!memoryColumns.some((column) => column.name === "source_trigger")) {
    db.exec("ALTER TABLE memory_current ADD COLUMN source_trigger TEXT");
  }
  if (!memoryColumns.some((column) => column.name === "provenance")) {
    db.exec("ALTER TABLE memory_current ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}'");
  }
}

function findDuplicateMemoryId(params: {
  config: LcmConfig;
  normalizedHash: string;
  scope: string;
  kind: MemoryKind;
  sourceSession?: string;
  dedupeMode: "none" | "global" | "session";
}): string | undefined {
  if (!params.normalizedHash || params.dedupeMode === "none") {
    return undefined;
  }

  const db = getLcmConnection(params.config.databasePath);
  if (params.dedupeMode === "session" && params.sourceSession) {
    const row = db
      .prepare(`
        SELECT memory_id
        FROM memory_current
        WHERE normalized_hash = ? AND scope = ? AND type = ? AND COALESCE(source_session, '') = ?
        LIMIT 1
      `)
      .get(
        params.normalizedHash,
        params.scope,
        params.kind,
        params.sourceSession,
      ) as { memory_id?: string } | undefined;
    return typeof row?.memory_id === "string" ? row.memory_id : undefined;
  }

  const row = db
    .prepare(`
      SELECT memory_id
      FROM memory_current
      WHERE normalized_hash = ? AND scope = ? AND type = ?
      LIMIT 1
    `)
    .get(params.normalizedHash, params.scope, params.kind) as { memory_id?: string } | undefined;
  return typeof row?.memory_id === "string" ? row.memory_id : undefined;
}

function tokenizeNormalized(text: string): string[] {
  return normalizeContent(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function overlapSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenizeNormalized(left));
  const rightTokens = new Set(tokenizeNormalized(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  const overlap = intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  const jaccard = intersection / union;
  return Math.max(overlap, jaccard);
}

function findSemanticDuplicate(params: {
  db: ReturnType<typeof getLcmConnection>;
  content: string;
  scope: string;
  kind: MemoryKind;
  sourceSession?: string;
  dedupeMode: "none" | "global" | "session";
}): { memoryId: string; similarity: number } | undefined {
  if (params.dedupeMode === "none") {
    return undefined;
  }

  const where = ["status = 'active'", "scope = ?", "type = ?"];
  const queryParams: Array<string | number> = [params.scope, params.kind];
  if (params.dedupeMode === "session" && params.sourceSession) {
    where.push("COALESCE(source_session, '') = ?");
    queryParams.push(params.sourceSession);
  }

  const rows = params.db
    .prepare(
      `SELECT memory_id, content
       FROM memory_current
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(content_time, updated_at, created_at) DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...queryParams, SEMANTIC_DEDUPE_SCAN_LIMIT) as Array<{
    memory_id?: string;
    content?: string;
  }>;

  let best: { memoryId: string; similarity: number } | undefined;
  for (const row of rows) {
    const similarity = overlapSimilarity(params.content, String(row.content || ""));
    if (similarity < SEMANTIC_DEDUPE_THRESHOLD) {
      continue;
    }
    if (!best || similarity > best.similarity) {
      best = {
        memoryId: String(row.memory_id || ""),
        similarity,
      };
    }
  }

  return best;
}

function resolveEntityTags(
  db: ReturnType<typeof getLcmConnection>,
  config: LcmConfig,
  content: string,
  entities: string[],
): string[] {
  const resolved = new Set(
    entities
      .map((entity) => entity.trim())
      .filter(Boolean),
  );

  try {
    ensureWorldModelReady({ db, config });
    const matches = findEntityMatches(db, content, { limit: 4 });
    for (const match of matches) {
      const display = String(match.display_name || match.alias || "").trim();
      if (display) {
        resolved.add(display);
      }
    }
  } catch {
    // Auto-linking is best-effort.
  }

  return [...resolved];
}

export function storeMemory(params: StoreMemoryParams): StoreMemoryResult {
  const content = params.content.trim();
  if (!content) {
    return { stored: false, reason: "missing_content", content: params.content };
  }

  ensureCompatColumns(params.config);
  const db = getLcmConnection(params.config.databasePath);

  const rawKind = typeof params.kind === "string" ? params.kind.trim().toUpperCase() : "";
  const kind: MemoryKind = VALID_KINDS.includes(rawKind as MemoryKind)
    ? (rawKind as MemoryKind)
    : inferKind(content);

  const scope =
    typeof params.scope === "string" && params.scope.trim()
      ? params.scope.trim()
      : "shared";

  const entities = Array.isArray(params.entities)
    ? params.entities.map((entity) => entity.trim()).filter(Boolean)
    : [];
  const resolvedEntities = resolveEntityTags(db, params.config, content, entities);

  const junkResult = detectJunk(content);
  if (junkResult.junk) {
    return {
      stored: false,
      reason: "rejected_quality_gate",
      gate: "junk",
      detail: junkResult.reason ?? undefined,
      matchedPattern: junkResult.matchedPattern ?? undefined,
      content,
    };
  }

  const baselineConfidence = resolveConfidence(params.confidence, 0.75);
  const classification = classifyValue(content, kind, baselineConfidence);
  const isTemporalEpisode = kind === "EPISODE" || hasTemporalContext(content);
  const effectiveKind = isTemporalEpisode && kind !== "EPISODE" && hasTemporalContext(content)
    ? "EPISODE"
    : kind;
  if (params.skipArchiveCandidates && classification.action === "archive") {
    return {
      stored: false,
      reason: "low_value",
      detail: classification.value_label,
      kind: effectiveKind,
      value_label: classification.value_label,
      value_score: classification.value_score,
      reason_codes: classification.reason_codes,
    };
  }

  const source = params.source?.trim() || "manual";
  const sourceTrigger = params.sourceTrigger?.trim() || null;
  const component = params.component?.trim() || "memory_add";
  const now = new Date().toISOString();
  const memoryId = `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const normalized = normalizeContent(content);
  const normalizedHash = hashNormalized(content);
  const duplicateOf = findDuplicateMemoryId({
    config: params.config,
    normalizedHash,
    scope,
    kind: effectiveKind,
    sourceSession: params.sourceSession,
    dedupeMode: params.dedupeMode ?? "global",
  });
  if (duplicateOf) {
    return {
      stored: false,
      reason: "duplicate",
      detail: duplicateOf,
      kind: effectiveKind,
      scope,
    };
  }
  const semanticDuplicate = findSemanticDuplicate({
    db,
    content,
    scope,
    kind: effectiveKind,
    sourceSession: params.sourceSession,
    dedupeMode: params.dedupeMode ?? "global",
  });
  if (semanticDuplicate) {
    return {
      stored: false,
      reason: "duplicate_semantic",
      detail: `${semanticDuplicate.memoryId} (${semanticDuplicate.similarity.toFixed(2)} overlap)`,
      kind: effectiveKind,
      scope,
    };
  }
  const status = classification.action === "archive" ? "archived" : "active";
  const archivedAt = status === "archived" ? now : null;
  const tags = resolvedEntities.length > 0 ? JSON.stringify(resolvedEntities) : "[]";
  const provenance =
    params.provenance && typeof params.provenance === "object"
      ? JSON.stringify(params.provenance)
      : "{}";
  const sourceLayer = (params.sourceLayer || "registry").trim() || "registry";
  const sourcePath = params.sourcePath?.trim() || null;
  const sourceLine =
    typeof params.sourceLine === "number" && Number.isFinite(params.sourceLine)
      ? Math.trunc(params.sourceLine)
      : null;
  const contentTime = params.contentTime?.trim() || null;

  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash,
      source, source_agent, source_session, source_trigger, confidence, scope, status,
      value_score, value_label,
      created_at, updated_at, archived_at, tags, provenance,
      content_time, source_layer, source_path, source_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memoryId,
    effectiveKind,
    content,
    normalized,
    normalizedHash,
    source,
    params.sourceAgent?.trim() || null,
    params.sourceSession?.trim() || null,
    sourceTrigger,
    baselineConfidence,
    scope,
    status,
    classification.value_score,
    classification.value_label,
    now,
    now,
    archivedAt,
    tags,
    provenance,
    contentTime,
    sourceLayer,
    sourcePath,
    sourceLine,
  );

  let episodeId: string | null = null;
  if (isTemporalEpisode) {
    episodeId = `ep_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const title = content.length > 80 ? `${content.slice(0, 77)}...` : content;
    db.prepare(`
      INSERT INTO memory_episodes (
        episode_id, title, summary, start_date, end_date, status,
        source_memory_ids, payload
      ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run(
      episodeId,
      title,
      content,
      contentTime,
      contentTime,
      JSON.stringify([memoryId]),
      JSON.stringify({
        source,
        source_session: params.sourceSession ?? undefined,
        source_agent: params.sourceAgent ?? undefined,
        component,
      }),
    );
  }

  const linkedEntityIds: string[] = [];
  if (resolvedEntities.length > 0) {
    for (const entityName of resolvedEntities) {
      const normalizedName = entityName.toLowerCase().trim();
      // Filter out common English words that are not real entity names
      if (!isLikelyEntityName(normalizedName)) continue;
      const existing = db
        .prepare("SELECT entity_id FROM memory_entities WHERE normalized_name = ? LIMIT 1")
        .get(normalizedName) as { entity_id: string } | undefined;
      if (existing) {
        linkedEntityIds.push(existing.entity_id);
        db.prepare("UPDATE memory_entities SET updated_at = ? WHERE entity_id = ?")
          .run(now, existing.entity_id);
      } else {
        const entityId = `ent_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        db.prepare(`
          INSERT INTO memory_entities (
            entity_id, kind, display_name, normalized_name, status, confidence, created_at, updated_at
          ) VALUES (?, 'person', ?, ?, 'active', 0.7, ?, ?)
        `).run(entityId, entityName, normalizedName, now, now);
        linkedEntityIds.push(entityId);
      }
    }
  }

  db.prepare(`
    INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
    VALUES (?, ?, ?, 'store', ?, ?, ?)
  `).run(
    randomUUID(),
    now,
    component,
    memoryId,
    source,
    JSON.stringify({
      kind: effectiveKind,
      scope,
      source_trigger: sourceTrigger ?? undefined,
      value_label: classification.value_label,
      value_score: classification.value_score,
      reason_codes: classification.reason_codes,
      episode_id: episodeId ?? undefined,
      entity_ids: linkedEntityIds.length > 0 ? linkedEntityIds : undefined,
      provenance: params.provenance,
      source_layer: sourceLayer,
      source_path: sourcePath ?? undefined,
      source_line: sourceLine ?? undefined,
    }),
  );

  return {
    stored: true,
    memoryId,
    kind: effectiveKind,
    scope,
    status,
    value_label: classification.value_label,
    value_score: classification.value_score,
    reason_codes: classification.reason_codes,
    episodeId: episodeId ?? null,
    entityIds: linkedEntityIds,
  };
}

export function createMemoryAddTool(input: {
  config: LcmConfig;
  deps?: Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">;
  sessionKey?: string;
  resolveAgentDir?: () => string;
}): AnyAgentTool {
  return {
    name: "memory_add",
    label: "Memory Add",
    description:
      "Manually store a fact, preference, decision, entity, or episode into long-term memory. " +
      "Content passes quality gates before storage. Temporal content is automatically stored as an episode.",
    parameters: MemoryAddSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const content = typeof p.content === "string" ? p.content.trim() : "";
      if (!content) {
        return jsonResult({ error: "content is required and must be non-empty." });
      }

      const nativeRoot =
        input.config.nativeEnabled && typeof input.resolveAgentDir === "function"
          ? String(input.resolveAgentDir() || "").trim()
          : "";
      let nativeSyncWarning: string | null = null;
      let triggerWarning: string | null = null;

      if (nativeRoot) {
        try {
          reindexNativeMemoryLayer({
            db: getLcmConnection(input.config.databasePath),
            rootDir: nativeRoot,
          });
        } catch (err) {
          triggerWarning = err instanceof Error ? err.message : String(err);
        }
      }

      const details = storeMemory({
        config: input.config,
        content,
        kind: typeof p.kind === "string" ? p.kind : undefined,
        scope: typeof p.scope === "string" ? p.scope : undefined,
        entities: Array.isArray(p.entities)
          ? (p.entities as unknown[]).map((entity) => (typeof entity === "string" ? entity : ""))
          : undefined,
        confidence: typeof p.confidence === "number" ? p.confidence : undefined,
        dedupeMode:
          typeof p.dedupeMode === "string"
          && ["none", "global", "session"].includes(p.dedupeMode)
            ? (p.dedupeMode as "none" | "global" | "session")
            : "global",
        source: "manual",
        sourceAgent: resolveSourceAgentIdFromSessionContext({
          deps: input.deps,
          sessionKey: input.sessionKey,
        }),
        sourceSession: input.sessionKey,
        component: "memory_add",
      });
      if (!details.stored) {
        const lines = [
          "## Memory not stored",
          "",
          `**Reason:** ${details.reason || "unknown"}`,
        ];
        if (details.gate) lines.push(`**Gate:** ${details.gate}`);
        if (details.detail) lines.push(`**Detail:** ${details.detail}`);
        if (details.matchedPattern) lines.push(`**Matched pattern:** ${details.matchedPattern}`);
        if (details.kind) lines.push(`**Kind:** ${details.kind}`);
        if (details.scope) lines.push(`**Scope:** ${details.scope}`);
        if (details.value_label) {
          lines.push(`**Value:** ${details.value_label} (score: ${details.value_score?.toFixed(3)})`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details,
        };
      }

      const triggerPatterns = [
        typeof p.triggerPattern === "string" ? p.triggerPattern.trim() : "",
        ...(Array.isArray(p.triggerPatterns)
          ? (p.triggerPatterns as unknown[])
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
          : []),
      ].filter(Boolean);
      const triggerIds: string[] = [];
      if (details.memoryId && triggerPatterns.length > 0) {
        try {
          const db = getLcmConnection(input.config.databasePath);
          for (const pattern of triggerPatterns) {
            const trigger = upsertMemoryTrigger({
              db,
              memoryId: String(details.memoryId),
              pattern,
              metadata: { created_by: "memory_add" },
            });
            triggerIds.push(trigger.triggerId);
          }
        } catch (err) {
          nativeSyncWarning = err instanceof Error ? err.message : String(err);
        }
      }

      let vectorIndexWarning: string | null = null;
      try {
        await reindexMemoryVectorById({
          db: getLcmConnection(input.config.databasePath),
          config: input.config,
          memoryId: String(details.memoryId || ""),
        });
      } catch (err) {
        vectorIndexWarning = err instanceof Error ? err.message : String(err);
      }

      let nativeSync: Pick<NativeSyncResult, "rootDir" | "filesWritten" | "dailyNoteCount" | "paraFolderCount"> | null = null;
      if (nativeRoot) {
        try {
          const sync = syncNativeMemoryLayer({
            db: getLcmConnection(input.config.databasePath),
            rootDir: nativeRoot,
          });
          nativeSync = {
            rootDir: sync.rootDir,
            filesWritten: sync.filesWritten,
            dailyNoteCount: sync.dailyNoteCount,
            paraFolderCount: sync.paraFolderCount,
          };
        } catch (err) {
          nativeSyncWarning = err instanceof Error ? err.message : String(err);
        }
      }

      const lines: string[] = [];
      lines.push("## Memory stored");
      lines.push("");
      lines.push(`**ID:** \`${details.memoryId}\``);
      lines.push(`**Kind:** ${details.kind}`);
      lines.push(`**Scope:** ${details.scope}`);
      lines.push(`**Status:** ${details.status}`);
      lines.push(`**Value:** ${details.value_label} (score: ${details.value_score?.toFixed(3)})`);
      if (details.episodeId) lines.push(`**Episode:** \`${details.episodeId}\``);
      if ((details.entityIds?.length ?? 0) > 0) lines.push(`**Entities linked:** ${details.entityIds?.length}`);
      if (nativeSync) lines.push(`**Native sync:** wrote ${nativeSync.filesWritten} files`);
      if (triggerIds.length > 0) lines.push(`**Triggers:** ${triggerIds.length} proactive patterns registered`);
      if (triggerWarning) lines.push(`**Trigger warning:** ${triggerWarning}`);
      if (nativeSyncWarning) lines.push(`**Native sync warning:** ${nativeSyncWarning}`);
      if (vectorIndexWarning) lines.push(`**Vector indexing warning:** ${vectorIndexWarning}`);
      if (details.status === "archived") {
        lines.push("");
        lines.push("> Note: content was archived (low value score) but stored. Use `memory_query` to retrieve it.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          ...details,
          nativeSync,
          triggerWarning,
          nativeSyncWarning,
          vectorIndexWarning,
          triggerIds,
        },
      };
    },
  };
}
