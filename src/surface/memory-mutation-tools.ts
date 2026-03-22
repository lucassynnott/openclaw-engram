import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { resolveSourceAgentIdFromSessionContext } from "../memory/agent-namespace.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import { upsertMemoryTrigger } from "../memory/memory-triggers.js";
import { runMemoryHygiene } from "../memory/memory-hygiene.js";
import { syncNativeMemoryLayer } from "../memory/native-file-sync.js";
import { reindexMemoryVectorById } from "../memory/vector-search.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { storeMemory } from "./memory-add-tool.js";

const MemoryRetractSchema = Type.Object({
  memoryId: Type.String({
    description: "Memory ID to retract or mark superseded.",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Optional explanation for the retraction.",
    }),
  ),
});

const MemoryCorrectSchema = Type.Object({
  memoryId: Type.String({
    description: "Existing memory ID to correct.",
  }),
  content: Type.String({
    description: "Corrected replacement memory content.",
  }),
  kind: Type.Optional(
    Type.String({
      description: "Optional corrected memory kind.",
    }),
  ),
  scope: Type.Optional(Type.String()),
  entities: Type.Optional(Type.Array(Type.String())),
  reason: Type.Optional(Type.String()),
  triggerPattern: Type.Optional(Type.String()),
});

function openDb(config: LcmConfig): DatabaseSync {
  const db = getLcmConnection(config.databasePath);
  ensureMemoryTables(db);
  return db;
}

