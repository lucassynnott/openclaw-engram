import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { ensureMemoryTables } from "./memory-schema.js";
import { isFragmentContent, isHeartbeatPattern } from "./memory-utils.js";

export type ArchiveStaleEpisodesResult = {
  archived: number;
  scanned: number;
};

export type ArchiveFragmentsResult = {
  archived: number;
  scanned: number;
};

export type MemoryHygieneResult = {
  staleEpisodes: ArchiveStaleEpisodesResult;
  fragments: ArchiveFragmentsResult;
};

/**
 * Archive EPISODE entries older than `retentionDays`.
 *
 * Episodes are temporal by nature — a heartbeat or status check from 10 days
 * ago has zero recall value. This sets `status = 'archived'` and stamps
 * `archived_at` but never deletes rows.
 */
export function archiveStaleEpisodes(params: {
  db: DatabaseSync;
  retentionDays: number;
  now?: string;
}): ArchiveStaleEpisodesResult {
  ensureMemoryTables(params.db);

  const retentionDays = Math.max(1, Math.trunc(params.retentionDays));
  const now = params.now || new Date().toISOString();

  // Compute the cutoff date (ISO string)
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Count candidates before archiving
  const countRow = params.db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM memory_current
       WHERE type = 'EPISODE'
         AND status = 'active'
         AND COALESCE(content_time, created_at) < ?`,
    )
    .get(cutoff) as { c: number } | undefined;
  const scanned = Number(countRow?.c ?? 0);

  if (scanned === 0) {
    return { archived: 0, scanned: 0 };
  }

  // Archive in one batch
  const result = params.db
    .prepare(
      `UPDATE memory_current
       SET status = 'archived',
           archived_at = ?
       WHERE type = 'EPISODE'
         AND status = 'active'
         AND COALESCE(content_time, created_at) < ?`,
    )
    .run(now, cutoff);

  return {
    archived: Number(result.changes),
    scanned,
  };
}

/**
 * Archive active heartbeat-pattern EPISODE entries that are older than
 * `retentionDays`. Heartbeats are the worst offenders for memory bloat,
 * so this catches them specifically even if the general episode retention
 * window hasn't closed yet (when called with a shorter retention).
 */
export function archiveStaleHeartbeats(params: {
  db: DatabaseSync;
  retentionDays: number;
  now?: string;
}): ArchiveStaleEpisodesResult {
  ensureMemoryTables(params.db);

  const retentionDays = Math.max(1, Math.trunc(params.retentionDays));
  const now = params.now || new Date().toISOString();
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Fetch episode candidates
  const rows = params.db
    .prepare(
      `SELECT memory_id, content
       FROM memory_current
       WHERE type = 'EPISODE'
         AND status = 'active'
         AND COALESCE(content_time, created_at) < ?`,
    )
    .all(cutoff) as Array<{ memory_id: string; content: string }>;

  const heartbeatIds = rows
    .filter((row) => isHeartbeatPattern(row.content))
    .map((row) => row.memory_id);

  if (heartbeatIds.length === 0) {
    return { archived: 0, scanned: rows.length };
  }

  const placeholders = heartbeatIds.map(() => "?").join(",");
  const result = params.db
    .prepare(
      `UPDATE memory_current
       SET status = 'archived',
           archived_at = ?
       WHERE memory_id IN (${placeholders})`,
    )
    .run(now, ...heartbeatIds);

  return {
    archived: Number(result.changes),
    scanned: rows.length,
  };
}

/**
 * Archive fragment memories — very short content entries with no meaningful
 * semantic value. These are typically leftover from early ingestion before
 * quality filters were in place.
 */
export function archiveFragments(params: {
  db: DatabaseSync;
  minContentChars?: number;
  now?: string;
}): ArchiveFragmentsResult {
  ensureMemoryTables(params.db);

  const minChars = params.minContentChars ?? 50;
  const now = params.now || new Date().toISOString();

  // Fetch short active entries
  const rows = params.db
    .prepare(
      `SELECT memory_id, content, type
       FROM memory_current
       WHERE status = 'active'
         AND length(content) < ?`,
    )
    .all(minChars) as Array<{ memory_id: string; content: string; type: string }>;

  const fragmentIds = rows
    .filter((row) => isFragmentContent(row.content, minChars))
    .map((row) => row.memory_id);

  if (fragmentIds.length === 0) {
    return { archived: 0, scanned: rows.length };
  }

  const placeholders = fragmentIds.map(() => "?").join(",");
  const result = params.db
    .prepare(
      `UPDATE memory_current
       SET status = 'archived',
           archived_at = ?
       WHERE memory_id IN (${placeholders})`,
    )
    .run(now, ...fragmentIds);

  return {
    archived: Number(result.changes),
    scanned: rows.length,
  };
}

/**
 * Run all hygiene routines in one pass. Designed to be called from native
 * sync or as a standalone maintenance step.
 */
export function runMemoryHygiene(params: {
  db: DatabaseSync;
  config: LcmConfig;
  now?: string;
}): MemoryHygieneResult {
  const now = params.now || new Date().toISOString();

  const staleEpisodes = archiveStaleEpisodes({
    db: params.db,
    retentionDays: params.config.episodeRetentionDays,
    now,
  });

  const fragments = archiveFragments({
    db: params.db,
    minContentChars: params.config.fragmentMinContentChars,
    now,
  });

  return { staleEpisodes, fragments };
}
