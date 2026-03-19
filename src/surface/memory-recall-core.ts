import type { DatabaseSync } from "node:sqlite";
import { getLcmDbFeatures } from "../db/features.js";
import type { LcmConfig } from "../db/config.js";
import { ensureWorldModelReady, findEntityMatches, getEntityDetail } from "../entity/world-model.js";
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
    value: number;
    lexical: number;
    vector: number;
    temporal: number;
    entity: number;
  };
  vectorSimilarity: number;
  estimatedTokens: number;
};

const CONFIDENCE_HALF_LIFE_DAYS = 14;
const CONFIDENCE_DECAY_FLOOR = 0.45;

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

export function estimateTokenCount(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function ensureMemoryRecallTables(db: DatabaseSync): void {
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
  const selected = `
    SELECT m.memory_id, m.type, m.content, m.scope, m.confidence, m.value_score, m.tags, m.created_at, m.updated_at,
           m.content_time, m.valid_until, m.status, m.archived_at, m.source_agent
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
  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT m.memory_id, m.type, m.content, m.scope, m.confidence, m.value_score, m.tags, m.created_at,
              m.updated_at, m.content_time, m.valid_until, m.status, m.archived_at, m.source_agent
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
  const rows = db
    .prepare(
      `SELECT m.memory_id, m.type, m.content, m.scope, m.confidence, m.value_score, m.tags, m.created_at,
              m.updated_at, m.content_time, m.valid_until, m.status, m.archived_at, m.source_agent,
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
         SELECT m.memory_id, m.type, m.content, m.scope, m.confidence, m.value_score, m.tags, m.created_at,
                m.updated_at, m.content_time, m.valid_until, m.status, m.archived_at, m.source_agent,
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

function resolveEffectiveConfidence(row: Record<string, unknown>): number {
  const rawConfidence = Math.max(0, Math.min(1, Number(row.confidence || 0)));
  if (rawConfidence <= 0) {
    return 0;
  }

  const nowMs = Date.now();
  const validUntil = typeof row.valid_until === "string" ? Date.parse(row.valid_until) : NaN;
  if (Number.isFinite(validUntil) && validUntil < nowMs) {
    return Number((rawConfidence * 0.35).toFixed(4));
  }

  const freshnessAnchor = [
    row.last_reviewed_at,
    row.updated_at,
    row.content_time,
    row.created_at,
  ]
    .map((value) => (typeof value === "string" ? Date.parse(value) : NaN))
    .find((value) => Number.isFinite(value));
  if (!Number.isFinite(freshnessAnchor)) {
    return rawConfidence;
  }

  const ageDays = Math.max(0, (nowMs - Number(freshnessAnchor)) / (24 * 60 * 60 * 1000));
  const decayFactor = Math.max(
    CONFIDENCE_DECAY_FLOOR,
    Math.pow(0.5, ageDays / CONFIDENCE_HALF_LIFE_DAYS),
  );
  return Number((rawConfidence * decayFactor).toFixed(4));
}

function scoreCandidate(
  row: Record<string, unknown>,
  query: string,
  queryTokens: string[],
  entityTerms: string[],
  vectorSimilarity = 0,
): MemoryRecallCandidate {
  const content = String(row.content || "");
  const tags = parseJsonArray(row.tags);
  const combined = `${content}\n${tags.join(" ")}`.toLowerCase();
  const confidence = Math.max(0, Math.min(1, Number(row.confidence || 0)));
  const effectiveConfidence = resolveEffectiveConfidence(row);
  const valueScore = Math.max(0, Math.min(1, Number(row.value_score || 0)));
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
  const scoreBreakdown = {
    confidence: effectiveConfidence * 0.5,
    value: valueScore * 0.18,
    lexical: lexical,
    vector,
    temporal,
    entity,
  };
  const score = scoreBreakdown.confidence
    + scoreBreakdown.value
    + scoreBreakdown.lexical
    + scoreBreakdown.vector
    + scoreBreakdown.temporal
    + scoreBreakdown.entity;

  return {
    id: String(row.memory_id || ""),
    type: String(row.type || "CONTEXT"),
    content,
    scope: String(row.scope || "shared"),
    confidence,
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
        vectorSimilarities.get(String(row.memory_id || "")) || 0,
      ),
    )
    .filter((row) => row.score >= options.minScore)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt));

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
