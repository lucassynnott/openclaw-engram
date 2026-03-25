import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-memory-schema-"));
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

describe("ensureMemoryTables", () => {
  it("upgrades legacy memory_current tables before creating source provenance indexes", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE memory_current (
        memory_id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'CONTEXT',
        content TEXT NOT NULL,
        normalized TEXT NOT NULL DEFAULT '',
        normalized_hash TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_agent TEXT,
        source_session TEXT,
        confidence REAL DEFAULT 0.75,
        scope TEXT NOT NULL DEFAULT 'shared',
        status TEXT NOT NULL DEFAULT 'active',
        value_score REAL,
        value_label TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        last_reviewed_at TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        content_time TEXT,
        valid_until TEXT
      );
    `);

    expect(() => ensureMemoryTables(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(memory_current)").all() as Array<{ name?: string }>;
    const columnNames = new Set(columns.map((column) => String(column.name || "")));
    expect(columnNames.has("source_layer")).toBe(true);
    expect(columnNames.has("source_path")).toBe(true);
    expect(columnNames.has("source_line")).toBe(true);
    expect(columnNames.has("provenance")).toBe(true);
    expect(columnNames.has("source_trigger")).toBe(true);

    const sourceIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_current_source'")
      .get() as { name?: string } | undefined;
    expect(sourceIndex?.name).toBe("idx_memory_current_source");
  });

  it("backfills lifecycle fields for legacy rows", () => {
    const dbPath = makeDbPath();
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE memory_current (
        memory_id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'CONTEXT',
        content TEXT NOT NULL,
        normalized TEXT NOT NULL DEFAULT '',
        normalized_hash TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_agent TEXT,
        source_session TEXT,
        confidence REAL DEFAULT 0.75,
        scope TEXT NOT NULL DEFAULT 'shared',
        status TEXT NOT NULL DEFAULT 'active',
        value_score REAL,
        value_label TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        last_reviewed_at TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        content_time TEXT,
        valid_until TEXT
      );
      INSERT INTO memory_current (
        memory_id, type, content, confidence, scope, status, value_score,
        value_label, created_at, updated_at, last_reviewed_at, tags
      ) VALUES (
        'mem_legacy', 'USER_FACT', 'Lucas maintains the Engram plugin', 0.83,
        'shared', 'active', 0.91, 'core',
        '2026-02-01T10:00:00.000Z', '2026-02-02T10:00:00.000Z', '2026-02-03T10:00:00.000Z', '[]'
      );
    `);

    ensureMemoryTables(db);

    const row = db
      .prepare(`
        SELECT
          truth_confidence, activation_strength, activation_seed, reinforcement_count,
          last_reinforced_at, first_seen_at, last_seen_at
        FROM memory_current
        WHERE memory_id = 'mem_legacy'
      `)
      .get() as Record<string, unknown> | undefined;

    expect(Number(row?.truth_confidence)).toBeCloseTo(0.83, 4);
    expect(Number(row?.activation_strength)).toBeGreaterThan(0);
    expect(row?.activation_seed).toBe("backfill");
    expect(Number(row?.reinforcement_count)).toBe(1);
    expect(String(row?.last_reinforced_at || "")).toContain("2026-02-03T10:00:00.000Z");
    expect(String(row?.first_seen_at || "")).toContain("2026-02-01T10:00:00.000Z");
    expect(String(row?.last_seen_at || "")).toContain("2026-02-02T10:00:00.000Z");
  });
});
