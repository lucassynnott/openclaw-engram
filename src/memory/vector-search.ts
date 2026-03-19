import type { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { LcmConfig } from "../db/config.js";
import { normalizeContent } from "./memory-utils.js";
import { getVectorRuntime } from "./vector-runtime.js";

export type SparseVector = {
  dimensions: number;
  indices: number[];
  values: number[];
};

export type MemoryVectorRuntime = {
  native: boolean;
  dimensions: number;
  algorithm: string;
  loadError?: string;
};

const NATIVE_VECTOR_ALGORITHM = "sqlite_vec_dense_v1";
const FALLBACK_VECTOR_ALGORITHM = "hashed_sparse_v1";
const VECTOR_SCHEMA_VERSION = "2";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
]);

const CANONICAL_MAP = new Map<string, string>();
const _nativeVectorState = new WeakMap<DatabaseSync, { loaded: boolean; error?: string }>();

function addCanonicalGroup(root: string, variants: string[]): void {
  for (const variant of [root, ...variants]) {
    CANONICAL_MAP.set(variant, root);
  }
}

addCanonicalGroup("prefer", [
  "prefers",
  "preferred",
  "preference",
  "preferences",
  "like",
  "likes",
  "liked",
  "liking",
  "favor",
  "favours",
  "favour",
  "favors",
  "favorite",
  "favourite",
  "favorites",
  "favourites",
  "choice",
  "choices",
]);
addCanonicalGroup("decide", [
  "decides",
  "decided",
  "decision",
  "decisions",
  "choose",
  "chooses",
  "chosen",
  "select",
  "selects",
  "selected",
  "agreement",
  "agreed",
]);
addCanonicalGroup("build", [
  "builds",
  "built",
  "building",
  "create",
  "creates",
  "created",
  "creating",
  "implement",
  "implements",
  "implemented",
  "implementation",
  "develop",
  "develops",
  "developed",
  "development",
]);
addCanonicalGroup("delete", [
  "deletes",
  "deleted",
  "deleting",
  "remove",
  "removes",
  "removed",
  "removal",
  "erase",
  "erases",
  "erased",
  "purge",
  "purges",
  "purged",
  "wipe",
  "wipes",
  "wiped",
]);
addCanonicalGroup("verify", [
  "verifies",
  "verified",
  "verification",
  "confirm",
  "confirms",
  "confirmed",
  "confirmation",
  "check",
  "checks",
  "checked",
  "audit",
  "audits",
  "audited",
  "proof",
]);
addCanonicalGroup("database", [
  "databases",
  "db",
  "sqlite",
  "postgres",
  "postgresql",
  "mysql",
  "storage",
]);
addCanonicalGroup("backend", [
  "service",
  "services",
  "server",
  "servers",
  "api",
  "apis",
]);
addCanonicalGroup("code", [
  "coding",
  "programming",
  "software",
  "implementation",
  "codebase",
]);
addCanonicalGroup("typescript", ["ts"]);
addCanonicalGroup("javascript", ["js", "node", "nodejs"]);
addCanonicalGroup("person", ["user", "owner", "client", "customer"]);
addCanonicalGroup("project", ["initiative", "program", "product", "system"]);
addCanonicalGroup("drink", ["tea", "coffee", "beverage"]);

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function clampDimensions(value: number): number {
  if (!Number.isFinite(value)) return 384;
  return Math.max(64, Math.min(4096, Math.trunc(value)));
}

function stemToken(token: string): string {
  let normalized = token.toLowerCase();
  if (normalized.endsWith("'s")) normalized = normalized.slice(0, -2);
  if (normalized.endsWith("ies") && normalized.length > 4) normalized = `${normalized.slice(0, -3)}y`;
  else if (normalized.endsWith("ing") && normalized.length > 5) normalized = normalized.slice(0, -3);
  else if (normalized.endsWith("ed") && normalized.length > 4) normalized = normalized.slice(0, -2);
  else if (normalized.endsWith("es") && normalized.length > 4) normalized = normalized.slice(0, -2);
  else if (normalized.endsWith("s") && normalized.length > 3) normalized = normalized.slice(0, -1);
  return CANONICAL_MAP.get(normalized) || normalized;
}

