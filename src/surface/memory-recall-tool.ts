import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * memory_recall — fetch top-k memories ranked by confidence + recency.
 *
 * Unlike memory_search (keyword-driven), recall returns the highest-quality
 * stored memories for the current context, optionally filtered by scope and kind.
 * This is the "inject context at session start" tool: call it early in a session
 * to load relevant background about the user or project.
 */
const MemoryRecallSchema = Type.Object({
  topK: Type.Optional(
    Type.Number({
      description: "Number of memories to return (default: 8, max: 30).",
      minimum: 1,
      maximum: 30,
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        'Scope to recall from. Defaults to "shared". Pass a project name to recall project-scoped memories.',
    }),
  ),
  kinds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Limit recall to specific memory kinds: USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT.",
    }),
  ),
  minConfidence: Type.Optional(
    Type.Number({
      description: "Minimum confidence threshold (default: 0.45, range: 0.0–1.0).",
      minimum: 0,
      maximum: 1,
    }),
  ),
  allScopes: Type.Optional(
    Type.Boolean({
      description: "Recall across all scopes.",
    }),
  ),
});

export function createMemoryRecallTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Retrieve the most relevant long-term memories ranked by confidence and recency. " +
      "Use this at the start of a session to load user context, preferences, and key decisions. " +
      "Returns high-confidence memories first. " +
      "For keyword-specific lookup, prefer memory_search. " +
      "For temporal/date-filtered queries, prefer memory_query.",
    parameters: MemoryRecallSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const topK = typeof p.topK === "number" ? Math.min(Math.trunc(p.topK), 30) : 8;
      const minConfidence = typeof p.minConfidence === "number" ? p.minConfidence : 0.45;
      const scope =
        !p.allScopes && typeof p.scope === "string" && p.scope.trim() ? p.scope.trim() : null;

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      ensureMemoryTables(db);

      const baseWhere: string[] = ["status = 'active'", "confidence >= ?"];
      const baseParams: (string | number | null)[] = [minConfidence];

      if (scope) {
        baseWhere.push("scope = ?");
        baseParams.push(scope);
      }

      const kinds = Array.isArray(p.kinds)
        ? (p.kinds as unknown[]).filter((k): k is string => typeof k === "string").map((k) => k.toUpperCase())
        : [];
      if (kinds.length > 0) {
        baseWhere.push(`type IN (${kinds.map(() => "?").join(",")})`);
        baseParams.push(...kinds);
      }

      // Per-type budget allocation: guarantee type diversity in recall results.
      // High-signal types get reserved slots, then remaining slots fill by confidence.
      const TYPE_PRIORITY: Array<{ type: string; reservedSlots: number }> = [
        { type: "PREFERENCE", reservedSlots: 2 },
        { type: "DECISION", reservedSlots: 2 },
        { type: "AGENT_IDENTITY", reservedSlots: 1 },
      ];
      const MAX_PER_TYPE = Math.max(3, Math.ceil(topK * 0.4));

      let rows: Array<Record<string, unknown>>;
      try {
        const collected: Array<Record<string, unknown>> = [];
        const seenIds = new Set<string>();

        // Phase 1: fill reserved slots from high-signal types
        for (const { type, reservedSlots } of TYPE_PRIORITY) {
          if (kinds.length > 0 && !kinds.includes(type)) continue;
          const typeWhere = [...baseWhere, "type = ?"];
          const typeParams = [...baseParams, type, reservedSlots];
          const typeSql = `
            SELECT memory_id, type, content, scope, confidence, value_score, tags, created_at
            FROM memory_current
            WHERE ${typeWhere.join(" AND ")}
            ORDER BY confidence DESC, created_at DESC
            LIMIT ?
          `;
          const typeRows = db.prepare(typeSql).all(...typeParams) as Array<Record<string, unknown>>;
          for (const r of typeRows) {
            const id = String(r.memory_id);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              collected.push(r);
            }
          }
        }

        // Phase 2: fill remaining slots with best-by-confidence across all types
        const remaining = topK - collected.length;
        if (remaining > 0) {
          const fillSql = `
            SELECT memory_id, type, content, scope, confidence, value_score, tags, created_at
            FROM memory_current
            WHERE ${baseWhere.join(" AND ")}
            ORDER BY confidence DESC, created_at DESC
            LIMIT ?
          `;
          const fillParams = [...baseParams, topK * 3]; // over-fetch to skip already-collected
          const fillRows = db.prepare(fillSql).all(...fillParams) as Array<Record<string, unknown>>;

          // Track per-type counts (including phase 1) to enforce MAX_PER_TYPE
          const typeCounts: Record<string, number> = {};
          for (const r of collected) {
            const t = String(r.type);
            typeCounts[t] = (typeCounts[t] ?? 0) + 1;
          }

          for (const r of fillRows) {
            if (collected.length >= topK) break;
            const id = String(r.memory_id);
            if (seenIds.has(id)) continue;
            const t = String(r.type);
            if ((typeCounts[t] ?? 0) >= MAX_PER_TYPE) continue;
            seenIds.add(id);
            typeCounts[t] = (typeCounts[t] ?? 0) + 1;
            collected.push(r);
          }
        }

        rows = collected;
      } catch (err) {
        console.error("[memory_recall] query failed:", err);
        return jsonResult({
          error: "Memory recall query failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      const grouped: Record<string, Array<{ id: string; content: string; confidence: number }>> =
        {};
      for (const r of rows) {
        const kind = String(r.type);
        if (!grouped[kind]) grouped[kind] = [];
        grouped[kind].push({
          id: String(r.memory_id),
          content: String(r.content),
          confidence: Number(r.confidence),
        });
      }

      return jsonResult({
        recalled: rows.length,
        scope: scope ?? "all",
        minConfidence,
        grouped,
      });
    },
  };
}
