import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import { classifyValue, hashNormalized, normalizeContent } from "../src/memory/memory-utils.js";
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

    const seedRow = db
      .prepare(`
        SELECT truth_confidence, activation_strength, reinforcement_count, retrieval_count,
               last_reinforced_at, last_retrieved_at, decay_exempt
        FROM memory_current
        WHERE memory_id = ?
      `)
      .get("mem_native_seed") as Record<string, unknown> | undefined;
    expect(Number(seedRow?.truth_confidence)).toBeCloseTo(0.82, 4);
    expect(Number(seedRow?.activation_strength)).toBe(0);
    expect(Number(seedRow?.reinforcement_count)).toBe(0);
    expect(Number(seedRow?.retrieval_count)).toBe(0);
    expect(seedRow?.last_reinforced_at).toBe("2026-03-17");
    expect(seedRow?.last_retrieved_at).toBe("2026-03-17");
    expect(Number(seedRow?.decay_exempt)).toBe(0);
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
    const paraItems = readFileSync(String(paraItemsPath), "utf8");
    expect(paraItems).toContain("We will keep native sync local to the repo");
    expect(paraItems).toContain("truth_confidence:");
    expect(paraItems).toContain("activation_strength:");
    expect(paraItems).toContain("reinforcement_count:");
    expect(paraItems).toContain("retrieval_count:");
    expect(paraItems).toContain("last_reinforced_at:");
    expect(paraItems).toContain("last_retrieved_at:");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("<!-- engram:sync:start -->");
  });

  it("round-trips lifecycle metadata through items.yaml sync and reindex", () => {
    const { db: sourceDb, dir } = makeDb();
    const { db: importedDb } = makeDb();
    ensureMemoryTables(sourceDb);
    ensureMemoryTables(importedDb);

    const content = "Lucas keeps lifecycle metadata in sync with the exported PARA mirror";
    sourceDb
      .prepare(`
        INSERT INTO memory_current (
          memory_id, type, content, normalized, normalized_hash,
          source, confidence, truth_confidence, activation_strength, reinforcement_count, retrieval_count,
          last_reinforced_at, last_retrieved_at, decay_exempt, scope, status, value_score, value_label,
          created_at, updated_at, archived_at, tags, superseded_by,
          content_time, source_layer, source_path, source_line
        ) VALUES (?, 'PREFERENCE', ?, ?, ?, 'native_file', 0.74, 0.91, 0.63, 4, 7, ?, ?, 1, 'shared', 'active', 0.88, 'core', ?, ?, NULL, '["projects/engram"]', NULL, ?, 'promoted_native', 'life/areas/engram/items.yaml', 1)
      `)
      .run(
        "mem_lifecycle_roundtrip",
        content,
        normalizeContent(content),
        hashNormalized(content),
        "2026-03-17T08:00:00.000Z",
        "2026-03-18T09:15:00.000Z",
        "2026-03-17T08:00:00.000Z",
        "2026-03-18T09:15:00.000Z",
        "2026-03-17",
      );

    const sync = syncNativeMemoryLayer({ db: sourceDb, rootDir: dir });
    const paraItemsPath = listFiles(join(dir, "life")).find((filePath) => filePath.endsWith("items.yaml"));
    expect(sync.filesWritten).toBeGreaterThan(0);
    expect(paraItemsPath).toBeTruthy();

    const paraItems = readFileSync(String(paraItemsPath), "utf8");
    expect(paraItems).toContain("truth_confidence: 0.91");
    expect(paraItems).toContain("activation_strength: 0.63");
    expect(paraItems).toContain("reinforcement_count: 4");
    expect(paraItems).toContain("retrieval_count: 7");
    expect(paraItems).toContain("last_reinforced_at: \"2026-03-17T08:00:00.000Z\"");
    expect(paraItems).toContain("last_retrieved_at: \"2026-03-18T09:15:00.000Z\"");
    expect(paraItems).toContain("decay_exempt: 1");

    const reindex = reindexNativeMemoryLayer({
      db: importedDb,
      rootDir: dir,
      now: "2026-03-18T10:00:00.000Z",
    });

    expect(reindex.imported).toBe(1);
    expect(reindex.conflicts).toBe(0);

    const importedRow = importedDb
      .prepare(`
        SELECT truth_confidence, activation_strength, reinforcement_count, retrieval_count,
               last_reinforced_at, last_retrieved_at, decay_exempt, source_layer, source_path
        FROM memory_current
        WHERE memory_id = ?
      `)
      .get("mem_lifecycle_roundtrip") as Record<string, unknown> | undefined;
    expect(Number(importedRow?.truth_confidence)).toBeCloseTo(0.91, 4);
    expect(Number(importedRow?.activation_strength)).toBeCloseTo(0.63, 4);
    expect(Number(importedRow?.reinforcement_count)).toBe(4);
    expect(Number(importedRow?.retrieval_count)).toBe(7);
    expect(importedRow?.last_reinforced_at).toBe("2026-03-17T08:00:00.000Z");
    expect(importedRow?.last_retrieved_at).toBe("2026-03-18T09:15:00.000Z");
    expect(Number(importedRow?.decay_exempt)).toBe(1);
    expect(importedRow?.source_layer).toBe("promoted_native");
    expect(importedRow?.source_path).toBe("life/areas/projects-engram/items.yaml");
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

// ---------------------------------------------------------------------------
// Memory sync filter tests — MEMORY.md sync block quality
// ---------------------------------------------------------------------------

describe("memory sync block quality filters", () => {
  function insertTestMemory(
    db: ReturnType<typeof getLcmConnection>,
    params: {
      memoryId: string;
      type: string;
      content: string;
      status?: string;
      scope?: string;
      createdAt?: string;
    },
  ) {
    const normalized = normalizeContent(params.content);
    const hash = hashNormalized(params.content);
    const confidence = 0.8;
    const classification = classifyValue(params.content, params.type as any, confidence);
    const now = params.createdAt || new Date().toISOString();
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, scope, status, value_score, value_label,
        created_at, updated_at, archived_at, tags, superseded_by,
        content_time, source_layer, source_path, source_line
      ) VALUES (?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, 'registry', NULL, NULL)
    `).run(
      params.memoryId,
      params.type,
      params.content,
      normalized,
      hash,
      confidence,
      params.scope ?? "shared",
      params.status ?? "active",
      classification.value_score,
      classification.value_label,
      now,
      now,
    );
  }

  it("excludes EPISODE type from MEMORY.md sync block", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    insertTestMemory(db, {
      memoryId: "mem_pref_sync",
      type: "PREFERENCE",
      content: "Lucas prefers dark mode in all editors",
    });
    insertTestMemory(db, {
      memoryId: "mem_episode_sync",
      type: "EPISODE",
      content: "Today Lucas reviewed pull requests and fixed three bugs",
    });
    insertTestMemory(db, {
      memoryId: "mem_fact_sync",
      type: "USER_FACT",
      content: "Lucas works as a software engineer in Vienna",
    });

    writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n", "utf8");
    syncNativeMemoryLayer({ db, rootDir: dir });

    const memoryMd = readFileSync(join(dir, "MEMORY.md"), "utf8");

    // PREFERENCE and USER_FACT should appear
    expect(memoryMd).toContain("Lucas prefers dark mode in all editors");
    expect(memoryMd).toContain("Lucas works as a software engineer in Vienna");

    // EPISODE should NOT appear in the sync block
    expect(memoryMd).not.toContain("Today Lucas reviewed pull requests");
    expect(memoryMd).not.toContain("[EPISODE]");
  });

  it("excludes DECISION entries over 200 chars from sync block", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    const shortDecision = "We decided to use Vitest for testing";
    const longDecision = "A".repeat(201);

    insertTestMemory(db, {
      memoryId: "mem_short_decision",
      type: "DECISION",
      content: shortDecision,
    });
    insertTestMemory(db, {
      memoryId: "mem_long_decision",
      type: "DECISION",
      content: longDecision,
    });

    writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n", "utf8");
    syncNativeMemoryLayer({ db, rootDir: dir });

    const memoryMd = readFileSync(join(dir, "MEMORY.md"), "utf8");

    expect(memoryMd).toContain(shortDecision);
    expect(memoryMd).not.toContain(longDecision);
  });

  it("respects 6K char cap for sync block", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    // Insert enough memories to exceed 6K chars
    for (let i = 0; i < 100; i++) {
      insertTestMemory(db, {
        memoryId: `mem_cap_${String(i).padStart(3, "0")}`,
        type: "USER_FACT",
        content: `Memory entry number ${i}: this is a test fact that fills up space in the sync block with enough text to matter. Some details about topic ${i}.`,
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
      });
    }

    writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n", "utf8");
    syncNativeMemoryLayer({ db, rootDir: dir });

    const memoryMd = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const syncStart = memoryMd.indexOf("<!-- engram:sync:start -->");
    const syncEnd = memoryMd.indexOf("<!-- engram:sync:end -->");

    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncEnd).toBeGreaterThan(syncStart);

    const syncBlock = memoryMd.slice(syncStart, syncEnd);
    // The sync block content (excluding the markers) should be within the 6K limit.
    // We check the rendered content is bounded. The block includes headers and
    // formatting, so allow a small margin above 6000 for the wrapper structure.
    expect(syncBlock.length).toBeLessThan(7000);
  });

  it("newest memories win when cap is reached", () => {
    const { db, dir } = makeDb();
    ensureMemoryTables(db);

    // Insert oldest memory first
    insertTestMemory(db, {
      memoryId: "mem_old",
      type: "USER_FACT",
      content: "This is an old memory that should be dropped if cap is tight",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    // Insert newest memory
    insertTestMemory(db, {
      memoryId: "mem_new",
      type: "USER_FACT",
      content: "This is a new memory that should be kept if cap is tight",
      createdAt: "2026-03-21T00:00:00.000Z",
    });

    // Insert many in between to fill cap
    for (let i = 0; i < 80; i++) {
      insertTestMemory(db, {
        memoryId: `mem_filler_${String(i).padStart(3, "0")}`,
        type: "USER_FACT",
        content: `Filler memory number ${i} with enough content to consume characters in the sync block output here.`,
        createdAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + i * 60000).toISOString(),
      });
    }

    writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n", "utf8");
    syncNativeMemoryLayer({ db, rootDir: dir });

    const memoryMd = readFileSync(join(dir, "MEMORY.md"), "utf8");

    // The newest memory should appear in the sync block
    expect(memoryMd).toContain("This is a new memory that should be kept");
  });
});
