import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import { hashNormalized, normalizeContent } from "../src/memory/memory-utils.js";
import {
  reindexNativeMemoryLayer,
  syncNativeMemoryLayer,
} from "../src/memory/native-file-sync.js";

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-native-layer-"));
  tempDirs.add(dir);
  return dir;
}

function makeDb() {
  const dir = makeTempDir();
  const dbPath = join(dir, "lcm.db");
  dbPaths.add(dbPath);
  return { db: getLcmConnection(dbPath), dbPath, dir };
}

function listFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (currentDir: string): void => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      out.push(fullPath);
    }
  };
  walk(rootDir);
  return out;
}

afterEach(() => {
  for (const dbPath of dbPaths) closeLcmConnection(dbPath);
  dbPaths.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("native file sync layer", () => {
  it("reindexes MEMORY.md, daily notes, and PARA items idempotently", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    writeFileSync(join(dir, "MEMORY.md"), ["# MEMORY", "", "- [PREFERENCE] Lucas prefers concise commit messages", ""].join("\n"), "utf8");
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(
      join(dir, "memory", "2026-03-18.md"),
      ["# Daily Note - 2026-03-18", "", "- [EPISODE] Today Lucas paired with Viktor on sync conflicts", ""].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, "life", "areas", "engram"), { recursive: true });
    writeFileSync(
      join(dir, "life", "areas", "engram", "items.yaml"),
      [
        "- id: mem_native_seed",
        '  fact: "Engram stores durable memory in SQLite"',
        '  kind: "USER_FACT"',
        '  category: "status"',
        '  timestamp: "2026-03-17"',
        '  source: "promoted_native"',
        '  status: "active"',
        "  superseded_by: null",
        '  scope: "shared"',
        "  related_entities:",
        '    - "projects/engram"',
        '  last_accessed: "2026-03-17"',
        "  access_count: 0",
        "",
      ].join("\n"),
      "utf8",
    );

    const first = reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T10:00:00.000Z",
    });
    const second = reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T10:05:00.000Z",
    });

    expect(first.imported).toBe(3);
    expect(first.conflicts).toBe(0);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.conflicts).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(3);

    const rows = db
      .prepare("SELECT content, source_layer, source_path FROM memory_current ORDER BY content ASC")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.source_layer === "native" && row.source_path === "MEMORY.md")).toBe(true);
    expect(rows.some((row) => row.source_layer === "native" && row.source_path === "memory/2026-03-18.md")).toBe(true);
    expect(rows.some((row) => row.source_layer === "promoted_native" && row.source_path === "life/areas/engram/items.yaml")).toBe(true);
  });

  it("keeps registry rows authoritative when a native file repeats the same fact", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    const content = "Lucas prefers terse status updates during release week";
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_score, value_label,
        created_at, updated_at, archived_at, tags, superseded_by,
        content_time, source_layer, source_path, source_line
      ) VALUES (?, 'PREFERENCE', ?, ?, ?, 'manual', 0.75, 'shared', 'active', 0.9, 'core', ?, ?, NULL, '[]', NULL, NULL, 'registry', NULL, NULL)
    `).run(
      "mem_registry_1",
      content,
      normalizeContent(content),
      hashNormalized(content),
      "2026-03-18T09:00:00.000Z",
      "2026-03-18T09:00:00.000Z",
    );

    writeFileSync(join(dir, "MEMORY.md"), ["# MEMORY", "", `- [PREFERENCE] ${content}`, ""].join("\n"), "utf8");

    const result = reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T10:00:00.000Z",
    });

    expect(result.imported).toBe(0);
    expect(result.conflicts).toBe(1);

    const rows = db
      .prepare("SELECT memory_id, source_layer FROM memory_current ORDER BY memory_id ASC")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memory_id).toBe("mem_registry_1");
    expect(rows[0]?.source_layer).toBe("registry");
  });

  it("writes synced PARA files back out after reindex", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    writeFileSync(join(dir, "MEMORY.md"), ["# MEMORY", "", "- [DECISION] We will keep native sync local to the repo", ""].join("\n"), "utf8");

    reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T11:00:00.000Z",
    });
    const sync = syncNativeMemoryLayer({ db, rootDir: dir });
    const secondSync = syncNativeMemoryLayer({ db, rootDir: dir });
    const paraItemsPath = listFiles(join(dir, "life")).find((filePath) => filePath.endsWith("items.yaml"));

    expect(sync.filesWritten).toBeGreaterThan(0);
    expect(secondSync.filesWritten).toBe(0);
    expect(sync.paraFolderCount).toBe(1);
    expect(paraItemsPath).toBeTruthy();
    expect(readFileSync(String(paraItemsPath), "utf8")).toContain("We will keep native sync local to the repo");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("<!-- engram:sync:start -->");
  });

  it("reindexs synced registry mirrors without false conflicts", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    const content = "Lucas decided the engram project keeps PARA mirrors inside the repo";
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_score, value_label,
        created_at, updated_at, archived_at, tags, superseded_by,
        content_time, source_layer, source_path, source_line
      ) VALUES (?, 'DECISION', ?, ?, ?, 'manual', 0.75, 'engram', 'active', 0.91, 'core', ?, ?, NULL, '["projects/engram"]', NULL, ?, 'registry', NULL, NULL)
    `).run(
      "mem_registry_roundtrip",
      content,
      normalizeContent(content),
      hashNormalized(content),
      "2026-03-18T09:00:00.000Z",
      "2026-03-18T09:00:00.000Z",
      "2026-03-18",
    );

    const sync = syncNativeMemoryLayer({ db, rootDir: dir });
    const reindex = reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T10:00:00.000Z",
    });

    expect(sync.filesWritten).toBeGreaterThan(0);
    expect(reindex.imported).toBe(0);
    expect(reindex.updated).toBe(0);
    expect(reindex.conflicts).toBe(0);
    expect(reindex.skipped).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare("SELECT source_layer, source_path, source_line FROM memory_current WHERE memory_id = ?")
      .get("mem_registry_roundtrip") as Record<string, unknown> | undefined;
    expect(row?.source_layer).toBe("registry");
    expect(row?.source_path).toBe("life/projects/engram/items.yaml");
    expect(Number(row?.source_line)).toBeGreaterThan(0);
  });

  it("keeps native provenance stable after syncing mirrored PARA files", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    writeFileSync(
      join(dir, "MEMORY.md"),
      ["# MEMORY", "", "- [PREFERENCE] Lucas prefers provenance to stay attached to the original file", ""].join("\n"),
      "utf8",
    );

    const first = reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T11:00:00.000Z",
    });
    const initialRow = db
      .prepare("SELECT memory_id, source_layer, source_path FROM memory_current LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    const sync = syncNativeMemoryLayer({ db, rootDir: dir });
    const second = reindexNativeMemoryLayer({
      db,
      rootDir: dir,
      now: "2026-03-18T11:05:00.000Z",
    });
    const initialMemoryId = typeof initialRow?.memory_id === "string" ? initialRow.memory_id : "";
    const finalRow = db
      .prepare("SELECT memory_id, source_layer, source_path FROM memory_current WHERE memory_id = ?")
      .get(initialMemoryId) as Record<string, unknown> | undefined;

    expect(first.imported).toBe(1);
    expect(sync.filesWritten).toBeGreaterThan(0);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.conflicts).toBe(0);
    expect(finalRow?.source_layer).toBe("native");
    expect(finalRow?.source_path).toBe("MEMORY.md");
  });
});