function tokenize(text: string): string[] {
  return normalizeContent(text)
    .split(/\s+/)
    .map((token) => stemToken(token.trim()))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function addFeature(
  accumulator: Map<number, number>,
  feature: string,
  weight: number,
  dimensions: number,
): void {
  if (!feature || !Number.isFinite(weight) || weight === 0) return;
  const hash = fnv1a(feature);
  const index = hash % dimensions;
  const sign = (hash & 1) === 0 ? 1 : -1;
  accumulator.set(index, (accumulator.get(index) || 0) + weight * sign);
}

function buildFeatureMap(text: string, dimensionsRaw: number): {
  dimensions: number;
  features: Map<number, number>;
} {
  const dimensions = clampDimensions(dimensionsRaw);
  const tokens = tokenize(text);
  const features = new Map<number, number>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const baseWeight = Math.min(1.8, 0.75 + token.length * 0.06);
    addFeature(features, `tok:${token}`, baseWeight, dimensions);
    if (token.length >= 4) {
      for (let i = 0; i <= token.length - 3; i += 1) {
        addFeature(features, `tri:${token.slice(i, i + 3)}`, 0.18, dimensions);
      }
    }
    if (index < tokens.length - 1) {
      addFeature(features, `bi:${token}_${tokens[index + 1]}`, 0.58, dimensions);
    }
  }

  return {
    dimensions,
    features,
  };
}

export function createSparseVector(text: string, dimensionsRaw: number): SparseVector {
  const { dimensions, features } = buildFeatureMap(text, dimensionsRaw);
  const sortedByMagnitude = [...features.entries()]
    .filter(([, value]) => Number.isFinite(value) && Math.abs(value) > 1e-9)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, Math.min(256, dimensions));

  let norm = Math.sqrt(sortedByMagnitude.reduce((sum, [, value]) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) norm = 1;

  const normalized = sortedByMagnitude
    .map(([index, value]) => [index, Number((value / norm).toFixed(6))] as const)
    .sort((a, b) => a[0] - b[0]);

  return {
    dimensions,
    indices: normalized.map(([index]) => index),
    values: normalized.map(([, value]) => value),
  };
}

export function createDenseVector(text: string, dimensionsRaw: number): Float32Array {
  const { dimensions, features } = buildFeatureMap(text, dimensionsRaw);
  const vector = new Float32Array(dimensions);
  let sumSquares = 0;

  for (const [index, value] of features.entries()) {
    if (!Number.isFinite(value) || Math.abs(value) <= 1e-9) {
      continue;
    }
    vector[index] = value;
    sumSquares += value * value;
  }

  const norm = Number.isFinite(sumSquares) && sumSquares > 0 ? Math.sqrt(sumSquares) : 1;
  for (let index = 0; index < vector.length; index += 1) {
    if (vector[index] === 0) {
      continue;
    }
    vector[index] = Number((vector[index] / norm).toFixed(6));
  }

  return vector;
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(0));
}

export function serializeDenseVector(vector: Float32Array): string {
  return JSON.stringify(Array.from(vector).map((value) => Number(value.toFixed(6))));
}

export function parseDenseVector(value: unknown): Float32Array | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const numbers = parsed
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
    if (numbers.length === 0) {
      return null;
    }
    return new Float32Array(numbers);
  } catch {
    return null;
  }
}

export function cosineSimilarityDense(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denom) || denom <= 0) {
    return 0;
  }
  return Number(Math.max(-1, Math.min(1, dot / denom)).toFixed(6));
}

export function cosineSimilarity(left: SparseVector, right: SparseVector): number {
  let i = 0;
  let j = 0;
  let dot = 0;
  while (i < left.indices.length && j < right.indices.length) {
    const leftIndex = left.indices[i];
    const rightIndex = right.indices[j];
    if (leftIndex === rightIndex) {
      dot += left.values[i] * right.values[j];
      i += 1;
      j += 1;
      continue;
    }
    if (leftIndex < rightIndex) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return Number(Math.max(-1, Math.min(1, dot)).toFixed(6));
}

export function serializeSparseVector(vector: SparseVector): string {
  return JSON.stringify({
    d: vector.dimensions,
    i: vector.indices,
    v: vector.values,
  });
}

export function parseSparseVector(value: unknown): SparseVector | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as {
      d?: number;
      i?: unknown;
      v?: unknown;
    };
    if (!Array.isArray(parsed.i) || !Array.isArray(parsed.v) || parsed.i.length !== parsed.v.length) {
      return null;
    }
    return {
      dimensions: clampDimensions(Number(parsed.d || 384)),
      indices: parsed.i.map((item) => Math.max(0, Math.trunc(Number(item || 0)))),
      values: parsed.v.map((item) => Number(item || 0)),
    };
  } catch {
    return null;
  }
}

