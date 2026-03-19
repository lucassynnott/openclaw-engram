import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensureMemoryTables } from "./memory-schema.js";

export type MemoryTriggerMatch = {
  triggerId: string;
  memoryId: string;
  pattern: string;
  matcher: string;
  metadata: Record<string, unknown>;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeMatcher(value: string | undefined): "substring" | "word" | "regex" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "regex") return "regex";
  if (normalized === "word") return "word";
  return "substring";
}

function matchesPattern(prompt: string, pattern: string, matcher: string): boolean {
  const haystack = prompt.trim();
  const needle = pattern.trim();
  if (!haystack || !needle) {
    return false;
  }

  switch (normalizeMatcher(matcher)) {
    case "word": {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(
        haystack,
      );
    }
    case "regex":
      try {
        return new RegExp(needle, "iu").test(haystack);
      } catch {
        return haystack.toLowerCase().includes(needle.toLowerCase());
      }
    case "substring":
    default:
      return haystack.toLowerCase().includes(needle.toLowerCase());
  }
}

export function upsertMemoryTrigger(params: {
  db: DatabaseSync;
  memoryId: string;
  pattern: string;
  matcher?: string;
  metadata?: Record<string, unknown>;
}): { triggerId: string; created: boolean } {
  ensureMemoryTables(params.db);
  const pattern = String(params.pattern || "").trim();
  if (!pattern) {
    throw new Error("trigger pattern is required");
  }

  const matcher = normalizeMatcher(params.matcher);
  const existing = params.db
    .prepare(
      `SELECT trigger_id
       FROM memory_triggers
       WHERE memory_id = ? AND pattern = ? AND matcher = ?
       LIMIT 1`,
    )
    .get(params.memoryId, pattern, matcher) as { trigger_id?: string } | undefined;
  const triggerId =
    typeof existing?.trigger_id === "string" && existing.trigger_id.trim()
      ? existing.trigger_id
      : `trigger_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const metadata =
    params.metadata && typeof params.metadata === "object"
      ? JSON.stringify(params.metadata)
      : "{}";

  params.db
    .prepare(
      `INSERT INTO memory_triggers (
         trigger_id, memory_id, pattern, matcher, enabled, created_at, updated_at, metadata
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(trigger_id) DO UPDATE SET
         pattern = excluded.pattern,
         matcher = excluded.matcher,
         enabled = 1,
         updated_at = excluded.updated_at,
         metadata = excluded.metadata`,
    )
    .run(triggerId, params.memoryId, pattern, matcher, now, now, metadata);

  return {
    triggerId,
    created: !existing,
  };
}

export function listMatchingMemoryTriggers(params: {
  db: DatabaseSync;
  prompt: string;
  limit?: number;
}): MemoryTriggerMatch[] {
  ensureMemoryTables(params.db);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) {
    return [];
  }

  const rows = params.db
    .prepare(
      `SELECT trigger_id, memory_id, pattern, matcher, metadata
       FROM memory_triggers
       WHERE enabled = 1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.trunc(params.limit ?? 12)))) as Array<
    Record<string, unknown>
  >;

  return rows
    .filter((row) =>
      matchesPattern(prompt, String(row.pattern || ""), String(row.matcher || "substring")),
    )
    .map((row) => ({
      triggerId: String(row.trigger_id || ""),
      memoryId: String(row.memory_id || ""),
      pattern: String(row.pattern || ""),
      matcher: String(row.matcher || "substring"),
      metadata: parseJsonObject(row.metadata),
    }));
}
