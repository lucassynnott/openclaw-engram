import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
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
        VALUES (hex(randomblob(16)), ?, 'memory_search', 'reinforce_search', ?, 'system', ?)
      `).run(
        now,
        memoryId,
        JSON.stringify({
          surface: "memory_search",
          query: params.query,
        }),
      );
    } catch (err) {
      console.warn("[memory_search] reinforcement failed:", err);
    }
  }
}

const MemorySearchSchema = Type.Object({
  query: Type.String({
    description: "Search query. Supports natural language and keywords.",
  }),
  topK: Type.Optional(
    Type.Number({
      description: "Maximum results to return. Defaults to recall.topK or 8.",
      minimum: 1,
      maximum: 50,
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Legacy alias for topK.",
      minimum: 1,
      maximum: 50,
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      description: "Minimum recall score required for a result. Defaults to recall.minScore or 0.45.",
      minimum: 0,
      maximum: 1,
    }),
  ),
  maxTokens: Type.Optional(
    Type.Number({
      description: "Maximum combined token budget for returned memories.",
      minimum: 1,
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description: 'Scope filter. Defaults to "shared".',
    }),
  ),
  type: Type.Optional(
    Type.String({
      description: "Filter by memory type.",
      enum: [
        "USER_FACT",
        "PREFERENCE",
        "DECISION",
        "ENTITY",
        "EPISODE",
        "AGENT_IDENTITY",
        "CONTEXT",
      ],
    }),
  ),
  kind: Type.Optional(
    Type.String({
      description: "Legacy alias for type.",
      enum: [
        "USER_FACT",
        "PREFERENCE",
        "DECISION",
        "ENTITY",
        "EPISODE",
        "AGENT_IDENTITY",
        "CONTEXT",
      ],
    }),
  ),
  entityId: Type.Optional(
    Type.String({
      description: "Optional entity lock. Pins or boosts recall around a specific entity.",
    }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description: "Search archived memories in addition to active ones.",
    }),
  ),
  allScopes: Type.Optional(
    Type.Boolean({
      description: "Search across all scopes instead of the scope param.",
    }),
  ),
});

export function createMemorySearchTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search durable memory with scored recall, token budgeting, archive fallback, and entity-lock boosts. " +
      "This is the primary durable-memory lookup tool for people, projects, decisions, and preferences.",
    parameters: MemorySearchSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = (typeof p.query === "string" ? p.query : "").trim();
      if (!query) {
        return jsonResult({ error: "query is required." });
      }

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
      const kind =
        typeof p.type === "string" && p.type.trim()
          ? p.type.trim().toUpperCase()
          : typeof p.kind === "string" && p.kind.trim()
            ? p.kind.trim().toUpperCase()
            : undefined;

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      let result: Awaited<ReturnType<typeof fetchMemoryCandidates>>;
      try {
        result = await fetchMemoryCandidates(db, {
          config: input.config,
          query,
          topK,
          minScore,
          maxTokens,
          scope: typeof p.scope === "string" ? p.scope.trim() : undefined,
          allScopes: Boolean(p.allScopes),
          kind,
          includeArchived: Boolean(p.includeArchived),
          archiveFallback: input.config.recallArchiveFallback,
          entityLockEnabled: input.config.recallEntityLockEnabled,
          entityId: typeof p.entityId === "string" ? p.entityId.trim() : undefined,
        });
      } catch (err) {
        console.error("[memory_search] recall failed:", err);
        return jsonResult({
          error: "Memory recall failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      reinforceReturnedMemories({
        db,
        config: input.config,
        memoryIds: result.memories.map((memory) => memory.id),
        query,
      });

      return jsonResult({
        query,
        count: result.memories.length,
        topK,
        minScore,
        maxTokens,
        totalTokens: result.totalTokens,
        usedArchiveFallback: result.usedArchiveFallback,
        usedVectorSearch: result.usedVectorSearch,
        vectorBackfilled: result.vectorBackfilled,
        vectorBackend: input.config.vectorBackend,
        entityLockTerms: result.entityLockTerms,
        memories: result.memories.map((memory) => ({
          memoryId: memory.id,
          content: memory.content,
          type: memory.type,
          kind: memory.type,
          scope: memory.scope,
          score: Number(memory.score.toFixed(4)),
          confidence: memory.confidence,
          effectiveConfidence: memory.effectiveConfidence,
          valueScore: memory.valueScore,
          vectorSimilarity: Number(memory.vectorSimilarity.toFixed(4)),
          entityLockMatched: memory.entityLockMatched,
          storedBy: memory.sourceAgent,
          status: memory.status,
          archivedAt: memory.archivedAt,
          tags: memory.tags,
          contentTime: memory.contentTime,
          createdAt: memory.createdAt,
          scoreBreakdown: {
            confidence: Number(memory.scoreBreakdown.confidence.toFixed(4)),
            value: Number(memory.scoreBreakdown.value.toFixed(4)),
            lexical: Number(memory.scoreBreakdown.lexical.toFixed(4)),
            vector: Number(memory.scoreBreakdown.vector.toFixed(4)),
            temporal: Number(memory.scoreBreakdown.temporal.toFixed(4)),
            entity: Number(memory.scoreBreakdown.entity.toFixed(4)),
            typeMultiplier: Number(memory.scoreBreakdown.typeMultiplier.toFixed(4)),
          },
        })),
      });
    },
  };
}
