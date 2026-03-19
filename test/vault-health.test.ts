import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import {
  buildVaultSurface,
  inspectVaultHealth,
  renderVaultBuildMarkdown,
} from "../src/surface/vault-mirror.js";
import { makeTestConfig } from "./test-config.js";

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-vault-health-"));
  tempDirs.add(dir);
  return dir;
}

function makeConfig(overrides: Partial<LcmConfig> = {}): LcmConfig {
  return makeTestConfig({
    databasePath: join(makeTempDir(), "engram.db"),
    vaultEnabled: true,
    vaultPath: makeTempDir(),
    vaultSubdir: "Engram",
    ...overrides,
  });
}

afterEach(() => {
  for (const dbPath of dbPaths) closeLcmConnection(dbPath);
  dbPaths.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("vault health reporting", () => {
  it("reports last sync stats from the most recent vault build", () => {
    const config = makeConfig();
    dbPaths.add(config.databasePath);
    const db = getLcmConnection(config.databasePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT,
        bootstrapped_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        earliest_at TEXT,
        latest_at TEXT,
        descendant_count INTEGER NOT NULL DEFAULT 0,
        descendant_token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        file_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );
    `);
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, title, created_at, updated_at)
       VALUES (1, 'agent:main:main', 'Main', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (
         summary_id, conversation_id, kind, depth, content, token_count,
         earliest_at, latest_at, descendant_count, descendant_token_count, created_at, file_ids
       )
       VALUES (
         'sum_1', 1, 'leaf', 0, 'Vault sync summary', 42,
         datetime('now'), datetime('now'), 0, 0, datetime('now'), '[]'
       )`,
    ).run();
    db.prepare(
      `INSERT INTO entities (
         entity_id, kind, display_name, normalized_name, aliases, status, confidence, created_at, updated_at, payload
       )
       VALUES
       ('ent_1', 'person', 'Johnny Silverhand', 'johnny silverhand', '["johnny"]', 'active', 0.9, datetime('now'), datetime('now'), '{}'),
       ('ent_2', 'person', 'Johnny', 'johnny', '["johnny silverhand"]', 'active', 0.8, datetime('now'), datetime('now'), '{}')`,
    ).run();

    const summary = buildVaultSurface({ db, config });
    const health = inspectVaultHealth({ db, config });
    const report = renderVaultBuildMarkdown({
      timestamp: summary.generated_at,
      runId: summary.run_id,
      summary,
    });

    expect(health.subdir).toBe("Engram");
    expect(health.vault.last_built_at).toBeTruthy();
    expect(health.vault.items_synced).toBeGreaterThanOrEqual(0);
    expect(health.vault.generated_files).toBeGreaterThan(0);
    expect(health.vault.merge_suggestions?.count).toBeGreaterThan(0);
    expect(report).toContain("Entity Merge Suggestions");
  });

  it("rejects recursive vault roots that would create Engram/Engram nesting", () => {
    const root = makeTempDir();
    const config = makeConfig({
      vaultPath: join(root, "Engram"),
      vaultSubdir: "Engram",
    });
    dbPaths.add(config.databasePath);
    const db = getLcmConnection(config.databasePath);

    expect(() => buildVaultSurface({ db, config })).toThrow(/recursive/i);
  });
});
