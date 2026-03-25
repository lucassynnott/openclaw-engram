import type { DatabaseSync } from "node:sqlite";
import { getLcmDbFeatures } from "../db/features.js";
import type { LcmConfig } from "../db/config.js";
import { ensureWorldModelReady, findEntityMatches, getEntityDetail } from "../entity/world-model.js";
import { computeActivationStrength } from "../memory/activation.js";
import { isActivationModelEnabledForSeed } from "../memory/activation-rollout.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import { sanitizeFts5Query } from "../memory/store/fts5-sanitize.js";
import {
  cosineSimilarity,
  cosineSimilarityDense,
  ensureMemoryVectorTables,
  parseDenseVector,
  parseSparseVector,
  resolveDenseVector,
  upsertMemoryVector,
  vectorBackendEnabled,
  createSparseVector,
  vectorToBlob,
} from "../memory/vector-search.js";
import { getVectorRuntime } from "../memory/vector-runtime.js";

export type MemoryRecallCandidate = {
  id: string;
  type: string;
  content: string;
  scope: string;
  confidence: number;
  activation: number;
  effectiveConfidence: number;
  valueScore: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  contentTime: string | null;
  validUntil: string | null;
  sourceAgent: string | null;
  status: string;
  archivedAt: string | null;
  entityLockMatched: boolean;
  score: number;
  scoreBreakdown: {
    confidence: number;
    activation: number;
    value: number;
    lexical: number;
    vector: number;
    temporal: number;
    entity: number;
    typeMultiplier: number;
  };
  vectorSimilarity: number;
  estimatedTokens: number;
};

const CONFIDENCE_SCORE_WEIGHT = 0.5;
const VALUE_SCORE_WEIGHT = 0.18;
const FALLBACK_ACTIVATION_HALF_LIFE_DAYS = 14;
const FALLBACK_ACTIVATION_FLOOR = 0.45;
const EXPIRED_ACTIVATION = 0.35;

const MEMORY_SELECT_REQUIRED_COLUMNS = [
  "memory_id",
  "type",
  "content",
  "scope",
  "confidence",
  "value_score",
  "tags",
  "created_at",
  "updated_at",
  "content_time",
  "valid_until",
  "status",
  "archived_at",
  "source_agent",
] as const;
const MEMORY_SELECT_OPTIONAL_COLUMNS = [
  "truth_confidence",
  "activation_strength",
  "reinforcement_count",
  "retrieval_count",
  "last_reinforced_at",
  "last_retrieved_at",
  "first_seen_at",
  "last_seen_at",
  "decay_exempt",
  "last_reviewed_at",
  "activation",
  "retrievability",
  "retrieval_score",
  "activation_score",
  "recall_activation",
  "last_accessed_at",
  "access_count",
  "review_count",
  "strength",
] as const;
const ACTIVATION_SIGNAL_COLUMNS = [
  "activation_strength",
  "activation",
  "recall_activation",
  "retrievability",
  "retrieval_score",
  "activation_score",
] as const;
const memoryCurrentColumnsCache = new WeakMap<DatabaseSync, Set<string>>();
const memoryCurrentSelectColumnsCache = new WeakMap<DatabaseSync, string[]>();

// ── Type-based score multipliers ─────────────────────────────────────────────
// Applied as a post-hoc multiplier on the composite score to bias ranking
// toward high-signal memory types and away from verbose low-signal ones.
const TYPE_SCORE_MULTIPLIERS: Record<string, number> = {
  PREFERENCE: 1.3,
  DECISION: 1.2,
  USER_FACT: 1.0,
  AGENT_IDENTITY: 1.0,
  ENTITY: 0.9,
  CONTEXT: 0.8,
  EPISODE: 0.6,
};
const DEFAULT_TYPE_MULTIPLIER = 1.0;

// Extra penalty multiplier applied on top of the type multiplier when the
// content matches heartbeat / status-dump patterns.
const HEARTBEAT_PENALTY_MULTIPLIER = 0.5;
const HEARTBEAT_PATTERNS = [
  /\bheartbeat\b/i,
  /\bHEARTBEAT_OK\b/,
  /\bhealth remains clean\b/i,
  /\bheartbeat status\b/i,
  /\bsystem health check\b/i,
  /\bstatus dump\b/i,
];