function loadMemoryRow(db: DatabaseSync, memoryId: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT memory_id, type, content, scope, status, tags, source_agent
       FROM memory_current
       WHERE memory_id = ?
       LIMIT 1`,
    )
    .get(memoryId) as Record<string, unknown> | undefined;
}

function syncNativeIfEnabled(config: LcmConfig, resolveAgentDir?: () => string): string | null {
  if (!config.nativeEnabled || typeof resolveAgentDir !== "function") {
    return null;
  }
  const rootDir = String(resolveAgentDir() || "").trim();
  if (!rootDir) {
    return null;
  }
  const db = openDb(config);
  syncNativeMemoryLayer({ db, rootDir });
  // Run memory hygiene (stale episode archival, fragment cleanup) after sync
  try {
    runMemoryHygiene({ db, config });
  } catch {
    // Hygiene is best-effort; don't fail the sync
  }
  return rootDir;
}

export function createMemoryRetractTool(input: {
  config: LcmConfig;
  deps?: Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">;
  sessionKey?: string;
  resolveAgentDir?: () => string;
}): AnyAgentTool {
  return {
    name: "memory_retract",
    label: "Memory Retract",
    description:
      "Mark an existing memory as superseded/retracted so it stops surfacing in normal recall.",
    parameters: MemoryRetractSchema,
    async execute(_toolCallId, params) {
      try {
      const p = params as Record<string, unknown>;
      const memoryId = typeof p.memoryId === "string" ? p.memoryId.trim() : "";
      if (!memoryId) {
        return {
          content: [{ type: "text", text: "memoryId is required." }],
          details: { error: "memoryId is required." },
        };
      }

      let db: DatabaseSync;
      try {
        db = openDb(input.config);
      } catch (err) {
        return {
          content: [{ type: "text", text: "Memory store unavailable." }],
          details: { error: "db_unavailable", detail: err instanceof Error ? err.message : String(err) },
        };
      }

      const row = loadMemoryRow(db, memoryId);
      if (!row) {
        return {
          content: [{ type: "text", text: `Memory not found: ${memoryId}` }],
          details: { error: "not_found", memoryId },
        };
      }

      const now = new Date().toISOString();
      const reason = typeof p.reason === "string" ? p.reason.trim() : "";
      db.prepare(
        `UPDATE memory_current
         SET status = 'superseded', updated_at = ?, archived_at = COALESCE(archived_at, ?), last_reviewed_at = ?
         WHERE memory_id = ?`,
      ).run(now, now, now, memoryId);
      db.prepare(
        `INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
         VALUES (?, ?, 'memory_retract', 'retract', ?, 'manual', ?)`,
      ).run(
        randomUUID(),
        now,
        memoryId,
        JSON.stringify({
          reason: reason || undefined,
          source_agent: resolveSourceAgentIdFromSessionContext({
            deps: input.deps,
            sessionKey: input.sessionKey,
          }),
        }),
      );

      let nativeSyncRoot: string | null = null;
      try {
        nativeSyncRoot = syncNativeIfEnabled(input.config, input.resolveAgentDir);
      } catch {
        nativeSyncRoot = null;
      }

      const lines = [
        "## Memory retracted",
        "",
        `**ID:** \`${memoryId}\``,
        `**Previous content:** ${String(row.content || "")}`,
      ];
      if (reason) lines.push(`**Reason:** ${reason}`);
      if (nativeSyncRoot) lines.push(`**Native sync:** ${nativeSyncRoot}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          memoryId,
          retracted: true,
          reason: reason || undefined,
          nativeSyncRoot,
        },
      };
      } catch (err) {
        console.error("[memory_retract] unexpected error:", err);
        return {
          content: [{ type: "text", text: "Memory retract failed unexpectedly." }],
          details: { error: "unexpected", detail: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}

export function createMemoryCorrectTool(input: {
  config: LcmConfig;
  deps?: Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">;
  sessionKey?: string;
  resolveAgentDir?: () => string;
}): AnyAgentTool {
  return {
    name: "memory_correct",
    label: "Memory Correct",
    description:
      "Create a corrected replacement memory and supersede the original memory with an explicit link.",
    parameters: MemoryCorrectSchema,
    async execute(_toolCallId, params) {
      try {
      const p = params as Record<string, unknown>;
      const memoryId = typeof p.memoryId === "string" ? p.memoryId.trim() : "";
      const content = typeof p.content === "string" ? p.content.trim() : "";
      if (!memoryId || !content) {
        return {
          content: [{ type: "text", text: "memoryId and content are required." }],
          details: { error: "memoryId and content are required." },
        };
      }

      let db: DatabaseSync;
      try {
        db = openDb(input.config);
      } catch (err) {
        return {
          content: [{ type: "text", text: "Memory store unavailable." }],
          details: { error: "db_unavailable", detail: err instanceof Error ? err.message : String(err) },
        };
      }

      const row = loadMemoryRow(db, memoryId);
      if (!row) {
        return {
          content: [{ type: "text", text: `Memory not found: ${memoryId}` }],
          details: { error: "not_found", memoryId },
        };
      }

      const fallbackEntities = (() => {
        try {
          const tags = JSON.parse(String(row.tags || "[]")) as unknown;
          return Array.isArray(tags)
            ? tags.filter((value): value is string => typeof value === "string")
            : [];
        } catch {
          return [];
        }
      })();
      const corrected = storeMemory({
        config: input.config,
        content,
        kind: typeof p.kind === "string" ? p.kind : String(row.type || ""),
        scope: typeof p.scope === "string" ? p.scope : String(row.scope || "shared"),
        entities: Array.isArray(p.entities)
          ? (p.entities as unknown[]).filter((value): value is string => typeof value === "string")
          : fallbackEntities,
        source: "correction",
        sourceAgent: resolveSourceAgentIdFromSessionContext({
          deps: input.deps,
          sessionKey: input.sessionKey,
        }),
        sourceSession: input.sessionKey,
        sourceTrigger: "correction",
        component: "memory_correct",
        provenance: {
          corrected_memory_id: memoryId,
          reason: typeof p.reason === "string" ? p.reason.trim() || undefined : undefined,
        },
        dedupeMode: "none",
      });

      if (!corrected.stored || !corrected.memoryId) {
        return {
          content: [
            {
              type: "text",
              text: `Correction was not stored: ${corrected.reason || "unknown reason"}`,
            },
          ],
          details: corrected,
        };
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE memory_current
         SET status = 'superseded', superseded_by = ?, updated_at = ?, archived_at = COALESCE(archived_at, ?), last_reviewed_at = ?
         WHERE memory_id = ?`,
      ).run(corrected.memoryId, now, now, now, memoryId);
      db.prepare(
        `INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
         VALUES (?, ?, 'memory_correct', 'correct', ?, 'manual', ?)`,
      ).run(
        randomUUID(),
        now,
        memoryId,
        JSON.stringify({
          corrected_memory_id: corrected.memoryId,
          reason: typeof p.reason === "string" ? p.reason.trim() || undefined : undefined,
        }),
      );

      const triggerPattern = typeof p.triggerPattern === "string" ? p.triggerPattern.trim() : "";
      if (triggerPattern) {
        try {
          upsertMemoryTrigger({
            db,
            memoryId: corrected.memoryId,
            pattern: triggerPattern,
            metadata: { created_by: "memory_correct" },
          });
        } catch (err) {
          console.warn("[memory_correct] upsertMemoryTrigger failed (non-fatal):", err);
        }
      }

      // Re-embed the corrected memory so semantic search matches the new content.
      // Best-effort: silently skips when vector backend is disabled ("none").
      let vectorIndexWarning: string | null = null;
      try {
        await reindexMemoryVectorById({
          db: getLcmConnection(input.config.databasePath),
          config: input.config,
          memoryId: String(corrected.memoryId),
        });
      } catch (err) {
        vectorIndexWarning = err instanceof Error ? err.message : String(err);
        console.warn("[memory_correct] vector re-index failed (non-fatal):", err);
      }

      let nativeSyncRoot: string | null = null;
      try {
        nativeSyncRoot = syncNativeIfEnabled(input.config, input.resolveAgentDir);
      } catch {
        nativeSyncRoot = null;
      }

      const lines = [
        "## Memory corrected",
        "",
        `**Old ID:** \`${memoryId}\``,
        `**New ID:** \`${corrected.memoryId}\``,
        `**Old content:** ${String(row.content || "")}`,
        `**Corrected content:** ${content}`,
      ];
      if (typeof p.reason === "string" && p.reason.trim()) {
        lines.push(`**Reason:** ${p.reason.trim()}`);
      }
      if (nativeSyncRoot) lines.push(`**Native sync:** ${nativeSyncRoot}`);
      if (vectorIndexWarning) lines.push(`**Vector indexing warning:** ${vectorIndexWarning}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          corrected: true,
          oldMemoryId: memoryId,
          newMemoryId: corrected.memoryId,
          nativeSyncRoot,
          vectorIndexWarning,
        },
      };
      } catch (err) {
        console.error("[memory_correct] unexpected error:", err);
        return {
          content: [{ type: "text", text: "Memory correct failed unexpectedly." }],
          details: { error: "unexpected", detail: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}
