import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { quickHealthCheck } from "../src/db/health.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";

describe("quickHealthCheck", () => {
  const dbs: DatabaseSync[] = [];

  function createDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* already closed */ }
    }
    dbs.length = 0;
  });

  it("returns expected shape on empty database with tables", () => {
    const db = createDb();
    ensureMemoryTables(db);
    const result = quickHealthCheck(db);
    expect(result).toEqual({
      ok: true,
      dbOpen: true,
      memoryCount: 0,
      lastWriteAt: null,
    });
  });

  it("returns memoryCount and lastWriteAt when rows exist", () => {
    const db = createDb();
    ensureMemoryTables(db);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, scope, status, created_at, updated_at, tags, provenance,
        source_layer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-1", "CONTEXT", "hello", "hello", "hash1",
      "manual", "shared", "active", now, now, "[]", "{}", "registry",
    );

    const result = quickHealthCheck(db);
    expect(result.ok).toBe(true);
    expect(result.dbOpen).toBe(true);
    expect(result.memoryCount).toBe(1);
    expect(result.lastWriteAt).toBe(now);
  });

  it("returns ok: true on db with no memory tables", () => {
    const db = createDb();
    // Do NOT call ensureMemoryTables — tables don't exist
    const result = quickHealthCheck(db);
    expect(result.ok).toBe(true);
    expect(result.dbOpen).toBe(true);
    expect(result.memoryCount).toBe(0);
    expect(result.lastWriteAt).toBeNull();
  });

  it("returns ok: false when db is closed", () => {
    const db = createDb();
    db.close();
    const result = quickHealthCheck(db);
    expect(result.ok).toBe(false);
    expect(result.dbOpen).toBe(false);
    expect(result.memoryCount).toBe(0);
    expect(result.lastWriteAt).toBeNull();
    // Remove from dbs so afterEach doesn't try to close again
    dbs.length = 0;
  });
});