type FetchMemoryCandidatesOptions = {
  config?: LcmConfig;
  query: string;
  topK: number;
  minScore: number;
  maxTokens: number;
  scope?: string;
  allScopes?: boolean;
  kind?: string;
  includeArchived?: boolean;
  archiveFallback?: boolean;
  entityLockEnabled?: boolean;
  entityId?: string;
  afterDate?: string | null;
  beforeDate?: string | null;
};

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toFiniteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseIsoDateMs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function getMemoryCurrentColumnSet(db: DatabaseSync): Set<string> {
  const cached = memoryCurrentColumnsCache.get(db);
  if (cached) {
    return cached;
  }
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(memory_current)").all() as Array<{ name?: string }>
    )
      .map((row) => String(row.name || "").trim())
      .filter(Boolean),
  );
  memoryCurrentColumnsCache.set(db, columns);
  return columns;
}

function getMemoryCurrentSelectColumns(db: DatabaseSync): string[] {
  const cached = memoryCurrentSelectColumnsCache.get(db);
  if (cached) {
    return cached;
  }
  const columns = getMemoryCurrentColumnSet(db);
  const selected = [
    ...MEMORY_SELECT_REQUIRED_COLUMNS.filter((column) => columns.has(column)),
    ...MEMORY_SELECT_OPTIONAL_COLUMNS.filter((column) => columns.has(column)),
  ];
  memoryCurrentSelectColumnsCache.set(db, selected);
  return selected;
}

function buildMemorySelectClause(db: DatabaseSync, tableAlias: string): string {
  return getMemoryCurrentSelectColumns(db).map((column) => `${tableAlias}.${column}`).join(", ");
}

