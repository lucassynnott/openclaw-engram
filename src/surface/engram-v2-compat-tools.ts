import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import {
  ensureWorldModelReady,
  findEntityMatches,
  getEntityDetail,
  listEntityMergeSuggestions,
  mergeEntities,
} from "../entity/world-model.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { createAlignmentCheckTool, createAlignmentStatusTool } from "./alignment-tools.js";
import { inspectVaultHealth } from "./vault-mirror.js";
import { getVectorRuntime } from "../memory/vector-runtime.js";

const MemoryGetSchema = Type.Object({
  id: Type.String({
    description:
      "Identifier to fetch. Supports memory IDs, episode IDs, entity IDs, LCM summary IDs, and LCM file IDs.",
  }),
  kind: Type.Optional(
    Type.String({
      description:
        "Optional explicit kind. Use auto to let Engram infer the source from the ID and available tables.",
      enum: ["auto", "memory", "episode", "entity", "summary", "file"],
    }),
  ),
});

const EntityGetSchema = Type.Object({
  entityId: Type.Optional(
    Type.String({
      description: "Exact entity UUID to fetch.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Fuzzy entity name to resolve against the local world model.",
    }),
  ),
  includeSyntheses: Type.Optional(
    Type.Boolean({
      description: "Include entity syntheses from the world model. Defaults to true.",
    }),
  ),
  includeMemories: Type.Optional(
    Type.Boolean({
      description: "Include related raw memory snippets. Defaults to true for basic fallback entities.",
    }),
  ),
});

const EntityMergeSchema = Type.Object({
  winnerEntityId: Type.Optional(
    Type.String({
      description: "Canonical entity ID to keep.",
    }),
  ),
  loserEntityId: Type.Optional(
    Type.String({
      description: "Duplicate entity ID to merge into the winner.",
    }),
  ),
  winnerName: Type.Optional(
    Type.String({
      description: "Fuzzy entity name to resolve as the canonical winner when IDs are not provided.",
    }),
  ),
  loserName: Type.Optional(
    Type.String({
      description: "Fuzzy entity name to resolve as the duplicate loser when IDs are not provided.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Optional human-readable merge reason.",
    }),
  ),
});

const OpsStatusSchema = Type.Object({});

const GradientScoreSchema = Type.Object({
  text: Type.Optional(
    Type.String({
      description: "Text to evaluate. Alias of response.",
    }),
  ),
  response: Type.Optional(
    Type.String({
      description: "Response text to evaluate against the local alignment profile.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: "Optional extra evaluation context.",
    }),
  ),
});

const VaultQuerySchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Free-text query to search for in the vault mirror or imported StingerVault entries.",
    }),
  ),
  category: Type.Optional(
    Type.String({
      description:
        "Optional category filter. Supports StingerVault categories or loose path/category matching in the mirror.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return. Defaults to 10, max 50.",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

type VaultMirrorSearchResult = {
  path: string;
  category: string;
  snippet: string;
  score: number;
};

function parseJsonSafe<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function detectLegacyOverlap(): {
  memorySlot: string | null;
  contextSlot: string | null;
  warnings: string[];
} {
  const openclawConfigPath = path.join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(openclawConfigPath)) {
    return {
      memorySlot: null,
      contextSlot: null,
      warnings: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(openclawConfigPath, "utf8")) as Record<string, unknown>;
    const slots =
      parsed.plugins && typeof parsed.plugins === "object"
        ? ((parsed.plugins as Record<string, unknown>).slots as Record<string, unknown> | undefined)
        : undefined;
    const memorySlot = typeof slots?.memory === "string" ? slots.memory : null;
    const contextSlot = typeof slots?.contextEngine === "string" ? slots.contextEngine : null;
    const warnings: string[] = [];
    if (memorySlot && memorySlot !== "engram") {
      warnings.push(`memory slot points to ${memorySlot}`);
    }
    if (contextSlot && contextSlot !== "engram") {
      warnings.push(`context engine slot points to ${contextSlot}`);
    }
    return {
      memorySlot,
      contextSlot,
      warnings,
    };
  } catch (error) {
    return {
      memorySlot: null,
      contextSlot: null,
      warnings: [
        `could not parse ~/.openclaw/openclaw.json: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as Record<string, unknown> | undefined;
  return typeof row?.name === "string" && row.name === tableName;
}

function scalarCount(db: DatabaseSync, tableName: string, whereClause = ""): number {
  if (!hasTable(db, tableName)) {
    return 0;
  }
  const sql = `SELECT COUNT(*) AS c FROM ${tableName}${whereClause ? ` WHERE ${whereClause}` : ""}`;
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(row?.c || 0);
}

function ensureCompatMemoryTables(db: DatabaseSync): void {
  ensureMemoryTables(db);
}

function openMemoryDb(config: LcmConfig): DatabaseSync {
  const db = getLcmConnection(config.databasePath);
  ensureCompatMemoryTables(db);
  try {
    ensureWorldModelReady({ db, config });
  } catch {
    // World-model refresh is best-effort for compat surfaces.
  }
  return db;
}

function resolveEntityIdByName(
  db: DatabaseSync,
  name: string,
  role: "winner" | "loser",
): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error(`${role}Name is required when ${role}EntityId is not provided.`);
  }
  const matches = findEntityMatches(db, trimmed, { limit: 2 });
  if (matches.length === 0) {
    throw new Error(`No ${role} entity match found for: ${trimmed}`);
  }
  return String(matches[0]?.entity_id || "").trim();
}

function relatedMemoriesByEntityName(
  db: DatabaseSync,
  displayName: string,
  limit = 12,
): Array<Record<string, unknown>> {
  if (!displayName || !hasTable(db, "memory_current")) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT memory_id, type, content, confidence, scope, created_at, updated_at, tags
       FROM memory_current
       WHERE status = 'active' AND (tags LIKE ? OR content LIKE ?)
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(`%${displayName}%`, `%${displayName}%`, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.memory_id,
    kind: row.type,
    content: row.content,
    confidence: row.confidence,
    scope: row.scope,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: parseJsonSafe<string[]>(row.tags, []),
  }));
}

function summarizeText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function detectMemoryGetKinds(id: string, requestedKind: string | undefined): string[] {
  const normalizedKind = String(requestedKind || "auto").trim().toLowerCase();
  if (normalizedKind && normalizedKind !== "auto") {
    return [normalizedKind];
  }
  if (id.startsWith("mem_")) return ["memory"];
  if (id.startsWith("ep_")) return ["episode"];
  if (id.startsWith("sum_")) return ["summary"];
  if (id.startsWith("file_")) return ["file"];
  return ["memory", "episode", "entity", "summary", "file"];
}

function loadMemoryById(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT memory_id, type, content, confidence, scope, status, source, source_agent, source_session,
              value_score, value_label, created_at, updated_at, archived_at, last_reviewed_at, tags,
              content_time, valid_until, superseded_by
       FROM memory_current WHERE memory_id = ? LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    itemType: "memory",
    memory: {
      id: row.memory_id,
      kind: row.type,
      content: row.content,
      confidence: row.confidence,
      scope: row.scope,
      status: row.status,
      source: row.source,
      source_agent: row.source_agent,
      stored_by: row.source_agent,
      source_session: row.source_session,
      value_score: row.value_score,
      value_label: row.value_label,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
      last_reviewed_at: row.last_reviewed_at,
      content_time: row.content_time,
      valid_until: row.valid_until,
      superseded_by: row.superseded_by,
      tags: parseJsonSafe<string[]>(row.tags, []),
    },
  };
}

function loadEpisodeById(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT episode_id, title, summary, start_date, end_date, status, primary_entity_id,
              source_memory_ids, payload
       FROM memory_episodes WHERE episode_id = ? LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    itemType: "episode",
    episode: {
      id: row.episode_id,
      title: row.title,
      summary: row.summary,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
      primary_entity_id: row.primary_entity_id,
      source_memory_ids: parseJsonSafe<string[]>(row.source_memory_ids, []),
      payload: parseJsonSafe<Record<string, unknown>>(row.payload, {}),
    },
  };
}

function loadEntityById(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const detail = getEntityDetail(db, id);
  if (detail) {
    return {
      itemType: "entity",
      entity: {
        id: detail.entity_id,
        kind: detail.kind,
        name: detail.display_name,
        normalized_name: detail.normalized_name,
        status: detail.status,
        confidence: detail.confidence,
        aliases: detail.aliases,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
        payload: detail.payload,
      },
      beliefs: detail.beliefs,
      episodes: detail.episodes,
      open_loops: detail.open_loops,
      syntheses: detail.syntheses,
      links: detail.links,
    };
  }

  const row = db
    .prepare(
      `SELECT entity_id, kind, display_name, normalized_name, status, confidence, created_at, updated_at
       FROM memory_entities WHERE entity_id = ? LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    itemType: "entity",
    entity: {
      id: row.entity_id,
      kind: row.kind,
      name: row.display_name,
      normalized_name: row.normalized_name,
      status: row.status,
      confidence: row.confidence,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    memories: relatedMemoriesByEntityName(db, String(row.display_name || "")),
  };
}

function loadSummaryById(db: DatabaseSync, id: string): Record<string, unknown> | null {
  if (!hasTable(db, "summaries")) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, descendant_token_count,
              source_message_token_count, created_at
       FROM summaries WHERE summary_id = ? LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    itemType: "summary",
    summary: {
      id: row.summary_id,
      conversation_id: row.conversation_id,
      kind: row.kind,
      depth: row.depth,
      content: row.content,
      token_count: row.token_count,
      earliest_at: row.earliest_at,
      latest_at: row.latest_at,
      descendant_count: row.descendant_count,
      descendant_token_count: row.descendant_token_count,
      source_message_token_count: row.source_message_token_count,
      created_at: row.created_at,
      file_ids: parseJsonSafe<string[]>(row.file_ids, []),
    },
  };
}

function loadFileById(db: DatabaseSync, id: string): Record<string, unknown> | null {
  if (!hasTable(db, "large_files")) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri,
              exploration_summary, created_at
       FROM large_files WHERE file_id = ? LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    itemType: "file",
    file: {
      id: row.file_id,
      conversation_id: row.conversation_id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      byte_size: row.byte_size,
      storage_uri: row.storage_uri,
      exploration_summary: row.exploration_summary,
      created_at: row.created_at,
    },
  };
}

function firstCategoryFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const first = normalized.split("/").find(Boolean) || "root";
  return first;
}

function snippetAroundQuery(content: string, query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  const squashed = content.replace(/\s+/g, " ").trim();
  if (!normalizedQuery) {
    return summarizeText(squashed, 220);
  }
  const lower = squashed.toLowerCase();
  const index = lower.indexOf(normalizedQuery);
  if (index === -1) {
    return summarizeText(squashed, 220);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(squashed.length, index + normalizedQuery.length + 140);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < squashed.length ? "..." : "";
  return `${prefix}${squashed.slice(start, end)}${suffix}`;
}

function walkMirrorFiles(root: string, maxFiles = 2000): string[] {
  const results: string[] = [];
  if (!existsSync(root)) {
    return results;
  }
  const stack = [root];
  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`[walkMirrorFiles] readdirSync failed for ${current}:`, err);
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!/\.(md|json|txt)$/i.test(entry.name)) {
        continue;
      }
      results.push(fullPath);
      if (results.length >= maxFiles) {
        break;
      }
    }
  }
  return results;
}

