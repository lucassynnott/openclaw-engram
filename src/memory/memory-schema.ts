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

function backfillMemoryLifecycleFields(db: DatabaseSync): void {
  db.exec(`
    UPDATE memory_current
    SET truth_confidence = COALESCE(confidence, truth_confidence, 0.75)
    WHERE truth_confidence IS NULL
       OR COALESCE(NULLIF(activation_seed, ''), '') = '';

    UPDATE memory_current
    SET first_seen_at = COALESCE(first_seen_at, created_at, updated_at, content_time, last_reviewed_at)
    WHERE first_seen_at IS NULL;

    UPDATE memory_current
    SET last_seen_at = COALESCE(last_seen_at, updated_at, last_reviewed_at, content_time, created_at, first_seen_at)
    WHERE last_seen_at IS NULL;

    UPDATE memory_current
    SET last_reinforced_at = COALESCE(last_reinforced_at, last_reviewed_at, updated_at, content_time, created_at, last_seen_at)
    WHERE last_reinforced_at IS NULL
      AND COALESCE(status, 'active') <> 'superseded';

    UPDATE memory_current
    SET last_retrieved_at = COALESCE(last_retrieved_at, last_reviewed_at, updated_at, content_time, created_at)
    WHERE last_retrieved_at IS NULL
      AND COALESCE(retrieval_count, 0) > 0;

    UPDATE memory_current
    SET retrieval_count = COALESCE(retrieval_count, 0)
    WHERE retrieval_count IS NULL;

    UPDATE memory_current
    SET decay_exempt = COALESCE(decay_exempt, 0)
    WHERE decay_exempt IS NULL;

    UPDATE memory_current
    SET activation_seed = 'backfill'
    WHERE COALESCE(NULLIF(activation_seed, ''), '') = '';

    UPDATE memory_current
    SET reinforcement_count = CASE
      WHEN COALESCE(reinforcement_count, 0) > 0 THEN reinforcement_count
      WHEN COALESCE(status, 'active') = 'active' THEN 1
      ELSE 0
    END
    WHERE reinforcement_count IS NULL
       OR reinforcement_count = 0;

    UPDATE memory_current
    SET activation_strength = ROUND(
      CASE
        WHEN COALESCE(status, 'active') = 'active' THEN
          MIN(
            1.0,
            MAX(
              0.35,
              COALESCE(truth_confidence, confidence, 0.75) * 0.62 +
              COALESCE(value_score, 0.5) * 0.38
            )
          )
        ELSE
          MIN(
            1.0,
            MAX(
              0.08,
              COALESCE(truth_confidence, confidence, 0.75) * 0.28 +
              COALESCE(value_score, 0.3) * 0.22
            )
          )
      END,
      4
    )
    WHERE COALESCE(activation_strength, 0) <= 0;
  `);
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
      truth_confidence REAL DEFAULT 0.75,
      activation_strength REAL NOT NULL DEFAULT 0,
      activation_seed TEXT,
      reinforcement_count INTEGER NOT NULL DEFAULT 0,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      last_reinforced_at TEXT,
      last_retrieved_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      decay_exempt INTEGER NOT NULL DEFAULT 0,
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
  ensureColumn(db, "memory_current", "truth_confidence REAL DEFAULT 0.75", "truth_confidence");
  ensureColumn(db, "memory_current", "activation_strength REAL NOT NULL DEFAULT 0", "activation_strength");
  ensureColumn(db, "memory_current", "activation_seed TEXT", "activation_seed");
  ensureColumn(db, "memory_current", "reinforcement_count INTEGER NOT NULL DEFAULT 0", "reinforcement_count");
  ensureColumn(db, "memory_current", "retrieval_count INTEGER NOT NULL DEFAULT 0", "retrieval_count");
  ensureColumn(db, "memory_current", "last_reinforced_at TEXT", "last_reinforced_at");
  ensureColumn(db, "memory_current", "last_retrieved_at TEXT", "last_retrieved_at");
  ensureColumn(db, "memory_current", "first_seen_at TEXT", "first_seen_at");
  ensureColumn(db, "memory_current", "last_seen_at TEXT", "last_seen_at");
  ensureColumn(db, "memory_current", "decay_exempt INTEGER NOT NULL DEFAULT 0", "decay_exempt");
  backfillMemoryLifecycleFields(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_current_source
      ON memory_current(source_layer, source_path, source_line);
  `);

  initialized.set(db, true);
}
