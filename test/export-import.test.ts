import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { exportMemories, importMemories } from "../src/cli/export-import.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";

describe("export/import", () => {
  const dbs: DatabaseSync[] = [];

  function createDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    ensureMemoryTables(db);
    return db;
  }

  function insertMemory(
    db: DatabaseSync,
    id: string,
    hash: string,
    content: string = "test content",
  ) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, scope, status, created_at, updated_at, tags, provenance,
        source_layer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "CONTEXT", content, content.toLowerCase(), hash,
      "manual", "shared", "active", now, now, "[]", "{}", "registry");
  }

  function insertEntity(db: DatabaseSync, id: string, name: string) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO memory_entities (
        entity_id, kind, display_name, normalized_name,
        status, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "person", name, name.toLowerCase(), "active", 0.8, now, now);
  }

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* already closed */ }
    }
    dbs.length = 0;
  });

  it("export produces valid JSON structure", () => {
    const db = createDb();
    insertMemory(db, "m1", "h1", "Remember this");
    insertEntity(db, "e1", "Alice");

    const data = exportMemories(db);
    expect(data.version).toBe(1);
    expect(typeof data.exported_at).toBe("string");
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].memory_id).toBe("m1");
    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].entity_id).toBe("e1");

    // Should be serializable to JSON without error
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.entities).toHaveLength(1);
  });

  it("export only includes active records", () => {
    const db = createDb();
    insertMemory(db, "m1", "h1", "active memory");
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, scope, status, created_at, updated_at, tags, provenance,
        source_layer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m2", "CONTEXT", "archived memory", "archived", "h2",
      "manual", "shared", "archived", now, now, "[]", "{}", "registry");

    const data = exportMemories(db);
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].memory_id).toBe("m1");
  });

  it("import loads memories and entities into a fresh database", () => {
    const sourceDb = createDb();
    insertMemory(sourceDb, "m1", "h1", "fact one");
    insertMemory(sourceDb, "m2", "h2", "fact two");
    insertEntity(sourceDb, "e1", "Alice");

    const data = exportMemories(sourceDb);

    const targetDb = createDb();
    const result = importMemories(targetDb, data);
    expect(result.memoriesImported).toBe(2);
    expect(result.memoriesSkipped).toBe(0);
    expect(result.entitiesImported).toBe(1);
    expect(result.entitiesSkipped).toBe(0);

    const count = targetDb
      .prepare("SELECT COUNT(*) AS cnt FROM memory_current")
      .get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("import skips duplicates by normalized_hash", () => {
    const sourceDb = createDb();
    insertMemory(sourceDb, "m1", "h1", "fact one");
    insertMemory(sourceDb, "m2", "h2", "fact two");

    const data = exportMemories(sourceDb);

    const targetDb = createDb();
    // Pre-insert one memory with same hash
    insertMemory(targetDb, "m-existing", "h1", "already here");

    const result = importMemories(targetDb, data);
    expect(result.memoriesImported).toBe(1); // only m2
    expect(result.memoriesSkipped).toBe(1); // m1 skipped

    const count = targetDb
      .prepare("SELECT COUNT(*) AS cnt FROM memory_current")
      .get() as { cnt: number };
    expect(count.cnt).toBe(2); // m-existing + m2
  });

  it("import skips duplicate entities by entity_id", () => {
    const sourceDb = createDb();
    insertEntity(sourceDb, "e1", "Alice");
    insertEntity(sourceDb, "e2", "Bob");

    const data = exportMemories(sourceDb);

    const targetDb = createDb();
    insertEntity(targetDb, "e1", "Alice");

    const result = importMemories(targetDb, data);
    expect(result.entitiesImported).toBe(1); // only e2
    expect(result.entitiesSkipped).toBe(1); // e1 skipped
  });

  it("import throws on unsupported version", () => {
    const db = createDb();
    expect(() =>
      importMemories(db, { version: 99 as 1, exported_at: "", memories: [], entities: [] }),
    ).toThrow("Unsupported export format version");
  });

  it("roundtrip: export then import preserves data", () => {
    const sourceDb = createDb();
    insertMemory(sourceDb, "m1", "h1", "fact one");
    insertEntity(sourceDb, "e1", "Alice");

    const exported = exportMemories(sourceDb);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json);

    const targetDb = createDb();
    importMemories(targetDb, parsed);

    const reExported = exportMemories(targetDb);
    expect(reExported.memories).toHaveLength(1);
    expect(reExported.memories[0].content).toBe("fact one");
    expect(reExported.entities).toHaveLength(1);
    expect(reExported.entities[0].display_name).toBe("Alice");
  });
});
