import type { DatabaseSync } from "node:sqlite";

/**
 * Portable export format for Engram memories and entities.
 */
export type EngramExport = {
  version: 1;
  exported_at: string;
  memories: MemoryRow[];
  entities: EntityRow[];
};

export type MemoryRow = {
  memory_id: string;
  type: string;
  content: string;
  normalized: string;
  normalized_hash: string;
  source: string;
  source_agent: string | null;
  source_session: string | null;
  source_trigger: string | null;
  confidence: number | null;
  truth_confidence?: number | null;
  activation_strength?: number | null;
  activation_seed?: string | null;
  reinforcement_count?: number | null;
  retrieval_count?: number | null;
  last_reinforced_at?: string | null;
  last_retrieved_at?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  decay_exempt?: number | null;
  scope: string;
  status: string;
  value_score: number | null;
  value_label: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  last_reviewed_at: string | null;
  tags: string;
  provenance: string;
  superseded_by: string | null;
  content_time: string | null;
  valid_until: string | null;
  source_layer: string;
  source_path: string | null;
  source_line: number | null;
};

export type EntityRow = {
  entity_id: string;
  kind: string;
  display_name: string;
  normalized_name: string;
  status: string;
  confidence: number;
  created_at: string;
  updated_at: string;
};

/**
 * Export all active memories and entities from the database.
 */
export function exportMemories(db: DatabaseSync): EngramExport {
  const memories = db
    .prepare("SELECT * FROM memory_current WHERE status = 'active'")
    .all() as MemoryRow[];

  const entities = db
    .prepare("SELECT * FROM memory_entities WHERE status = 'active'")
    .all() as EntityRow[];

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    memories,
    entities,
  };
}

export type ImportResult = {
  memoriesImported: number;
  memoriesSkipped: number;
  entitiesImported: number;
  entitiesSkipped: number;
};

/**
 * Import memories and entities from a portable JSON export.
 * Duplicates are detected by normalized_hash for memories and entity_id for
 * entities.  Duplicate rows are silently skipped.
 */
export function importMemories(db: DatabaseSync, data: EngramExport): ImportResult {
  const result: ImportResult = {
    memoriesImported: 0,
    memoriesSkipped: 0,
    entitiesImported: 0,
    entitiesSkipped: 0,
  };

  if (!data || data.version !== 1) {
    throw new Error("Unsupported export format version");
  }

  // Build a set of existing normalized_hash values for dedup.
  const existingHashes = new Set<string>();
  const hashRows = db
    .prepare("SELECT normalized_hash FROM memory_current WHERE normalized_hash != ''")
    .all() as Array<{ normalized_hash: string }>;
  for (const row of hashRows) {
    existingHashes.add(row.normalized_hash);
  }

  const insertMemory = db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash,
      source, source_agent, source_session, source_trigger,
      confidence, truth_confidence, activation_strength, activation_seed,
      reinforcement_count, retrieval_count, last_reinforced_at, last_retrieved_at,
      first_seen_at, last_seen_at, decay_exempt, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, last_reviewed_at,
      tags, provenance, superseded_by, content_time, valid_until,
      source_layer, source_path, source_line
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  for (const mem of data.memories ?? []) {
    if (mem.normalized_hash && existingHashes.has(mem.normalized_hash)) {
      result.memoriesSkipped++;
      continue;
    }
    try {
      insertMemory.run(
        mem.memory_id, mem.type, mem.content, mem.normalized, mem.normalized_hash,
        mem.source, mem.source_agent, mem.source_session, mem.source_trigger,
        mem.confidence,
        mem.truth_confidence ?? mem.confidence ?? 0.75,
        mem.activation_strength ?? 0,
        mem.activation_seed ?? null,
        mem.reinforcement_count ?? 0,
        mem.retrieval_count ?? 0,
        mem.last_reinforced_at ?? null,
        mem.last_retrieved_at ?? null,
        mem.first_seen_at ?? mem.created_at ?? null,
        mem.last_seen_at ?? mem.updated_at ?? null,
        mem.decay_exempt ?? 0,
        mem.scope, mem.status, mem.value_score, mem.value_label,
        mem.created_at, mem.updated_at, mem.archived_at, mem.last_reviewed_at,
        mem.tags, mem.provenance, mem.superseded_by, mem.content_time, mem.valid_until,
        mem.source_layer, mem.source_path, mem.source_line,
      );
      result.memoriesImported++;
      if (mem.normalized_hash) {
        existingHashes.add(mem.normalized_hash);
      }
    } catch {
      // Primary key conflict or other constraint — treat as duplicate.
      result.memoriesSkipped++;
    }
  }

  // Import entities by entity_id.
  const existingEntityIds = new Set<string>();
  const entityRows = db
    .prepare("SELECT entity_id FROM memory_entities")
    .all() as Array<{ entity_id: string }>;
  for (const row of entityRows) {
    existingEntityIds.add(row.entity_id);
  }

  const insertEntity = db.prepare(`
    INSERT INTO memory_entities (
      entity_id, kind, display_name, normalized_name,
      status, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ent of data.entities ?? []) {
    if (existingEntityIds.has(ent.entity_id)) {
      result.entitiesSkipped++;
      continue;
    }
    try {
      insertEntity.run(
        ent.entity_id, ent.kind, ent.display_name, ent.normalized_name,
        ent.status, ent.confidence, ent.created_at, ent.updated_at,
      );
      result.entitiesImported++;
      existingEntityIds.add(ent.entity_id);
    } catch {
      result.entitiesSkipped++;
    }
  }

  return result;
}
