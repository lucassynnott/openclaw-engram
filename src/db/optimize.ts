/**
 * optimize.ts — Periodic SQLite database maintenance for Engram.
 *
 * Provides lightweight optimization that can run safely alongside normal
 * operations. Deliberately avoids full VACUUM (which rewrites the entire
 * file and holds an exclusive lock) in favor of incremental techniques.
 */

import type { DatabaseSync } from "node:sqlite";

export type OptimizeResult = {
  freedBytes: number;
  durationMs: number;
};

/**
 * Run lightweight SQLite maintenance on the database.
 *
 * - `PRAGMA optimize` lets SQLite re-analyze tables that have changed
 *   significantly since the last analysis, improving query planner decisions.
 * - `PRAGMA incremental_vacuum(1000)` reclaims up to 1000 free pages from
 *   the database file without requiring a full rewrite. This only works
 *   when `auto_vacuum = INCREMENTAL` is set; otherwise it is a safe no-op.
 *
 * This function intentionally does NOT run full `VACUUM` — that rewrites
 * the entire database file and is too expensive for large databases.
 */
export function optimizeDatabase(db: DatabaseSync): OptimizeResult {
  const start = Date.now();

  // Query the page size and free page count before vacuuming so we can
  // estimate how many bytes were actually reclaimed.
  const pageSizeRow = db.prepare("PRAGMA page_size").get() as
    | { page_size: number }
    | undefined;
  const pageSize = pageSizeRow?.page_size ?? 4096;

  const freePagesBefore = (
    db.prepare("PRAGMA freelist_count").get() as
      | { freelist_count: number }
      | undefined
  )?.freelist_count ?? 0;

  // Enable incremental auto-vacuum if not already set. This is required for
  // incremental_vacuum to actually reclaim pages. Setting this on a database
  // that already uses a different auto_vacuum mode is a no-op until the next
  // full VACUUM, but it's safe to call unconditionally.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");

  // Let SQLite re-analyze tables whose statistics are stale.
  db.exec("PRAGMA optimize");

  // Reclaim up to 1000 free pages without a full lock.
  db.exec("PRAGMA incremental_vacuum(1000)");

  const freePagesAfter = (
    db.prepare("PRAGMA freelist_count").get() as
      | { freelist_count: number }
      | undefined
  )?.freelist_count ?? 0;

  const pagesReclaimed = Math.max(0, freePagesBefore - freePagesAfter);
  const freedBytes = pagesReclaimed * pageSize;
  const durationMs = Date.now() - start;

  return { freedBytes, durationMs };
}

/**
 * Archive old memories that have been flagged as archive candidates.
 *
 * Memories with `value_label = 'archive_candidate'` that are older than
 * `archiveAfterDays` are moved to `status = 'archived'`. This never touches
 * memories with value_label 'core' or 'situational'.
 *
 * Returns the number of rows archived.
 */
export function archiveOldMemories(
  db: DatabaseSync,
  config: { archiveAfterDays: number } = { archiveAfterDays: 30 },
): number {
  const cutoffDate = new Date(
    Date.now() - config.archiveAfterDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result = db.prepare(`
    UPDATE memory_current
    SET status = 'archived',
        archived_at = datetime('now')
    WHERE value_label = 'archive_candidate'
      AND status = 'active'
      AND created_at < ?
      AND (value_label NOT IN ('core', 'situational'))
  `).run(cutoffDate);

  return Number(result.changes);
}
