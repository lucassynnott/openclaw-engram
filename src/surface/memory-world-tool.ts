import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * memory_world — surface the entity world model.
 *
 * Returns known entities (people, projects, organizations) with their
 * associated memories. This is the "who do I know?" and "what projects
 * are active?" tool. Backed by memory_entities + memory_current tables.
 */
const MemoryWorldSchema = Type.Object({
  entityKind: Type.Optional(
    Type.String({
      description:
        "Filter by entity kind: person, project, organization, place, topic, other. " +
        "Returns all kinds if omitted.",
      enum: ["person", "project", "organization", "place", "topic", "other"],
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum entities to return (default: 20, max: 100).",
      minimum: 1,
      maximum: 100,
    }),
  ),
  includeMemories: Type.Optional(
    Type.Boolean({
      description:
        "Include associated memory snippets for each entity (default: false). " +
        "Set to true for richer context; false for a quick entity list.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Filter entities by name (substring match).",
    }),
  ),
});

export function createMemoryWorldTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_world",
    label: "Memory World Model",
    description:
      "Surface the known entity world model — people, projects, organizations. " +
      "Use this to get a quick picture of who/what is known and how much is remembered about them. " +
      "Returns entities ranked by confidence and evidence count. " +
      "Pass includeMemories: true to also get key facts associated with each entity.",
    parameters: MemoryWorldSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const limit = typeof p.limit === "number" ? Math.min(Math.trunc(p.limit), 100) : 20;
      const includeMemories = Boolean(p.includeMemories);
      const nameQuery =
        typeof p.query === "string" && p.query.trim() ? p.query.trim() : null;
      const entityKind =
        typeof p.entityKind === "string" && p.entityKind.trim()
          ? p.entityKind.trim()
          : null;

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

      const where: string[] = ["status = 'active'"];
      const queryParams: (string | number | null)[] = [];

      if (entityKind) {
        where.push("kind = ?");
        queryParams.push(entityKind);
      }
      if (nameQuery) {
        where.push("(display_name LIKE ? OR normalized_name LIKE ?)");
        queryParams.push(`%${nameQuery}%`, `%${nameQuery.toLowerCase()}%`);
      }

      const entitySql = `
        SELECT entity_id, kind, display_name, confidence, created_at, updated_at
        FROM memory_entities
        WHERE ${where.join(" AND ")}
        ORDER BY confidence DESC, updated_at DESC
        LIMIT ?
      `;
      queryParams.push(limit);

      let entities: Array<Record<string, unknown>>;
      try {
        entities = db.prepare(entitySql).all(...queryParams) as Array<Record<string, unknown>>;
      } catch (err) {
        console.error("[memory_world] entity query failed:", err);
        return jsonResult({
          error: "Memory world query failed.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      let result: Array<Record<string, unknown>>;

      if (includeMemories && entities.length > 0) {
        result = entities.map((e) => {
          // Look up memories that tag this entity by name (via tags JSON array)
          const taggedSql = `
            SELECT memory_id, type, content, confidence, created_at
            FROM memory_current
            WHERE status = 'active'
              AND (tags LIKE ? OR content LIKE ?)
            ORDER BY confidence DESC, created_at DESC
            LIMIT 5
          `;
          const namePattern = `%${e.display_name}%`;
          let memories: Array<Record<string, unknown>> = [];
          try {
            memories = db
              .prepare(taggedSql)
              .all(namePattern, namePattern) as Array<Record<string, unknown>>;
          } catch (err) {
            console.warn("[memory_world] entity memory lookup failed (non-fatal):", err);
          }

          return {
            id: e.entity_id,
            kind: e.kind,
            name: e.display_name,
            confidence: e.confidence,
            updated_at: e.updated_at,
            memories: memories.map((m) => ({
              id: m.memory_id,
              kind: m.type,
              snippet:
                String(m.content).length > 200
                  ? String(m.content).substring(0, 197) + "..."
                  : String(m.content),
              confidence: m.confidence,
            })),
          };
        });
      } else {
        result = entities.map((e) => ({
          id: e.entity_id,
          kind: e.kind,
          name: e.display_name,
          confidence: e.confidence,
          updated_at: e.updated_at,
        }));
      }

      return jsonResult({
        entityCount: result.length,
        entityKind: entityKind ?? "all",
        entities: result,
      });
    },
  };
}
