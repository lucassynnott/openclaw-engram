import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { ensureWorldModelReady, findEntityMatches, getEntityDetail } from "../entity/world-model.js";
import { applyActivationEvent } from "../memory/activation.js";
import { isActivationModelEnabledForSeed } from "../memory/activation-rollout.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { fetchMemoryCandidates } from "./memory-recall-core.js";

const DEFAULT_RECALL_TOP_K = 8;
const DEFAULT_RECALL_MIN_SCORE = 0.45;
const DEFAULT_RECALL_MAX_TOKENS = 1200;

type ReinforceableMemoryRow = {
  memory_id: string;
  confidence: number | null;
  truth_confidence: number | null;
  value_score: number | null;
  activation_strength: number | null;
  reinforcement_count: number | null;
  last_reinforced_at: string | null;
  last_retrieved_at: string | null;
  updated_at: string | null;
  created_at: string | null;
};

const MemoryQuerySchema = Type.Object({
  query: Type.String({
    description: "The question or topic to search for.",
  }),
  strategy: Type.Optional(
    Type.String({
      description: "Recall strategy. Defaults to recall.defaultStrategy or auto.",
      enum: ["auto", "quick_context", "entity_brief", "relationship", "timeline", "verification"],
    }),
  ),
  entityId: Type.Optional(
    Type.String({
      description: "Optional entity lock for entity_brief, relationship, or timeline recall.",
    }),
  ),
  dateRange: Type.Optional(
    Type.Object({
      from: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
    }),
  ),
  afterDate: Type.Optional(
    Type.String({
      description: 'Legacy alias for dateRange.from. Format: "YYYY-MM-DD" or "YYYY-MM".',
    }),
  ),
  beforeDate: Type.Optional(
    Type.String({
      description: 'Legacy alias for dateRange.to. Format: "YYYY-MM-DD" or "YYYY-MM".',
    }),
  ),
  topK: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
    }),
  ),
  maxTokens: Type.Optional(
    Type.Number({
      minimum: 1,
    }),
  ),
  scope: Type.Optional(Type.String()),
  allScopes: Type.Optional(Type.Boolean()),
  includeArchived: Type.Optional(Type.Boolean()),
});

function parseDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  return null;
}

function pickStrategy(query: string, configuredDefault: string): string {
  const lower = query.toLowerCase();
  if (/\b(timeline|chronology|history|what happened|sequence)\b/.test(lower)) return "timeline";
  if (/\b(verify|verification|confirm|did we ever|is it true)\b/.test(lower)) return "verification";
  if (/\b(relationship|between|with whom|relate|connected)\b/.test(lower)) return "relationship";
  if (/\b(who is|what do we know about|entity brief|profile)\b/.test(lower)) return "entity_brief";
  if (configuredDefault && configuredDefault !== "auto") return configuredDefault;
  return "quick_context";
}

