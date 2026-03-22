import type { DatabaseSync } from "node:sqlite";

export type HealthCheckResult = {
  ok: boolean;
  dbOpen: boolean;
  memoryCount: number;
  lastWriteAt: string | null;
};

/**
 * Lightweight health check: verifies the database is accessible and returns
 * basic counts.  No full scan — just a fast probe.
 */
export function quickHealthCheck(db: DatabaseSync): HealthCheckResult {
  try {
    // Verify the connection is responsive.
    db.prepare("SELECT 1").get();
  } catch {
    return { ok: false, dbOpen: false, memoryCount: 0, lastWriteAt: null };
  }

  let memoryCount = 0;
  let lastWriteAt: string | null = null;

  try {
    const countRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM memory_current")
      .get() as { cnt: number } | undefined;
    memoryCount = countRow?.cnt ?? 0;
  } catch {
    // Table may not exist yet — that is fine for a health probe.
  }

  try {
    const lastRow = db
      .prepare(
        "SELECT updated_at FROM memory_current ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as { updated_at: string } | undefined;
    lastWriteAt = lastRow?.updated_at ?? null;
  } catch {
    // Same — table might not exist.
  }

  return { ok: true, dbOpen: true, memoryCount, lastWriteAt };
}