function searchVaultMirror(params: {
  mirrorRoot: string;
  query?: string;
  category?: string;
  limit: number;
}): VaultMirrorSearchResult[] {
  const normalizedQuery = String(params.query || "").trim().toLowerCase();
  const normalizedCategory = String(params.category || "").trim().toLowerCase();
  const files = walkMirrorFiles(params.mirrorRoot);
  const scored: VaultMirrorSearchResult[] = [];

  for (const filePath of files) {
    const relativePath = path.relative(params.mirrorRoot, filePath).replace(/\\/g, "/");
    const category = firstCategoryFromRelativePath(relativePath);
    const categoryLower = category.toLowerCase();
    if (normalizedCategory && !relativePath.toLowerCase().includes(normalizedCategory)) {
      continue;
    }

    let stats: import("node:fs").Stats;
    try {
      stats = statSync(filePath);
    } catch {
      continue;
    }
    if (stats.size > 1_000_000) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const haystack = `${relativePath}\n${content}`.toLowerCase();
    if (normalizedQuery && !haystack.includes(normalizedQuery)) {
      continue;
    }

    let score = 0;
    if (normalizedCategory && categoryLower.includes(normalizedCategory)) score += 3;
    if (normalizedQuery) {
      const pathMatches = relativePath.toLowerCase().includes(normalizedQuery);
      const contentMatches = haystack.includes(normalizedQuery);
      if (pathMatches) score += 3;
      if (contentMatches) score += 2;
    } else {
      score += 1;
    }

    scored.push({
      path: relativePath,
      category,
      snippet: normalizedQuery ? snippetAroundQuery(content, normalizedQuery) : summarizeText(content, 220),
      score,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, params.limit);
}

export function createMemoryGetTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_get",
    label: "Memory Get",
    description:
      "Fetch a durable memory item by ID. Supports raw memories, episodes, entities, LCM summaries, and LCM files.",
    parameters: MemoryGetSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const id = String(p.id || "").trim();
      const requestedKind = typeof p.kind === "string" ? p.kind : undefined;
      if (!id) {
        return jsonResult({ error: "id is required." });
      }

      let db: DatabaseSync;
      try {
        db = openMemoryDb(input.config);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      for (const kind of detectMemoryGetKinds(id, requestedKind)) {
        const result =
          kind === "memory"
            ? loadMemoryById(db, id)
            : kind === "episode"
              ? loadEpisodeById(db, id)
              : kind === "entity"
                ? loadEntityById(db, id)
                : kind === "summary"
                  ? loadSummaryById(db, id)
                  : kind === "file"
                    ? loadFileById(db, id)
                    : null;
        if (result) {
          return jsonResult(result);
        }
      }

      return jsonResult({
        error: `No Engram record found for id: ${id}`,
        requestedKind: requestedKind ?? "auto",
        searchedKinds: detectMemoryGetKinds(id, requestedKind),
      });
    },
  };
}

