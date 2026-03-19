import type { DatabaseSync } from "node:sqlite";

const initialized = new WeakMap<DatabaseSync, boolean>();

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => String(row.name || "").trim() === columnName);
}

function ensureColumn(db: DatabaseSync, tableName: string, columnSql: string, columnName: string): void {
  if (hasColumn(db, tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
}

export function ensureMemoryTables(db: DatabaseSync): void {
  if (initialized.has(db)) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_current (
      memory_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'CONTEXT',
      content TEXT NOT NULL,
      normalized TEXT NOT NULL DEFAULT '',
      normalized_hash TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      source_agent TEXT,
      source_session TEXT,
      source_trigger TEXT,
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
      provenance TEXT NOT NULL DEFAULT '{}',
      superseded_by TEXT,
      content_time TEXT,
      valid_until TEXT,
      source_layer TEXT NOT NULL DEFAULT 'registry',
      source_path TEXT,
      source_line INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_current_status_scope
      ON memory_current(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memory_current_norm
      ON memory_current(normalized_hash, scope, status);
    CREATE INDEX IF NOT EXISTS idx_memory_current_type
      ON memory_current(type, status);

    CREATE TABLE IF NOT EXISTS memory_episodes (
      episode_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      primary_entity_id TEXT,
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_entity
      ON memory_episodes(primary_entity_id, start_date);

    CREATE TABLE IF NOT EXISTS memory_events (
      event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      component TEXT NOT NULL DEFAULT 'memory_add',
      action TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_memory_ts
      ON memory_events(memory_id, timestamp);

    CREATE TABLE IF NOT EXISTS memory_triggers (
      trigger_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      matcher TEXT NOT NULL DEFAULT 'substring',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_triggers_memory
      ON memory_triggers(memory_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_memory_triggers_pattern
      ON memory_triggers(pattern, enabled);

    CREATE TABLE IF NOT EXISTS memory_entities (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'person',
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_name
      ON memory_entities(normalized_name);
  `);

  ensureColumn(db, "memory_current", "source_trigger TEXT", "source_trigger");
  ensureColumn(db, "memory_current", "provenance TEXT NOT NULL DEFAULT '{}'", "provenance");
  ensureColumn(db, "memory_current", "source_layer TEXT NOT NULL DEFAULT 'registry'", "source_layer");
  ensureColumn(db, "memory_current", "source_path TEXT", "source_path");
  ensureColumn(db, "memory_current", "source_line INTEGER", "source_line");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_current_source
      ON memory_current(source_layer, source_path, source_line);
  `);

  initialized.set(db, true);
}