export function estimateTokenCount(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function ensureMemoryRecallTables(db: DatabaseSync): void {
  memoryCurrentColumnsCache.delete(db);
  memoryCurrentSelectColumnsCache.delete(db);
  ensureMemoryTables(db);
}

function normalizeQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function resolveEntityLockTerms(
  db: DatabaseSync,
  query: string,
  entityId: string | undefined,
  enabled: boolean,
  config?: LcmConfig,
): string[] {
  if (!enabled) {
    return [];
  }
  if (config) {
    try {
      ensureWorldModelReady({ db, config });
    } catch {
      // World-model refresh is best-effort during recall.
    }
  }
  if (entityId) {
    const detail = getEntityDetail(db, entityId);
    if (detail) {
      const aliases = Array.isArray(detail.aliases)
        ? detail.aliases.filter((item): item is string => typeof item === "string")
        : [];
      return [String(detail.display_name || ""), ...aliases].filter(Boolean);
    }
  }
  const matches = findEntityMatches(db, query, { limit: 2 });
  if (matches.length === 0) {
    return [];
  }
  return Array.from(
    new Set(
      matches
        .flatMap((match) => [String(match.display_name || ""), String(match.alias || "")])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function buildWhereClause(options: FetchMemoryCandidatesOptions): {
  where: string[];
  params: Array<string | number | null>;
} {
  return buildQualifiedWhereClause(options);
}

function buildQualifiedWhereClause(
  options: FetchMemoryCandidatesOptions,
  tableAlias?: string,
): {
  where: string[];
  params: Array<string | number | null>;
} {
  const where: string[] = [];
  const params: Array<string | number | null> = [];
  const prefix = tableAlias ? `${tableAlias}.` : "";

  if (!options.includeArchived) {
    where.push(`${prefix}status = 'active'`);
  }
  if (!options.allScopes) {
    where.push(`${prefix}scope = ?`);
    params.push(options.scope?.trim() || "shared");
  }
  if (options.kind) {
    where.push(`${prefix}type = ?`);
    params.push(options.kind);
  }
  if (options.afterDate) {
    where.push(`(${prefix}content_time IS NULL OR ${prefix}content_time >= ?)`);
    params.push(options.afterDate);
  }
  if (options.beforeDate) {
    where.push(`(${prefix}content_time IS NULL OR ${prefix}content_time <= ?)`);
    params.push(options.beforeDate);
  }
  return { where, params };
}

function queryRows(
  db: DatabaseSync,
  query: string,
  options: FetchMemoryCandidatesOptions,
  includeArchived: boolean,
): Array<Record<string, unknown>> {
  const features = getLcmDbFeatures(db);
  const candidateLimit = Math.max(options.topK * 6, 24);
  const { where, params } = buildQualifiedWhereClause({ ...options, includeArchived }, "m");
  const selectedColumns = buildMemorySelectClause(db, "m");
  const selected = `
    SELECT ${selectedColumns}
    FROM memory_current m
  `;

  if (features.fts5Available) {
    try {
      const ftsQuery = sanitizeFts5Query(query);
      return db
        .prepare(
          `${selected}
           WHERE ${[...where, "m.memory_id IN (SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?)"].join(" AND ")}
           ORDER BY m.confidence DESC, COALESCE(m.content_time, m.created_at) DESC, m.created_at DESC
           LIMIT ?`,
        )
        .all(...params, ftsQuery, candidateLimit) as Array<Record<string, unknown>>;
    } catch {
      // Fall through to LIKE fallback.
    }
  }

  const tokens = normalizeQueryTokens(query).slice(0, 6);
  const likeTerms = tokens.length > 0 ? tokens : [query.trim()];
  const likeWhere = likeTerms.map(() => "(content LIKE ? OR tags LIKE ?)");
  const likeParams = likeTerms.flatMap((term) => [`%${term}%`, `%${term}%`]);
  return db
    .prepare(
      `${selected}
       WHERE ${[...where, ...likeWhere].join(" AND ")}
       ORDER BY m.confidence DESC, COALESCE(m.content_time, m.created_at) DESC, m.created_at DESC
       LIMIT ?`,
    )
    .all(...params, ...likeParams, candidateLimit) as Array<Record<string, unknown>>;
}

function loadRowsByMemoryIds(
  db: DatabaseSync,
  memoryIds: string[],
): Array<Record<string, unknown>> {
  if (memoryIds.length === 0) {
    return [];
  }
  const selectedColumns = buildMemorySelectClause(db, "m");
  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ${selectedColumns}
       FROM memory_current m
       WHERE m.memory_id IN (${placeholders})`,
    )
    .all(...memoryIds) as Array<Record<string, unknown>>;
  const byId = new Map(rows.map((row) => [String(row.memory_id || ""), row]));
  return memoryIds.map((memoryId) => byId.get(memoryId)).filter((row): row is Record<string, unknown> => !!row);
}

async function queryVectorRows(
  db: DatabaseSync,
  query: string,
  options: FetchMemoryCandidatesOptions,
  includeArchived: boolean,
): Promise<{
  rows: Array<Record<string, unknown>>;
  similarities: Map<string, number>;
  backfilled: number;
}> {
  if (!options.config || !vectorBackendEnabled(options.config)) {
    return {
      rows: [],
      similarities: new Map<string, number>(),
      backfilled: 0,
    };
  }

  const initialRuntime = ensureMemoryVectorTables(db, options.config);
  const vectorRuntime = getVectorRuntime(options.config.databasePath);
  const denseQueryVector = await resolveDenseVector({
    config: options.config,
    text: query,
    dimensions: initialRuntime.dimensions,
  });
  const runtime = ensureMemoryVectorTables(db, {
    vectorDimensions: denseQueryVector.length || initialRuntime.dimensions,
  });
  const queryVector = createSparseVector(query, runtime.dimensions);
  const scanLimit = Math.max(options.topK * 160, 800);
  const { where, params } = buildQualifiedWhereClause({ ...options, includeArchived }, "m");
  const selectedColumns = buildMemorySelectClause(db, "m");
  const rows = db
    .prepare(
      `SELECT ${selectedColumns},
              v.embedding_json, v.dense_embedding_json, v.source_updated_at AS vector_source_updated_at,
              v.algorithm AS vector_algorithm, v.dimensions AS vector_dimensions,
              v.embedding_signature
       FROM memory_current m
       LEFT JOIN memory_vectors v ON v.memory_id = m.memory_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(m.content_time, m.updated_at, m.created_at) DESC, m.confidence DESC
       LIMIT ?`,
    )
    .all(...params, scanLimit) as Array<Record<string, unknown>>;

  const ranked: Array<Record<string, unknown>> = [];
  const similarities = new Map<string, number>();
  let backfilled = 0;
  const expectedSignature = [
    runtime.algorithm,
    `embedder=${vectorRuntime?.embedderLabel?.trim() || "local_dense_v1"}`,
    `external=${vectorRuntime?.externalBackendLabel?.trim() || "none"}`,
    `dims=${runtime.dimensions}`,
  ].join("|");

  for (const row of rows) {
    const memoryId = String(row.memory_id || "");
    if (!memoryId) {
      continue;
    }
    const sourceUpdatedAt = String(row.updated_at || row.created_at || "");
    const sparseVector =
      typeof row.embedding_json === "string"
      && row.vector_source_updated_at === sourceUpdatedAt
      && Number(row.vector_dimensions || 0) === runtime.dimensions
      && String(row.embedding_signature || "") === expectedSignature
        ? parseSparseVector(row.embedding_json)
        : null;
    const denseVector =
      typeof row.dense_embedding_json === "string"
      && row.vector_source_updated_at === sourceUpdatedAt
      && Number(row.vector_dimensions || 0) === runtime.dimensions
      && String(row.embedding_signature || "") === expectedSignature
        ? parseDenseVector(row.dense_embedding_json)
        : null;
    if (!sparseVector || !denseVector) {
      const indexed = await upsertMemoryVector({
        db,
        config: options.config,
        memoryId,
        content: String(row.content || ""),
        kind: typeof row.type === "string" ? row.type : undefined,
        scope: typeof row.scope === "string" ? row.scope : undefined,
        status: typeof row.status === "string" ? row.status : undefined,
        contentTime: typeof row.content_time === "string" ? row.content_time : null,
        archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
        sourceUpdatedAt,
      });
      if (indexed) {
        backfilled += 1;
      }
    }
  }

  if (typeof vectorRuntime?.queryExternalNeighbors === "function") {
    try {
      const neighbors = await vectorRuntime.queryExternalNeighbors({
        denseVector: denseQueryVector,
        topK: options.topK,
        scope: options.scope,
        allScopes: options.allScopes,
        kind: options.kind,
        includeArchived,
        afterDate: options.afterDate,
        beforeDate: options.beforeDate,
      });
      const orderedIds = neighbors.map((neighbor) => neighbor.memoryId).filter(Boolean);
      const externalRows = loadRowsByMemoryIds(db, orderedIds);
      if (externalRows.length > 0) {
        for (const neighbor of neighbors) {
          similarities.set(neighbor.memoryId, neighbor.similarity);
        }
        return {
          rows: externalRows,
          similarities,
          backfilled,
        };
      }
    } catch {
      // Fall back to local sqlite-vec / JS similarity paths.
    }
  }

  if (runtime.native && denseQueryVector.length > 0) {
    const nativeLimit = Math.max(options.topK * 24, 160);
    const nativeRows = db
      .prepare(
        `WITH knn AS (
           SELECT rowid, distance
           FROM memory_vector_index
           WHERE embedding MATCH ? AND k = ?
         )
         SELECT ${selectedColumns},
                knn.distance AS vector_distance
         FROM knn
         JOIN memory_vector_rowids r ON r.vector_rowid = knn.rowid
         JOIN memory_current m ON m.memory_id = r.memory_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY knn.distance ASC, m.confidence DESC,
                  COALESCE(m.content_time, m.updated_at, m.created_at) DESC
         LIMIT ?`,
      )
      .all(
        vectorToBlob(denseQueryVector),
        nativeLimit,
        ...params,
        Math.max(options.topK * 8, 24),
      ) as Array<Record<string, unknown>>;

    if (nativeRows.length > 0) {
      for (const row of nativeRows) {
        const memoryId = String(row.memory_id || "");
        const distance = Number(row.vector_distance || 1);
        similarities.set(memoryId, Math.max(0, Math.min(1, 1 - distance)));
      }
      return {
        rows: nativeRows,
        similarities,
        backfilled,
      };
    }
  }

  for (const row of rows) {
    const memoryId = String(row.memory_id || "");
    if (!memoryId) {
      continue;
    }
    const denseVector = parseDenseVector(row.dense_embedding_json);
    if (denseVector && denseVector.length === denseQueryVector.length) {
      const similarity = cosineSimilarityDense(denseQueryVector, denseVector);
      if (similarity > 0.035) {
        similarities.set(memoryId, similarity);
        ranked.push(row);
        continue;
      }
    }
    const sparseVector = parseSparseVector(row.embedding_json);
    if (sparseVector) {
      const similarity = cosineSimilarity(queryVector, sparseVector);
      if (similarity > 0.035) {
        similarities.set(memoryId, similarity);
        ranked.push(row);
      }
    }
  }

  ranked.sort((left, right) => {
    const leftSimilarity = similarities.get(String(left.memory_id || "")) || 0;
    const rightSimilarity = similarities.get(String(right.memory_id || "")) || 0;
    return rightSimilarity - leftSimilarity
      || Number(right.confidence || 0) - Number(left.confidence || 0)
      || String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""));
  });

  return {
    rows: ranked.slice(0, Math.max(options.topK * 8, 24)),
    similarities,
    backfilled,
  };
}

function resolveLegacyActivation(row: Record<string, unknown>): number {
  const nowMs = Date.now();
  const validUntil = parseIsoDateMs(row.valid_until);
  if (Number.isFinite(validUntil) && validUntil < nowMs) {
    return EXPIRED_ACTIVATION;
  }

  const freshnessAnchor = [
    row.last_reviewed_at,
    row.updated_at,
    row.content_time,
    row.created_at,
  ]
    .map((value) => parseIsoDateMs(value))
    .find((value) => Number.isFinite(value));
  if (!Number.isFinite(freshnessAnchor)) {
    return 1;
  }

  const ageDays = Math.max(0, (nowMs - Number(freshnessAnchor)) / (24 * 60 * 60 * 1000));
  const activation = Math.max(
    FALLBACK_ACTIVATION_FLOOR,
    Math.pow(0.5, ageDays / FALLBACK_ACTIVATION_HALF_LIFE_DAYS),
  );
  return Number(activation.toFixed(4));
}

function resolveTruthConfidence(row: Record<string, unknown>, activationModelEnabled: boolean): number {
  if (!activationModelEnabled) {
    return clamp01(toFiniteNumber(row.confidence) ?? 0);
  }
  const explicitTruth = toFiniteNumber(row.truth_confidence);
  if (typeof explicitTruth === "number") {
    return clamp01(explicitTruth);
  }
  return clamp01(toFiniteNumber(row.confidence) ?? 0);
}

function resolveStoredActivation(
  row: Record<string, unknown>,
  activationModelEnabled: boolean,
): number | null {
  if (!activationModelEnabled) {
    return null;
  }
  const storedActivation = toFiniteNumber(row.activation_strength);
  if (typeof storedActivation !== "number" || storedActivation <= 0) {
    return null;
  }

  const decayExempt = row.decay_exempt === 1 || row.decay_exempt === "1" || row.decay_exempt === true;
  if (decayExempt) {
    return Number(clamp01(storedActivation).toFixed(4));
  }

  const nowMs = Date.now();
  const lastReinforcedAtMs = [
    row.last_reinforced_at,
    row.last_retrieved_at,
    row.last_reviewed_at,
    row.last_seen_at,
    row.updated_at,
    row.content_time,
    row.created_at,
  ]
    .map((value) => parseIsoDateMs(value))
    .find((value) => Number.isFinite(value));
  const reinforcementCount = Math.max(
    0,
    Math.trunc(
      toFiniteNumber(row.reinforcement_count)
      ?? toFiniteNumber(row.retrieval_count)
      ?? toFiniteNumber(row.access_count)
      ?? 0,
    ),
  );

  const projected = computeActivationStrength({
    activation: clamp01(storedActivation),
    reinforcementCount,
    lastReinforcedAtMs: Number.isFinite(lastReinforcedAtMs) ? Number(lastReinforcedAtMs) : nowMs,
    nowMs,
  });
  return Number(projected.toFixed(4));
}

function resolveActivationFromSignals(row: Record<string, unknown>): number | null {
  const positiveSignals = ACTIVATION_SIGNAL_COLUMNS
    .map((column) => toFiniteNumber(row[column]))
    .filter((value): value is number => typeof value === "number" && value > 0)
    .map((value) => clamp01(value));
  if (positiveSignals.length === 0) {
    return null;
  }
  const averageSignal = positiveSignals.reduce((sum, value) => sum + value, 0) / positiveSignals.length;
  return Number(averageSignal.toFixed(4));
}

function resolveActivationFromAccessSignals(row: Record<string, unknown>): number | null {
  const accessCount = toFiniteNumber(row.access_count);
  if (typeof accessCount !== "number" || accessCount <= 0) {
    return null;
  }

  const cappedAccessCount = Math.max(0, Math.min(64, accessCount));
  const accessStrength = 1 - Math.exp(-cappedAccessCount / 6);
  const nowMs = Date.now();
  const accessAnchor = [
    row.last_accessed_at,
    row.last_reviewed_at,
    row.updated_at,
    row.content_time,
    row.created_at,
  ]
    .map((value) => parseIsoDateMs(value))
    .find((value) => Number.isFinite(value));

  const recencyFactor = Number.isFinite(accessAnchor)
    ? Math.max(
      FALLBACK_ACTIVATION_FLOOR,
      Math.pow(0.5, Math.max(0, (nowMs - Number(accessAnchor)) / (24 * 60 * 60 * 1000)) / (FALLBACK_ACTIVATION_HALF_LIFE_DAYS * 1.5)),
    )
    : 1;
  return Number(clamp01(Math.max(0.2, accessStrength) * recencyFactor).toFixed(4));
}

function resolveActivation(
  row: Record<string, unknown>,
  activationModelEnabled: boolean,
): number {
  const legacyActivation = resolveLegacyActivation(row);
  if (!activationModelEnabled) {
    return legacyActivation;
  }
  const storedActivation = resolveStoredActivation(row, activationModelEnabled);
  const explicitActivation = resolveActivationFromSignals(row);
  const accessActivation = resolveActivationFromAccessSignals(row);
  const activationSignals = [storedActivation, explicitActivation, accessActivation].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  if (activationSignals.length === 0) {
    return legacyActivation;
  }
  const explicitAverage = activationSignals.reduce((sum, value) => sum + value, 0) / activationSignals.length;
  const blendedActivation = clamp01(explicitAverage * 0.72 + legacyActivation * 0.28);
  if (blendedActivation <= 0) {
    return legacyActivation;
  }
  return Number(blendedActivation.toFixed(4));
}

function scoreCandidate(
  row: Record<string, unknown>,
  query: string,
  queryTokens: string[],
  entityTerms: string[],
  config?: LcmConfig,
  vectorSimilarity = 0,
): MemoryRecallCandidate {
  const content = String(row.content || "");
  const tags = parseJsonArray(row.tags);
  const combined = `${content}\n${tags.join(" ")}`.toLowerCase();
  const activationModelEnabled = isActivationModelEnabledForSeed(
    config,
    String(row.memory_id || query || "global"),
  );
  const confidence = resolveTruthConfidence(row, activationModelEnabled);
  const activation = resolveActivation(row, activationModelEnabled);
  const effectiveConfidence = Number((confidence * activation).toFixed(4));
  const valueScore = clamp01(toFiniteNumber(row.value_score) ?? 0);
  const queryLower = query.toLowerCase();
  const vector = Math.max(0, vectorSimilarity) * 0.28;

  let lexical = 0;
  if (queryLower && combined.includes(queryLower)) lexical += 0.45;
  for (const token of queryTokens) {
    if (combined.includes(token)) lexical += 0.08;
  }
  lexical = Math.min(0.75, lexical);

  let entity = 0;
  const entityLockMatched = entityTerms.some((term) => combined.includes(term.toLowerCase()));
  if (entityLockMatched) {
    entity = 0.18;
  }

  const temporal = row.content_time ? 0.05 : 0;
  const confidenceContribution = confidence * CONFIDENCE_SCORE_WEIGHT * activation;

  const rawScore =
    confidenceContribution
    + valueScore * VALUE_SCORE_WEIGHT
    + lexical
    + vector
    + temporal
    + entity;

  // Apply type-based multiplier to bias ranking by memory type.
  const memoryType = String(row.type || "CONTEXT").toUpperCase();
  let typeMultiplier = TYPE_SCORE_MULTIPLIERS[memoryType] ?? DEFAULT_TYPE_MULTIPLIER;

  // Additional heartbeat penalty: verbose status dumps match broadly on
  // vector similarity but are rarely useful for factual recall.
  if (HEARTBEAT_PATTERNS.some((pattern) => pattern.test(content))) {
    typeMultiplier *= HEARTBEAT_PENALTY_MULTIPLIER;
  }

  const score = rawScore * typeMultiplier;

  const scoreBreakdown = {
    confidence: confidence * CONFIDENCE_SCORE_WEIGHT,
    activation,
    value: valueScore * VALUE_SCORE_WEIGHT,
    lexical: lexical,
    vector,
    temporal,
    entity,
    typeMultiplier,
  };

  return {
    id: String(row.memory_id || ""),
    type: String(row.type || "CONTEXT"),
    content,
    scope: String(row.scope || "shared"),
    confidence,
    activation,
    effectiveConfidence,
    valueScore,
    tags,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || row.created_at || ""),
    contentTime: typeof row.content_time === "string" ? row.content_time : null,
    validUntil: typeof row.valid_until === "string" ? row.valid_until : null,
    sourceAgent: typeof row.source_agent === "string" ? row.source_agent : null,
    status: String(row.status || "active"),
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    entityLockMatched,
    score,
    vectorSimilarity: Math.max(0, vectorSimilarity),
    scoreBreakdown,
    estimatedTokens: estimateTokenCount(content),
  };
}

export async function fetchMemoryCandidates(
  db: DatabaseSync,
  options: FetchMemoryCandidatesOptions,
): Promise<{
  memories: MemoryRecallCandidate[];
  totalTokens: number;
  usedArchiveFallback: boolean;
  entityLockTerms: string[];
  usedVectorSearch: boolean;
  vectorBackfilled: number;
}> {
  ensureMemoryRecallTables(db);
  const queryTokens = normalizeQueryTokens(options.query);
  const entityLockTerms = resolveEntityLockTerms(
    db,
    options.query,
    options.entityId,
    options.entityLockEnabled !== false,
    options.config,
  );

  const primaryRows = queryRows(db, options.query, options, Boolean(options.includeArchived));
  const primaryVector = await queryVectorRows(db, options.query, options, Boolean(options.includeArchived));
  let usedArchiveFallback = false;
  let rows = primaryRows;
  let vectorRows = primaryVector.rows;
  let vectorSimilarities = primaryVector.similarities;
  let vectorBackfilled = primaryVector.backfilled;
  if (
    rows.length === 0 &&
    vectorRows.length === 0 &&
    !options.includeArchived &&
    options.archiveFallback !== false
  ) {
    rows = queryRows(db, options.query, options, true);
    const archivedVector = await queryVectorRows(db, options.query, options, true);
    vectorRows = archivedVector.rows;
    vectorSimilarities = archivedVector.similarities;
    vectorBackfilled += archivedVector.backfilled;
    usedArchiveFallback = rows.length > 0;
    if (!usedArchiveFallback && vectorRows.length > 0) {
      usedArchiveFallback = true;
    }
  }

  const mergedRows = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    mergedRows.set(String(row.memory_id || ""), row);
  }
  for (const row of vectorRows) {
    const memoryId = String(row.memory_id || "");
    if (!memoryId) continue;
    if (!mergedRows.has(memoryId)) {
      mergedRows.set(memoryId, row);
    }
  }

  const scored = [...mergedRows.values()]
    .map((row) =>
      scoreCandidate(
        row,
        options.query,
        queryTokens,
        entityLockTerms,
        options.config,
        vectorSimilarities.get(String(row.memory_id || "")) || 0,
      ),
    )
    .filter((row) => row.score >= options.minScore)
    .sort((a, b) => b.score - a.score || b.effectiveConfidence - a.effectiveConfidence || b.createdAt.localeCompare(a.createdAt));

  const memories: MemoryRecallCandidate[] = [];
  let totalTokens = 0;
  for (const row of scored) {
    if (memories.length >= options.topK) {
      break;
    }
    if (options.maxTokens > 0 && memories.length > 0 && totalTokens + row.estimatedTokens > options.maxTokens) {
      continue;
    }
    memories.push(row);
    totalTokens += row.estimatedTokens;
  }

  return {
    memories,
    totalTokens,
    usedArchiveFallback,
    entityLockTerms,
    usedVectorSearch: Boolean(options.config && vectorBackendEnabled(options.config) && vectorSimilarities.size > 0),
    vectorBackfilled,
  };
}