export function createEntityGetTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "entity_get",
    label: "Entity Get",
    description:
      "Fetch a rich entity profile with beliefs, episodes, relationships, and syntheses from the local Engram world model.",
    parameters: EntityGetSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const entityId = String(p.entityId || "").trim();
      const name = String(p.name || "").trim();
      const includeSyntheses = p.includeSyntheses !== false;
      const includeMemories = p.includeMemories !== false;

      if (!entityId && !name) {
        return jsonResult({ error: "Provide entityId or name." });
      }

      let db: DatabaseSync;
      try {
        db = openMemoryDb(input.config);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (entityId) {
        const direct = loadEntityById(db, entityId);
        if (!direct) {
          return jsonResult({ error: `Entity not found: ${entityId}` });
        }
        if (!includeSyntheses && direct.itemType === "entity") {
          delete direct.syntheses;
        }
        return jsonResult(direct);
      }

      const worldMatches = findEntityMatches(db, name, { limit: 5 });
      if (worldMatches.length > 0) {
        const top = worldMatches[0];
        const detail = loadEntityById(db, String(top.entity_id || ""));
        if (detail) {
          if (!includeSyntheses && detail.itemType === "entity") {
            delete detail.syntheses;
          }
          return jsonResult({
            ...detail,
            matched_by: "world_model",
            matches: worldMatches,
          });
        }
      }

      const fallback = db
        .prepare(
          `SELECT entity_id, kind, display_name, normalized_name, status, confidence, created_at, updated_at
           FROM memory_entities
           WHERE normalized_name LIKE ? OR display_name LIKE ?
           ORDER BY confidence DESC, updated_at DESC
           LIMIT 5`,
        )
        .all(`%${name.toLowerCase()}%`, `%${name}%`) as Array<Record<string, unknown>>;

      if (fallback.length === 0) {
        return jsonResult({ error: `No entity match found for: ${name}` });
      }

      const top = fallback[0];
      const relatedMemories = includeMemories
        ? relatedMemoriesByEntityName(db, String(top.display_name || ""))
        : [];
      return jsonResult({
        itemType: "entity",
        matched_by: "memory_entities",
        matches: fallback.map((row) => ({
          entity_id: row.entity_id,
          kind: row.kind,
          display_name: row.display_name,
          confidence: row.confidence,
        })),
        entity: {
          id: top.entity_id,
          kind: top.kind,
          name: top.display_name,
          normalized_name: top.normalized_name,
          status: top.status,
          confidence: top.confidence,
          created_at: top.created_at,
          updated_at: top.updated_at,
        },
        memories: relatedMemories,
      });
    },
  };
}