export function vectorBackendEnabled(config: LcmConfig): boolean {
  return String(config.vectorBackend || "").trim().toLowerCase() !== "none";
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1")
    .get(tableName) as { 1?: number } | undefined;
  return Boolean(row);
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function getSchemaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM memory_vector_schema WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

function setSchemaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO memory_vector_schema (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function loadNativeVectorExtension(db: DatabaseSync): { loaded: boolean; error?: string } {
  const cached = _nativeVectorState.get(db);
  if (cached) {
    return cached;
  }

  try {
    sqliteVec.load(db);
    db.prepare("SELECT vec_version()").get();
    const state = { loaded: true };
    _nativeVectorState.set(db, state);
    return state;
  } catch (error) {
    const state = {
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    };
    _nativeVectorState.set(db, state);
    return state;
  }
}

function ensureVectorScaffold(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT '${FALLBACK_VECTOR_ALGORITHM}',
      dimensions INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      dense_embedding_json TEXT,
      embedding_signature TEXT NOT NULL DEFAULT '',
      source_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_updated
      ON memory_vectors(updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_vector_rowids (
      vector_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS memory_vector_schema (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  if (!hasColumn(db, "memory_vectors", "dense_embedding_json")) {
    db.exec("ALTER TABLE memory_vectors ADD COLUMN dense_embedding_json TEXT");
  }
  if (!hasColumn(db, "memory_vectors", "embedding_signature")) {
    db.exec("ALTER TABLE memory_vectors ADD COLUMN embedding_signature TEXT NOT NULL DEFAULT ''");
  }
}

function resetNativeVectorIndex(db: DatabaseSync, dimensions: number): void {
  db.exec("DROP TABLE IF EXISTS memory_vector_index");
  db.exec(`CREATE VIRTUAL TABLE memory_vector_index USING vec0(embedding float[${dimensions}] distance_metric=cosine)`);
  db.exec("DELETE FROM memory_vector_rowids");
  db.exec("DELETE FROM memory_vectors");
  setSchemaValue(db, "dimensions", String(dimensions));
  setSchemaValue(db, "algorithm", NATIVE_VECTOR_ALGORITHM);
  setSchemaValue(db, "schema_version", VECTOR_SCHEMA_VERSION);
}

function ensureVectorRowId(db: DatabaseSync, memoryId: string): number {
  db.prepare(
    `INSERT INTO memory_vector_rowids (memory_id)
     VALUES (?)
     ON CONFLICT(memory_id) DO NOTHING`,
  ).run(memoryId);

  const row = db
    .prepare("SELECT vector_rowid FROM memory_vector_rowids WHERE memory_id = ?")
    .get(memoryId) as { vector_rowid?: number } | undefined;
  const vectorRowId = Number(row?.vector_rowid || 0);
  if (!Number.isFinite(vectorRowId) || vectorRowId <= 0) {
    throw new Error(`Failed to allocate native vector row id for memory '${memoryId}'.`);
  }
  return vectorRowId;
}

export function ensureMemoryVectorTables(
  db: DatabaseSync,
  config?: Pick<LcmConfig, "vectorDimensions">,
): MemoryVectorRuntime {
  const dimensions = clampDimensions(config?.vectorDimensions ?? 1536);
  ensureVectorScaffold(db);

  const nativeState = loadNativeVectorExtension(db);
  if (!nativeState.loaded) {
    return {
      native: false,
      dimensions,
      algorithm: FALLBACK_VECTOR_ALGORITHM,
      loadError: nativeState.error,
    };
  }

  const currentDimensions = Number(getSchemaValue(db, "dimensions") || 0);
  const currentAlgorithm = getSchemaValue(db, "algorithm") || "";
  const currentSchemaVersion = getSchemaValue(db, "schema_version") || "";
  const needsReset =
    !hasTable(db, "memory_vector_index")
    || currentDimensions !== dimensions
    || currentAlgorithm !== NATIVE_VECTOR_ALGORITHM
    || currentSchemaVersion !== VECTOR_SCHEMA_VERSION;

  if (needsReset) {
    resetNativeVectorIndex(db, dimensions);
  }

  return {
    native: true,
    dimensions,
    algorithm: NATIVE_VECTOR_ALGORITHM,
  };
}

function resolveEmbeddingSignature(params: {
  config: LcmConfig;
  runtime: MemoryVectorRuntime;
}): string {
  const vectorRuntime = getVectorRuntime(params.config.databasePath);
  const embedderLabel = vectorRuntime?.embedderLabel?.trim() || "local_dense_v1";
  const externalBackendLabel = vectorRuntime?.externalBackendLabel?.trim() || "none";
  return [
    params.runtime.native ? NATIVE_VECTOR_ALGORITHM : FALLBACK_VECTOR_ALGORITHM,
    `embedder=${embedderLabel}`,
    `external=${externalBackendLabel}`,
    `dims=${params.runtime.dimensions}`,
  ].join("|");
}

export async function resolveDenseVector(params: {
  config: LcmConfig;
  text: string;
  dimensions?: number;
}): Promise<Float32Array> {
  const dimensions = clampDimensions(params.dimensions ?? params.config.vectorDimensions ?? 1536);
  const vectorRuntime = getVectorRuntime(params.config.databasePath);
  const embedded =
    typeof vectorRuntime?.embedText === "function"
      ? await vectorRuntime.embedText(params.text, dimensions)
      : null;
  return embedded && embedded.length > 0 ? embedded : createDenseVector(params.text, dimensions);
}

export async function upsertMemoryVector(params: {
  db: DatabaseSync;
  config: LcmConfig;
  memoryId: string;
  content: string;
  kind?: string | null;
  scope?: string | null;
  status?: string | null;
  contentTime?: string | null;
  archivedAt?: string | null;
  sourceUpdatedAt: string;
}): Promise<{
  sparseVector: SparseVector;
  denseVector: Float32Array;
  runtime: MemoryVectorRuntime;
  embeddingSignature: string;
} | null> {
  if (!vectorBackendEnabled(params.config)) {
    return null;
  }

  const denseVector = await resolveDenseVector({
    config: params.config,
    text: params.content,
    dimensions: params.config.vectorDimensions,
  });
  const runtime = ensureMemoryVectorTables(params.db, {
    vectorDimensions: denseVector.length || params.config.vectorDimensions,
  });
  const sparseVector = createSparseVector(params.content, runtime.dimensions);
  const embeddingSignature = resolveEmbeddingSignature({
    config: params.config,
    runtime,
  });

  params.db.prepare(
    `INSERT INTO memory_vectors (
      memory_id, backend, algorithm, dimensions, embedding_json, dense_embedding_json,
      embedding_signature, source_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(memory_id) DO UPDATE SET
      backend = excluded.backend,
      algorithm = excluded.algorithm,
      dimensions = excluded.dimensions,
      embedding_json = excluded.embedding_json,
      dense_embedding_json = excluded.dense_embedding_json,
      embedding_signature = excluded.embedding_signature,
      source_updated_at = excluded.source_updated_at,
      updated_at = datetime('now')`,
  ).run(
    params.memoryId,
    runtime.native ? "sqlite_vec_native" : String(params.config.vectorBackend || "sqlite_vec"),
    runtime.algorithm,
    runtime.dimensions,
    serializeSparseVector(sparseVector),
    serializeDenseVector(denseVector),
    embeddingSignature,
    params.sourceUpdatedAt,
  );

  if (runtime.native) {
    const vectorRowId = ensureVectorRowId(params.db, params.memoryId);
    params.db.prepare("DELETE FROM memory_vector_index WHERE rowid = ?").run(BigInt(vectorRowId));
    params.db.prepare(
      "INSERT INTO memory_vector_index(rowid, embedding) VALUES (?, ?)",
    ).run(BigInt(vectorRowId), vectorToBlob(denseVector));
  }

  const vectorRuntime = getVectorRuntime(params.config.databasePath);
  if (typeof vectorRuntime?.upsertExternalMemoryVector === "function") {
    await vectorRuntime.upsertExternalMemoryVector({
      memoryId: params.memoryId,
      denseVector,
      content: params.content,
      kind: params.kind,
      scope: params.scope,
      status: params.status,
      contentTime: params.contentTime,
      archivedAt: params.archivedAt,
      updatedAt: params.sourceUpdatedAt,
    });
  }

  return {
    sparseVector,
    denseVector,
    runtime,
    embeddingSignature,
  };
}

export async function reindexMemoryVectorById(params: {
  db: DatabaseSync;
  config: LcmConfig;
  memoryId: string;
}): Promise<boolean> {
  if (!vectorBackendEnabled(params.config)) {
    return false;
  }

  const row = params.db
    .prepare(
      `SELECT memory_id, type, content, scope, status, content_time, archived_at, updated_at, created_at
       FROM memory_current
       WHERE memory_id = ?
       LIMIT 1`,
    )
    .get(params.memoryId) as
      | {
          memory_id?: string;
          type?: string;
          content?: string;
          scope?: string;
          status?: string;
          content_time?: string | null;
          archived_at?: string | null;
          updated_at?: string;
          created_at?: string;
        }
      | undefined;
  if (!row?.memory_id || !row.content) {
    return false;
  }

  await upsertMemoryVector({
    db: params.db,
    config: params.config,
    memoryId: row.memory_id,
    content: row.content,
    kind: row.type ?? null,
    scope: row.scope ?? null,
    status: row.status ?? null,
    contentTime: row.content_time ?? null,
    archivedAt: row.archived_at ?? null,
    sourceUpdatedAt: row.updated_at || row.created_at || new Date().toISOString(),
  });
  return true;
}
