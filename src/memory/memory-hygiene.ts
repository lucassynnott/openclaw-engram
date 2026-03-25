import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { resolveHygieneTieringMode } from "./activation-rollout.js";
import { ensureMemoryTables } from "./memory-schema.js";
import { isFragmentContent, isHeartbeatPattern } from "./memory-utils.js";

export type ArchiveStaleEpisodesResult = {
  archived: number;
  scanned: number;
};

export type ArchiveFragmentsResult = {
  archived: number;
  scanned: number;
};

export type MemoryHygieneResult = {
  staleEpisodes: ArchiveStaleEpisodesResult;
  staleHeartbeats: ArchiveStaleEpisodesResult;
  coldTierEpisodes: ArchiveStaleEpisodesResult;
  fragments: ArchiveFragmentsResult;
};

const STATUS_SPAM_PATTERNS: RegExp[] = [
  /^\s*(?:status|health)\s*[:=\-]\s*(?:ok|pass|good|clean|nominal|unchanged|stable)\s*$/i,
  /\b(?:status|health)\s+(?:is|remains|stays)\s+(?:ok|good|clean|nominal|unchanged|stable)\b/i,
  /\b(?:no|without)\s+(?:issues?|changes?|updates?)\b/i,
  /^\s*heartbeat_ok\b/i,
];

type UnknownRecord = Record<string, unknown>;

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function getPath(source: UnknownRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as UnknownRecord)[segment];
  }, source);
}

function readRuntimeNumber(
  source: UnknownRecord,
  paths: string[],
  fallback: number,
): number {
  for (const path of paths) {
    const parsed = toFiniteNumber(getPath(source, path));
    if (parsed !== undefined) return parsed;
  }
  return fallback;
}

function readRuntimeBool(
  source: UnknownRecord,
  paths: string[],
  fallback: boolean,
): boolean {
  for (const path of paths) {
    const parsed = toBool(getPath(source, path));
    if (parsed !== undefined) return parsed;
  }
  return fallback;
}