function truncateInlineText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toFiniteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseIsoDateMs(value: unknown, fallbackMs: number): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function reinforceReturnedMemories(params: {
  db: DatabaseSync;
  config: LcmConfig;
  memoryIds: string[];
  query: string;
  strategy: string;
}): void {
  ensureMemoryTables(params.db);
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const uniqueIds = [...new Set(params.memoryIds.map((id) => String(id).trim()).filter(Boolean))];

  for (const memoryId of uniqueIds) {
    if (!isActivationModelEnabledForSeed(params.config, memoryId)) {
      continue;
    }

    try {
      const row = params.db.prepare(`
        SELECT
          memory_id, confidence, truth_confidence, value_score, activation_strength,
          reinforcement_count, last_reinforced_at, last_retrieved_at, updated_at, created_at
        FROM memory_current
        WHERE memory_id = ?
        LIMIT 1
      `).get(memoryId) as ReinforceableMemoryRow | undefined;
      if (!row) {
        continue;
      }

      const nextActivation = applyActivationEvent(
        {
          activation: clamp01(
            toFiniteNumber(row.activation_strength)
              ?? Math.max(
                toFiniteNumber(row.truth_confidence)
                  ?? toFiniteNumber(row.confidence)
                  ?? 0.5,
                toFiniteNumber(row.value_score) ?? 0.45,
              ),
          ),
          reinforcementCount: Math.max(0, Math.trunc(toFiniteNumber(row.reinforcement_count) ?? 0)),
          lastReinforcedAtMs: parseIsoDateMs(
            row.last_reinforced_at ?? row.last_retrieved_at ?? row.updated_at ?? row.created_at,
            nowMs,
          ),
        },
        {
          type: "retrieval",
          atMs: nowMs,
        },
      );

      params.db.prepare(`
        UPDATE memory_current
        SET activation_strength = ?,
            reinforcement_count = ?,
            retrieval_count = COALESCE(retrieval_count, 0) + 1,
            last_reinforced_at = ?,
            last_retrieved_at = ?
        WHERE memory_id = ?
      `).run(
        nextActivation.activation,
        nextActivation.reinforcementCount,
        new Date(nextActivation.lastReinforcedAtMs).toISOString(),
        now,
        memoryId,
      );

      params.db.prepare(`
        INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
        VALUES (hex(randomblob(16)), ?, 'memory_query', 'reinforce_query', ?, 'system', ?)
      `).run(
        now,
        memoryId,
        JSON.stringify({
          surface: "memory_query",
          strategy: params.strategy,
          query: params.query,
        }),
      );
    } catch (err) {
      console.warn("[memory_query] reinforcement failed:", err);
    }
  }
}

function limitRecordCollection(
  items: unknown,
  limit: number,
  stringFieldLimits: Record<string, number>,
): { items: Array<Record<string, unknown>>; total: number; truncated: boolean } {
  const rows = Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const limited = rows.slice(0, limit).map((row) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string") {
        next[key] = truncateInlineText(value, stringFieldLimits[key] ?? 320);
      } else {
        next[key] = value;
      }
    }
    return next;
  });
  return {
    items: limited,
    total: rows.length,
    truncated: rows.length > limited.length,
  };
}

function buildEntityBriefPayload(detail: Record<string, unknown>): Record<string, unknown> {
  const beliefs = limitRecordCollection(detail.beliefs, 8, {
    content: 220,
    evidence: 220,
  });
  const episodes = limitRecordCollection(detail.episodes, 6, {
    title: 120,
    summary: 220,
  });
  const openLoops = limitRecordCollection(detail.open_loops, 6, {
    content: 180,
  });
  const syntheses = limitRecordCollection(detail.syntheses, 4, {
    content: 260,
    title: 120,
  });
  const links = limitRecordCollection(detail.links, 12, {
    relation: 80,
    target_display_name: 120,
  });

  return {
    entity_id: detail.entity_id,
    display_name: detail.display_name,
    normalized_name: detail.normalized_name,
    kind: detail.kind,
    status: detail.status,
    confidence: detail.confidence,
    aliases: Array.isArray(detail.aliases) ? (detail.aliases as unknown[]).slice(0, 12) : [],
    payload: detail.payload,
    beliefs: beliefs.items,
    episodes: episodes.items,
    open_loops: openLoops.items,
    syntheses: syntheses.items,
    links: links.items,
    counts: {
      beliefs: beliefs.total,
      episodes: episodes.total,
      open_loops: openLoops.total,
      syntheses: syntheses.total,
      links: links.total,
    },
    truncated:
      beliefs.truncated ||
      episodes.truncated ||
      openLoops.truncated ||
      syntheses.truncated ||
      links.truncated,
  };
}