export function createEntityMergeTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "entity_merge",
    label: "Entity Merge",
    description:
      "Merge a duplicate entity into a canonical entity. The merge persists as a durable override and survives world-model rebuilds.",
    parameters: EntityMergeSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      let db: DatabaseSync;
      try {
        db = openMemoryDb(input.config);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const winnerEntityId = String(p.winnerEntityId || "").trim()
          || resolveEntityIdByName(db, String(p.winnerName || ""), "winner");
        const loserEntityId = String(p.loserEntityId || "").trim()
          || resolveEntityIdByName(db, String(p.loserName || ""), "loser");
        if (!winnerEntityId || !loserEntityId) {
          return jsonResult({
            error: "Provide winnerEntityId/loserEntityId or winnerName/loserName.",
          });
        }

        const merged = mergeEntities({
          db,
          winnerEntityId,
          loserEntityId,
          reason: String(p.reason || "").trim(),
          config: input.config,
        });
        const entity = getEntityDetail(db, String(merged.winnerEntityId || ""));
        return jsonResult({
          ...merged,
          entity,
        });
      } catch (err) {
        return jsonResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

export function createOpsStatusTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "ops_status",
    label: "Ops Status",
    description:
      "Return a single-call Engram health dashboard spanning memory, LCM, world-model, vault, and alignment status.",
    parameters: OpsStatusSchema,
    async execute(_toolCallId, _params) {
      let db: DatabaseSync;
      try {
        db = openMemoryDb(input.config);
      } catch (err) {
        return jsonResult({
          status: "unavailable",
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      const alignmentStatus = await createAlignmentStatusTool({ config: input.config }).execute(
        "ops_status:alignment",
        {},
      );
      const vault = (() => {
        try {
          return inspectVaultHealth({ db, config: input.config });
        } catch (err) {
          return {
            enabled: input.config.vaultEnabled,
            vault_root: input.config.vaultPath,
            subdir: input.config.vaultSubdir,
            mirror_root: "",
            session: { last_session_at: null, stale: true },
            vault: {
              last_built_at: null,
              stale: true,
              run_id: null,
              items_synced: 0,
              skipped_unchanged: 0,
              removed_files: 0,
              generated_files: 0,
              failures: [
                `vault health unavailable: ${err instanceof Error ? err.message : String(err)}`,
              ],
            },
            manual_protection: {
              ok: false,
              issues: [
                `vault health unavailable: ${err instanceof Error ? err.message : String(err)}`,
              ],
            },
            summary_path: "",
          };
        }
      })();
      const issues: string[] = [];
      const warnings: string[] = [];
      const overlap = detectLegacyOverlap();
      if (vault.enabled && vault.vault.stale) {
        issues.push("vault mirror is stale");
      }
      if (!vault.enabled) {
        warnings.push("vault mirror is disabled");
      }
      const alignmentState = (alignmentStatus.details as Record<string, unknown>)?.status;
      if (
        input.config.gradientEnabled &&
        typeof (alignmentStatus.details as Record<string, unknown>)?.status === "string" &&
        String(alignmentState) !== "active"
      ) {
        issues.push("gradient alignment engine is not active");
      } else if (!input.config.gradientEnabled) {
        warnings.push("gradient alignment engine is disabled");
      }
      warnings.push(...overlap.warnings);
      const vectorRuntime = getVectorRuntime(input.config.databasePath);
      const vectorRuntimeStats =
        typeof vectorRuntime?.getStats === "function"
          ? await vectorRuntime.getStats().catch((error) => ({
              error: error instanceof Error ? error.message : String(error),
            }))
          : undefined;
      const entityMergeSuggestions = (() => {
        try {
          return listEntityMergeSuggestions(db, { limit: 5 });
        } catch {
          return [];
        }
      })();

      return jsonResult({
        status: issues.length === 0 ? "healthy" : "degraded",
        database_path: input.config.databasePath,
        rollout: {
          ready: issues.length === 0,
          warnings,
          plugin_slots: {
            memory: overlap.memorySlot,
            context_engine: overlap.contextSlot,
          },
          optional_features: {
            vault_enabled: input.config.vaultEnabled,
            falkordb_enabled: input.config.falkorDbEnabled,
            gradient_enabled: input.config.gradientEnabled,
            native_enabled: input.config.nativeEnabled,
          },
        },
        memory: {
          active_memories: scalarCount(db, "memory_current", "status = 'active'"),
          superseded_memories: scalarCount(db, "memory_current", "status = 'superseded'"),
          entities: scalarCount(db, "memory_entities"),
          episodes: scalarCount(db, "memory_episodes"),
          events: scalarCount(db, "memory_events"),
          triggers: scalarCount(db, "memory_triggers", "enabled = 1"),
          vector_rows: scalarCount(db, "memory_vectors"),
          vector_backend: input.config.vectorBackend,
          vector_runtime: vectorRuntimeStats,
        },
        lcm: {
          conversations: scalarCount(db, "conversations"),
          summaries: scalarCount(db, "summaries"),
          files: scalarCount(db, "large_files"),
        },
        world_model: {
          entities: scalarCount(db, "entities"),
          beliefs: scalarCount(db, "entity_beliefs"),
          episodes: scalarCount(db, "entity_episodes"),
          open_loops: scalarCount(db, "entity_open_loops"),
          syntheses: scalarCount(db, "entity_syntheses"),
          links: scalarCount(db, "entity_links"),
          merge_overrides: scalarCount(db, "entity_merge_overrides"),
          merge_suggestions: {
            count: entityMergeSuggestions.length,
            suggestions: entityMergeSuggestions,
          },
        },
        vault,
        lastVaultSync: vault?.vault?.last_built_at || null,
        alignment: alignmentStatus.details,
        issues,
        warnings,
      });
    },
  };
}

export function createEngramStatusTool(input: { config: LcmConfig }): AnyAgentTool {
  const base = createOpsStatusTool(input);
  return {
    ...base,
    name: "engram_status",
    label: "Engram Status",
    description:
      "Alias of ops_status. Returns Engram health, vault freshness, sync counters, and rollout warnings.",
  };
}

export function createGradientScoreTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "gradient_score",
    label: "Gradient Score",
    description:
      "Compatibility surface for Engram v2 alignment scoring. Evaluates a response or text against the local alignment profile.",
    parameters: GradientScoreSchema,
    async execute(toolCallId, params) {
      const p = params as Record<string, unknown>;
      const text =
        (typeof p.response === "string" ? p.response : "") ||
        (typeof p.text === "string" ? p.text : "");
      const context = typeof p.context === "string" ? p.context : undefined;
      if (!text.trim()) {
        return jsonResult({ error: "response or text is required." });
      }

      const base = createAlignmentCheckTool({ config: input.config });
      const result = await base.execute(toolCallId, { text, context });
      const details = (result.details as Record<string, unknown>) || {};

      return jsonResult({
        ...details,
        compatibility_alias: "alignment_check",
        evaluated_text: text,
      });
    },
  };
}

