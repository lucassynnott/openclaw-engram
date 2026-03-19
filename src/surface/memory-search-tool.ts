import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { fetchMemoryCandidates } from "./memory-recall-core.js";

const DEFAULT_RECALL_TOP_K = 8;
const DEFAULT_RECALL_MIN_SCORE = 0.45;
const DEFAULT_RECALL_MAX_TOKENS = 1200;

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

      const result = await fetchMemoryCandidates(db, {
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
          },
        })),
      });
    },
  };
}