function buildEntityBrief(db: DatabaseSync, query: string, entityId?: string): {
  result: string;
  confidence: number;
  sourceIds: string[];
  entity?: Record<string, unknown>;
} {
  const resolvedEntityId = (() => {
    if (entityId) return entityId;
    const matches = findEntityMatches(db, query, { limit: 1 });
    return matches[0]?.entity_id ? String(matches[0].entity_id) : "";
  })();
  if (!resolvedEntityId) {
    return {
      result: "No entity match found for this query.",
      confidence: 0.2,
      sourceIds: [],
    };
  }

  const detail = getEntityDetail(db, resolvedEntityId);
  if (!detail) {
    return {
      result: `Entity not found: ${resolvedEntityId}`,
      confidence: 0.2,
      sourceIds: [],
    };
  }

  const beliefs = Array.isArray(detail.beliefs) ? detail.beliefs.slice(0, 5) as Array<Record<string, unknown>> : [];
  const episodes = Array.isArray(detail.episodes) ? detail.episodes.slice(0, 4) as Array<Record<string, unknown>> : [];
  const syntheses = Array.isArray(detail.syntheses) ? detail.syntheses as Array<Record<string, unknown>> : [];
  const entityBriefPayload = buildEntityBriefPayload(detail);
  const brief =
    syntheses.find((item) => typeof item.kind === "string" && String(item.kind).includes("brief"))?.content
    || [
      `${String(detail.display_name || "Unknown")} (${String(detail.kind || "entity")})`,
      beliefs.length > 0 ? `Beliefs: ${beliefs.map((belief) => String(belief.content || "")).join(" | ")}` : "",
      episodes.length > 0
        ? `Episodes: ${episodes.map((episode) => `${String(episode.start_date || "undated")}: ${String(episode.summary || episode.title || "")}`).join(" | ")}`
        : "",
    ].filter(Boolean).join("\n");
  const briefText = typeof brief === "string" ? brief : String(brief ?? "");

  return {
    result: briefText,
    confidence: Number(detail.confidence || 0.7),
    sourceIds: [
      String(detail.entity_id || ""),
      ...beliefs.map((belief) => String(belief.belief_id || "")).filter(Boolean),
      ...episodes.map((episode) => String(episode.episode_id || "")).filter(Boolean),
    ],
    entity: entityBriefPayload,
  };
}