function cutoffIsoFromRetentionDays(retentionDays: number): string {
  return new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function isHeartbeatOrStatusSpamEpisode(content: string): boolean {
  const text = content.trim();
  if (isHeartbeatPattern(text)) return true;
  return STATUS_SPAM_PATTERNS.some((re) => re.test(text));
}

/**
 * Backward-compatible wrapper.
 *
 * Historical behavior archived all old EPISODEs. To preserve safer defaults,
 * this now delegates to heartbeat/status-spam-only archival.
 */
export function archiveStaleEpisodes(params: {
  db: DatabaseSync;
  retentionDays: number;
  now?: string;
}): ArchiveStaleEpisodesResult {
  return archiveStaleHeartbeats(params);
}

/**
 * Archive active heartbeat/status-spam EPISODE entries older than
 * `retentionDays`.
 */
export function archiveStaleHeartbeats(params: {
  db: DatabaseSync;
  retentionDays: number;
  now?: string;
}): ArchiveStaleEpisodesResult {
  ensureMemoryTables(params.db);

  const retentionDays = Math.max(1, Math.trunc(params.retentionDays));
  const now = params.now || new Date().toISOString();
  const cutoff = cutoffIsoFromRetentionDays(retentionDays);

  // Fetch episode candidates
  const rows = params.db
    .prepare(
      `SELECT memory_id, content
       FROM memory_current
       WHERE type = 'EPISODE'
         AND status = 'active'
         AND COALESCE(content_time, created_at) < ?`,
    )
    .all(cutoff) as Array<{ memory_id: string; content: string }>;

  const heartbeatIds = rows
    .filter((row) => isHeartbeatOrStatusSpamEpisode(row.content))
    .map((row) => row.memory_id);

  if (heartbeatIds.length === 0) {
    return { archived: 0, scanned: rows.length };
  }

  const placeholders = heartbeatIds.map(() => "?").join(",");
  const result = params.db
    .prepare(
      `UPDATE memory_current
       SET status = 'archived',
           archived_at = ?
       WHERE status = 'active'
         AND memory_id IN (${placeholders})`,
    )
    .run(now, ...heartbeatIds);

  return {
    archived: Number(result.changes),
    scanned: rows.length,
  };
}

/**
 * Optional cold-tier archival for low-activation EPISODE entries.
 *
 * This is intentionally conservative and should stay opt-in:
 * - older than retention window
 * - NOT heartbeat/status spam (those are handled separately)
 * - low value_score
 * - low non-store activation events
 * - optionally only entries never reviewed
 */
export function archiveColdTierEpisodes(params: {
  db: DatabaseSync;
  retentionDays: number;
  maxValueScore?: number;
  maxActivationEvents?: number;
  requireUnreviewed?: boolean;
  dryRun?: boolean;
  now?: string;
}): ArchiveStaleEpisodesResult {
  ensureMemoryTables(params.db);

  const retentionDays = Math.max(1, Math.trunc(params.retentionDays));
  const maxValueScore = Math.max(0, Math.min(1, params.maxValueScore ?? 0.35));
  const maxActivationEvents = Math.max(0, Math.trunc(params.maxActivationEvents ?? 0));
  const requireUnreviewed = params.requireUnreviewed ?? true;
  const dryRun = params.dryRun ?? false;
  const now = params.now || new Date().toISOString();
  const cutoff = cutoffIsoFromRetentionDays(retentionDays);

  const rows = params.db
    .prepare(
      `SELECT m.memory_id,
              m.content,
              m.value_score,
              m.last_reviewed_at,
              COALESCE(a.activation_events, 0) AS activation_events
       FROM memory_current m
       LEFT JOIN (
         SELECT memory_id,
                COUNT(*) AS activation_events
         FROM memory_events
         WHERE action <> 'store'
         GROUP BY memory_id
       ) a
         ON a.memory_id = m.memory_id
       WHERE m.type = 'EPISODE'
         AND m.status = 'active'
         AND COALESCE(m.content_time, m.created_at) < ?`,
    )
    .all(cutoff) as Array<{
      memory_id: string;
      content: string;
      value_score: unknown;
      last_reviewed_at: string | null;
      activation_events: unknown;
    }>;

  const coldIds = rows
    .filter((row) => !isHeartbeatOrStatusSpamEpisode(row.content))
    .filter((row) => {
      if (requireUnreviewed && row.last_reviewed_at) return false;
      const score = toFiniteNumber(row.value_score);
      if (score === undefined || score > maxValueScore) return false;
      const activations = toFiniteNumber(row.activation_events) ?? 0;
      return activations <= maxActivationEvents;
    })
    .map((row) => row.memory_id);

  if (coldIds.length === 0) {
    return { archived: 0, scanned: rows.length };
  }

  if (dryRun) {
    return {
      archived: 0,
      scanned: rows.length,
    };
  }

  const placeholders = coldIds.map(() => "?").join(",");
  const result = params.db
    .prepare(
      `UPDATE memory_current
       SET status = 'archived',
           archived_at = ?
       WHERE status = 'active'
         AND memory_id IN (${placeholders})`,
    )
    .run(now, ...coldIds);

  return {
    archived: Number(result.changes),
    scanned: rows.length,
  };
}

/**
 * Archive fragment memories — very short content entries with no meaningful
 * semantic value. These are typically leftover from early ingestion before
 * quality filters were in place.
 */
export function archiveFragments(params: {
  db: DatabaseSync;
  minContentChars?: number;
  now?: string;
}): ArchiveFragmentsResult {
  ensureMemoryTables(params.db);

  const minChars = params.minContentChars ?? 50;
  const now = params.now || new Date().toISOString();

  // Fetch short active entries
  const rows = params.db
    .prepare(
      `SELECT memory_id, content, type
       FROM memory_current
       WHERE status = 'active'
         AND length(content) < ?`,
    )
    .all(minChars) as Array<{ memory_id: string; content: string; type: string }>;

  const fragmentIds = rows
    .filter((row) => isFragmentContent(row.content, minChars))
    .map((row) => row.memory_id);

  if (fragmentIds.length === 0) {
    return { archived: 0, scanned: rows.length };
  }

  const placeholders = fragmentIds.map(() => "?").join(",");
  const result = params.db
    .prepare(
      `UPDATE memory_current
       SET status = 'archived',
           archived_at = ?
       WHERE memory_id IN (${placeholders})`,
    )
    .run(now, ...fragmentIds);

  return {
    archived: Number(result.changes),
    scanned: rows.length,
  };
}

/**
 * Run all hygiene routines in one pass. Designed to be called from native
 * sync or as a standalone maintenance step.
 */
export function runMemoryHygiene(params: {
  db: DatabaseSync;
  config: LcmConfig;
  now?: string;
}): MemoryHygieneResult {
  const runtimeConfig = params.config as unknown as UnknownRecord;
  const now = params.now || new Date().toISOString();

  // Prefer explicit heartbeat/status retention when available; fallback to
  // legacy episodeRetentionDays for backwards compatibility.
  const heartbeatRetentionDays = readRuntimeNumber(
    runtimeConfig,
    [
      "hygiene.heartbeatRetentionDays",
      "heartbeatRetentionDays",
      "hygiene.statusSpamRetentionDays",
      "statusSpamRetentionDays",
      "hygiene.episodeRetentionDays",
      "episodeRetentionDays",
    ],
    params.config.episodeRetentionDays,
  );

  const staleHeartbeats = archiveStaleHeartbeats({
    db: params.db,
    retentionDays: heartbeatRetentionDays,
    now,
  });

  const coldTierOverride = readRuntimeBool(
    runtimeConfig,
    [
      "hygiene.coldTierEnabled",
      "coldTierEnabled",
      "hygiene.enableColdTier",
      "enableColdTier",
    ],
    resolveHygieneTieringMode(params.config) === "enforce",
  );
  const tieringMode = resolveHygieneTieringMode(params.config);
  const coldTierDryRun = coldTierOverride ? false : tieringMode === "observe";
  const coldTierEnabled = coldTierOverride || coldTierDryRun;

  const coldTierEpisodes = coldTierEnabled
    ? archiveColdTierEpisodes({
      db: params.db,
      retentionDays: readRuntimeNumber(
        runtimeConfig,
        [
          "hygiene.coldTierRetentionDays",
          "coldTierRetentionDays",
          "hygiene.coldRetentionDays",
          "coldRetentionDays",
        ],
        30,
      ),
      maxValueScore: readRuntimeNumber(
        runtimeConfig,
        [
          "hygiene.coldTierMaxValueScore",
          "coldTierMaxValueScore",
          "hygiene.coldMaxValueScore",
          "coldMaxValueScore",
        ],
        0.35,
      ),
      maxActivationEvents: readRuntimeNumber(
        runtimeConfig,
        [
          "hygiene.coldTierMaxActivationEvents",
          "coldTierMaxActivationEvents",
          "hygiene.coldMaxActivationEvents",
          "coldMaxActivationEvents",
        ],
        0,
      ),
      requireUnreviewed: readRuntimeBool(
        runtimeConfig,
        [
          "hygiene.coldTierRequireUnreviewed",
          "coldTierRequireUnreviewed",
          "hygiene.coldRequireUnreviewed",
          "coldRequireUnreviewed",
        ],
        true,
      ),
      dryRun: coldTierDryRun,
      now,
    })
    : { archived: 0, scanned: 0 };

  const staleEpisodes: ArchiveStaleEpisodesResult = {
    archived: staleHeartbeats.archived + coldTierEpisodes.archived,
    scanned: staleHeartbeats.scanned + coldTierEpisodes.scanned,
  };

  const fragments = archiveFragments({
    db: params.db,
    minContentChars: readRuntimeNumber(
      runtimeConfig,
      ["hygiene.fragmentMinContentChars", "fragmentMinContentChars"],
      params.config.fragmentMinContentChars,
    ),
    now,
  });

  return { staleEpisodes, staleHeartbeats, coldTierEpisodes, fragments };
}
