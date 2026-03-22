import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import { optimizeDatabase, archiveOldMemories } from "../src/db/optimize.js";

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-optimize-"));
  tempDirs.add(dir);
  const dbPath = join(dir, "lcm.db");
  dbPaths.add(dbPath);
  return dbPath;
}

afterEach(() => {
  for (const dbPath of dbPaths) closeLcmConnection(dbPath);
  dbPaths.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("optimizeDatabase", () => {
  it("runs without error on an empty database", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);

    const result = optimizeDatabase(db);

    expect(result).toHaveProperty("freedBytes");
    expect(result).toHaveProperty("durationMs");
    expect(typeof result.freedBytes).toBe("number");
    expect(typeof result.durationMs).toBe("number");
    expect(result.freedBytes).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs without error on a database with data", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);
    ensureMemoryTables(db);

    // Insert some data
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      db.prepare(`
        INSERT INTO memory_current (
          memory_id, type, content, normalized, normalized_hash,
          source, confidence, scope, status,
          created_at, updated_at, source_layer
        ) VALUES (?, 'CONTEXT', ?, '', '', 'test', 0.75, 'shared', 'active', ?, ?, 'registry')
      `).run(`mem-${i}`, `Test memory content number ${i}`, now, now);
    }

    const result = optimizeDatabase(db);

    expect(result).toHaveProperty("freedBytes");
    expect(result).toHaveProperty("durationMs");
    expect(result.freedBytes).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("archiveOldMemories", () => {
  it("archives old archive_candidate memories", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);
    ensureMemoryTables(db);

    const oldDate = new Date(
      Date.now() - 60 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 60 days ago
    const now = new Date().toISOString();

    // Insert an old archive_candidate
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_label,
        created_at, updated_at, source_layer
      ) VALUES (?, 'CONTEXT', 'old candidate', '', '', 'test', 0.75, 'shared', 'active', 'archive_candidate', ?, ?, 'registry')
    `).run("old-candidate-1", oldDate, now);

    // Insert a recent archive_candidate (should NOT be archived)
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_label,
        created_at, updated_at, source_layer
      ) VALUES (?, 'CONTEXT', 'recent candidate', '', '', 'test', 0.75, 'shared', 'active', 'archive_candidate', ?, ?, 'registry')
    `).run("recent-candidate-1", now, now);

    const archived = archiveOldMemories(db, { archiveAfterDays: 30 });

    expect(archived).toBe(1);

    // Verify the old one was archived
    const oldRow = db.prepare(
      "SELECT status FROM memory_current WHERE memory_id = ?",
    ).get("old-candidate-1") as { status: string };
    expect(oldRow.status).toBe("archived");

    // Verify the recent one was NOT archived
    const recentRow = db.prepare(
      "SELECT status FROM memory_current WHERE memory_id = ?",
    ).get("recent-candidate-1") as { status: string };
    expect(recentRow.status).toBe("active");
  });

  it("does not touch core or situational memories", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);
    ensureMemoryTables(db);

    const oldDate = new Date(
      Date.now() - 60 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 60 days ago
    const now = new Date().toISOString();

    // Insert old 'core' memory
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_label,
        created_at, updated_at, source_layer
      ) VALUES (?, 'CONTEXT', 'core memory', '', '', 'test', 0.75, 'shared', 'active', 'core', ?, ?, 'registry')
    `).run("core-mem-1", oldDate, now);

    // Insert old 'situational' memory
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_label,
        created_at, updated_at, source_layer
      ) VALUES (?, 'CONTEXT', 'situational memory', '', '', 'test', 0.75, 'shared', 'active', 'situational', ?, ?, 'registry')
    `).run("sit-mem-1", oldDate, now);

    const archived = archiveOldMemories(db, { archiveAfterDays: 30 });

    expect(archived).toBe(0);

    // Verify both remain active
    const coreRow = db.prepare(
      "SELECT status FROM memory_current WHERE memory_id = ?",
    ).get("core-mem-1") as { status: string };
    expect(coreRow.status).toBe("active");

    const sitRow = db.prepare(
      "SELECT status FROM memory_current WHERE memory_id = ?",
    ).get("sit-mem-1") as { status: string };
    expect(sitRow.status).toBe("active");
  });

  it("uses default 30-day threshold", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);
    ensureMemoryTables(db);

    const now = new Date().toISOString();

    // 25 days ago - should NOT be archived with default 30 days
    const recent = new Date(
      Date.now() - 25 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // 35 days ago - SHOULD be archived with default 30 days
    const old = new Date(
      Date.now() - 35 * 24 * 60 * 60 * 1000,
    ).toISOString();

    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_label,
        created_at, updated_at, source_layer
      ) VALUES (?, 'CONTEXT', '25 day old', '', '', 'test', 0.75, 'shared', 'active', 'archive_candidate', ?, ?, 'registry')
    `).run("recent-25d", recent, now);

    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_label,
        created_at, updated_at, source_layer
      ) VALUES (?, 'CONTEXT', '35 day old', '', '', 'test', 0.75, 'shared', 'active', 'archive_candidate', ?, ?, 'registry')
    `).run("old-35d", old, now);

    // Call without explicit config — uses default 30 days
    const archived = archiveOldMemories(db);

    expect(archived).toBe(1);

    const recentRow = db.prepare(
      "SELECT status FROM memory_current WHERE memory_id = ?",
    ).get("recent-25d") as { status: string };
    expect(recentRow.status).toBe("active");

    const oldRow = db.prepare(
      "SELECT status FROM memory_current WHERE memory_id = ?",
    ).get("old-35d") as { status: string };
    expect(oldRow.status).toBe("archived");
  });
});