function buildTimeline(
  db: DatabaseSync,
  query: string,
  afterDate: string | null,
  beforeDate: string | null,
  entityId?: string,
): {
  result: string;
  confidence: number;
  sourceIds: string[];
  timeline: Array<Record<string, unknown>>;
} {
  const resolvedEntityId = (() => {
    if (entityId) return entityId;
    const matches = findEntityMatches(db, query, { limit: 1 });
    return matches[0]?.entity_id ? String(matches[0].entity_id) : "";
  })();

  const episodes = (() => {
    if (resolvedEntityId) {
      const detail = getEntityDetail(db, resolvedEntityId);
      return Array.isArray(detail?.episodes) ? detail.episodes as Array<Record<string, unknown>> : [];
    }
    try {
      return db
        .prepare(
          `SELECT episode_id, title, summary, start_date, end_date, status, primary_entity_id
           FROM memory_episodes
           ORDER BY COALESCE(start_date, end_date, '') ASC, title ASC
           LIMIT 50`,
        )
        .all() as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  })().filter((episode) => {
    const date = String(episode.start_date || episode.end_date || "").trim();
    if (afterDate && date && date < afterDate) return false;
    if (beforeDate && date && date > beforeDate) return false;
    return true;
  });

  const timeline = episodes
    .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")))
    .slice(0, 12);
  const result = timeline.length > 0
    ? timeline
        .map((episode) => `- ${String(episode.start_date || "undated")}: ${String(episode.summary || episode.title || "")}`)
        .join("\n")
    : "No timeline evidence found for this query.";

  return {
    result,
    confidence: timeline.length > 0 ? 0.78 : 0.25,
    sourceIds: timeline.map((episode) => String(episode.episode_id || "")).filter(Boolean),
    timeline,
  };
}

function buildRelationship(
  db: DatabaseSync,
  query: string,
): {
  result: string;
  confidence: number;
  sourceIds: string[];
  entities: Array<Record<string, unknown>>;
} {
  const matches = findEntityMatches(db, query, { limit: 2 });
  const entities = matches
    .map((match) => getEntityDetail(db, String(match.entity_id || "")))
    .filter((entity): entity is Record<string, unknown> => Boolean(entity));
  if (entities.length < 2) {
    return {
      result: "Not enough entity evidence found to describe a relationship.",
      confidence: 0.2,
      sourceIds: entities.map((entity) => String(entity.entity_id || "")).filter(Boolean),
      entities,
    };
  }

  const [left, right] = entities;
  const relationshipBeliefs = (Array.isArray(left.beliefs) ? left.beliefs : [])
    .concat(Array.isArray(right.beliefs) ? right.beliefs : [])
    .filter((belief) => String((belief as Record<string, unknown>).type || "").toLowerCase() === "relationship")
    .slice(0, 6) as Array<Record<string, unknown>>;

  const result = relationshipBeliefs.length > 0
    ? relationshipBeliefs.map((belief) => `- ${String(belief.content || "")}`).join("\n")
    : `No explicit relationship belief found between ${String(left.display_name || "entity A")} and ${String(right.display_name || "entity B")}.`;

  return {
    result,
    confidence: relationshipBeliefs.length > 0 ? 0.74 : 0.3,
    sourceIds: relationshipBeliefs.map((belief) => String(belief.belief_id || "")).filter(Boolean),
    entities,
  };
}

async function buildVerification(
  db: DatabaseSync,
  query: string,
  topK: number,
  minScore: number,
  maxTokens: number,
  scope: string | undefined,
  allScopes: boolean,
  includeArchived: boolean,
  config: LcmConfig,
): Promise<{
  result: string;
  confidence: number;
  sourceIds: string[];
  verified: boolean;
  evidence: Array<Record<string, unknown>>;
}> {
  const search = await fetchMemoryCandidates(db, {
    config,
    query,
    topK,
    minScore,
    maxTokens,
    scope,
    allScopes,
    includeArchived,
    archiveFallback: config.recallArchiveFallback,
    entityLockEnabled: config.recallEntityLockEnabled,
  });
  const verified = search.memories.length > 0 && search.memories[0].score >= Math.max(minScore, 0.6);
  return {
    result: verified
      ? `Likely verified. Top evidence: ${search.memories[0]?.content || ""}`
      : "No strong verification evidence found in durable memory.",
    confidence: search.memories[0]?.score || 0.2,
    sourceIds: search.memories.map((memory) => memory.id),
    verified,
    evidence: search.memories,
  };
}

export function createMemoryQueryTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_query",
    label: "Memory Query",
    description:
      "Strategy-aware recall over durable memory. Supports quick context, entity briefs, relationships, timelines, and verification flows while preserving legacy date-filtered query behavior.",
    parameters: MemoryQuerySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = (typeof p.query === "string" ? p.query : "").trim();
      if (!query) {
        return jsonResult({ error: "query is required." });
      }

      const afterDate = typeof p.afterDate === "string"
        ? parseDate(p.afterDate.trim())
        : typeof p.dateRange === "object" && p.dateRange && typeof (p.dateRange as Record<string, unknown>).from === "string"
          ? parseDate(String((p.dateRange as Record<string, unknown>).from).trim())
          : null;
      const beforeDate = typeof p.beforeDate === "string"
        ? parseDate(p.beforeDate.trim())
        : typeof p.dateRange === "object" && p.dateRange && typeof (p.dateRange as Record<string, unknown>).to === "string"
          ? parseDate(String((p.dateRange as Record<string, unknown>).to).trim())
          : null;

      if (p.afterDate && !afterDate) {
        return jsonResult({ error: `Invalid afterDate: "${p.afterDate}". Use YYYY-MM-DD format.` });
      }
      if (p.beforeDate && !beforeDate) {
        return jsonResult({ error: `Invalid beforeDate: "${p.beforeDate}". Use YYYY-MM-DD format.` });
      }

      const strategy = (() => {
        const raw = typeof p.strategy === "string" ? p.strategy.trim() : "";
        if (raw) return raw;
        return pickStrategy(query, input.config.recallDefaultStrategy);
      })();
      const topKRaw =
        typeof p.topK === "number"
          ? p.topK
          : typeof p.limit === "number"
            ? p.limit
            : input.config.recallTopK;
      const topK = Math.max(
        1,
        Math.min(50, Math.trunc(topKRaw || input.config.recallTopK || DEFAULT_RECALL_TOP_K)),
      );
      const minScore =
        typeof p.minScore === "number"
          ? p.minScore
          : typeof input.config.recallMinScore === "number"
            ? input.config.recallMinScore
            : DEFAULT_RECALL_MIN_SCORE;
      const maxTokens =
        typeof p.maxTokens === "number"
          ? Math.max(1, Math.trunc(p.maxTokens))
          : typeof input.config.recallMaxTokens === "number"
            ? input.config.recallMaxTokens
            : DEFAULT_RECALL_MAX_TOKENS;
      const scope = typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : undefined;
      const allScopes = Boolean(p.allScopes);
      const includeArchived = Boolean(p.includeArchived);
      const entityId = typeof p.entityId === "string" && p.entityId.trim() ? p.entityId.trim() : undefined;

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
        ensureWorldModelReady({ db, config: input.config });
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (strategy === "entity_brief") {
        const result = buildEntityBrief(db, query, entityId);
        reinforceReturnedMemories({
          db,
          config: input.config,
          memoryIds: result.sourceIds,
          query,
          strategy,
        });
        return jsonResult({
          strategy,
          query,
          ...result,
        });
      }

      if (strategy === "relationship") {
        const result = buildRelationship(db, query);
        reinforceReturnedMemories({
          db,
          config: input.config,
          memoryIds: result.sourceIds,
          query,
          strategy,
        });
        return jsonResult({
          strategy,
          query,
          ...result,
        });
      }

      if (strategy === "timeline") {
        const result = buildTimeline(db, query, afterDate, beforeDate, entityId);
        return jsonResult({
          strategy,
          query,
          afterDate,
          beforeDate,
          ...result,
        });
      }

      if (strategy === "verification") {
        const result = await buildVerification(
          db,
          query,
          topK,
          minScore,
          maxTokens,
          scope,
          allScopes,
          includeArchived,
          input.config,
        );
        reinforceReturnedMemories({
          db,
          config: input.config,
          memoryIds: result.sourceIds,
          query,
          strategy,
        });
        return jsonResult({
          strategy,
          query,
          afterDate,
          beforeDate,
          ...result,
        });
      }

      let search: Awaited<ReturnType<typeof fetchMemoryCandidates>>;
      try {
        search = await fetchMemoryCandidates(db, {
          config: input.config,
          query,
          topK,
          minScore,
          maxTokens,
          scope,
          allScopes,
          includeArchived,
          archiveFallback: input.config.recallArchiveFallback,
          entityLockEnabled: input.config.recallEntityLockEnabled,
          entityId,
          afterDate,
          beforeDate,
        });
      } catch (err) {
        console.error("[memory_query] recall failed:", err);
        return jsonResult({
          error: "Memory query recall failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      const resultText =
        search.memories.length > 0
          ? search.memories.map((memory) => `- [${memory.type}] ${memory.content}`).join("\n")
          : "No durable memory evidence found.";
      const resolvedStrategy = strategy === "auto" ? "quick_context" : strategy;

      reinforceReturnedMemories({
        db,
        config: input.config,
        memoryIds: search.memories.map((memory) => memory.id),
        query,
        strategy: resolvedStrategy,
      });

      return jsonResult({
        strategy: resolvedStrategy,
        query,
        afterDate,
        beforeDate,
        count: search.memories.length,
        confidence: search.memories[0]?.score || 0.2,
        sourceIds: search.memories.map((memory) => memory.id),
        result: resultText,
        totalTokens: search.totalTokens,
        usedArchiveFallback: search.usedArchiveFallback,
        usedVectorSearch: search.usedVectorSearch,
        vectorBackfilled: search.vectorBackfilled,
        vectorBackend: input.config.vectorBackend,
        entityLockTerms: search.entityLockTerms,
        memories: search.memories.map((memory) => ({
          id: memory.id,
          kind: memory.type,
          content: memory.content,
          scope: memory.scope,
          score: Number(memory.score.toFixed(4)),
          vector_similarity: Number(memory.vectorSimilarity.toFixed(4)),
          confidence: memory.confidence,
          effective_confidence: memory.effectiveConfidence,
          stored_by: memory.sourceAgent,
          content_time: memory.contentTime,
          tags: memory.tags,
          created_at: memory.createdAt,
        })),
      });
    },
  };
}