export function createVaultQueryTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "vault_query",
    label: "Vault Query",
    description:
      "Query imported StingerVault entries or the local vault mirror by category and text. Read-only agent-facing surface.",
    parameters: VaultQuerySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = String(p.query || "").trim();
      const category = String(p.category || "").trim();
      const limit =
        typeof p.limit === "number" && Number.isFinite(p.limit)
          ? Math.max(1, Math.min(50, Math.trunc(p.limit)))
          : 10;

      if (!query && !category) {
        return jsonResult({ error: "Provide query or category." });
      }

      let db: DatabaseSync;
      try {
        db = openMemoryDb(input.config);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (hasTable(db, "openstinger_vault_entries")) {
        const where: string[] = [];
        const args: Array<string | number> = [];
        if (category) {
          where.push("category = ?");
          args.push(category);
        }
        if (query) {
          where.push("(key LIKE ? OR value LIKE ?)");
          args.push(`%${query}%`, `%${query}%`);
        }
        const rows = db
          .prepare(
            `SELECT entry_id, category, key, value, confidence, source_episodes, created_at, updated_at
             FROM openstinger_vault_entries
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY confidence DESC, updated_at DESC
             LIMIT ?`,
          )
          .all(...args, limit) as Array<Record<string, unknown>>;

        if (rows.length > 0) {
          return jsonResult({
            source: "openstinger_vault_entries",
            count: rows.length,
            results: rows.map((row) => ({
              entry_id: row.entry_id,
              category: row.category,
              key: row.key,
              value: row.value,
              confidence: row.confidence,
              source_episodes: parseJsonSafe<string[]>(row.source_episodes, []),
              created_at: row.created_at,
              updated_at: row.updated_at,
            })),
          });
        }
      }

      const vault = inspectVaultHealth({ db, config: input.config });
      if (!vault.mirror_root || !existsSync(vault.mirror_root)) {
        return jsonResult({
          status: "unavailable",
          error: "Vault mirror is not available.",
          vault,
        });
      }

      const results = searchVaultMirror({
        mirrorRoot: vault.mirror_root,
        query,
        category,
        limit,
      });

      return jsonResult({
        source: "vault_mirror",
        mirror_root: vault.mirror_root,
        vault,
        count: results.length,
        results,
      });
    },
  };
}
