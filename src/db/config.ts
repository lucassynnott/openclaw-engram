import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  agentNamespace: string;
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  compactionMaxRounds: number;
  largeFileTokenThreshold: number;
  largeFileSummaryProvider: string;
  largeFileSummaryModel: string;
  autocompactDisabled: boolean;
  timezone: string;
  pruneHeartbeatOk: boolean;
  captureEnabled: boolean;
  captureRequireMemoryNote: boolean;
  captureMinConfidence: number;
  captureMinContentChars: number;
  captureDedupeAuto: number;
  captureDedupeReview: number;
  captureQueueOnModelUnavailable: boolean;
  capturePreCompactionExtraction: boolean;
  recallTopK: number;
  recallMinScore: number;
  recallMaxTokens: number;
  recallArchiveFallback: boolean;
  recallDefaultStrategy: string;
  recallEntityLockEnabled: boolean;
  nativeEnabled: boolean;
  nativeMemoryMdPath: string;
  nativeDailyNotesGlob: string;
  nativeSyncMode: string;
  nativeMaxChunkChars: number;
  temporalEnabled: boolean;
  temporalEntityExtraction: boolean;
  temporalEpisodeIngestion: boolean;
  temporalPollIntervalSeconds: number;
  temporalChunkSize: number;
  temporalDedupTokenOverlapMin: number;
  temporalDedupLshThreshold: number;
  temporalDedupLlmConfidenceMin: number;
  vaultDistillationEnabled: boolean;
  vaultClassificationIntervalSeconds: number;
  vaultDecayDays: number;
  vaultEpisodesPerBatch: number;
  gradientEnabled: boolean;
  gradientObserveOnly: boolean;
  gradientDriftWindowSize: number;
  gradientDriftAlertThreshold: number;
  gradientConsecutiveFlagLimit: number;
  vaultEnabled: boolean;
  vaultPath: string;
  vaultSubdir: string;
  vaultHomeNoteName: string;
  vaultManualFolders: string;
  vaultClean: boolean;
  vaultReportsEnabled: boolean;
  obsidianMode: string;
  obsidianExportDiagnostics: boolean;
  obsidianEntityPages: boolean;
  falkorDbEnabled: boolean;
  falkorDbHost: string;
  falkorDbPort: number;
  falkorDbPassword: string;
  falkorDbTemporalGraph: string;
  falkorDbKnowledgeGraph: string;
  vectorBackend: string;
  vectorDimensions: number;
  vectorEmbeddingModel: string;
  vectorEmbeddingProvider: string;
  vaultSyncIntervalHours: number;
  episodeRetentionDays: number;
  heartbeatDedupeThreshold: number;
  fragmentMinContentChars: number;
  harvestEnabled: boolean;
  harvestEveryNTurns: number;
  harvestLookbackTurns: number;
  harvestModel: string;
};

type UnknownRecord = Record<string, unknown>;

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function toStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getPath(obj: UnknownRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as UnknownRecord)[key];
  }, obj);
}

function fromConfig<T>(
  pluginConfig: UnknownRecord,
  paths: string[],
  parser: (value: unknown) => T | undefined,
): T | undefined {
  for (const path of paths) {
    const parsed = parser(getPath(pluginConfig, path));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function fromEnvString(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const parsed = toStr(env[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function fromEnvNumber(env: NodeJS.ProcessEnv, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = toNumber(env[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function fromEnvBool(env: NodeJS.ProcessEnv, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const parsed = toBool(env[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function readString(
  env: NodeJS.ProcessEnv,
  pluginConfig: UnknownRecord,
  envKeys: string[],
  configPaths: string[],
  fallback: string,
): string {
  return fromEnvString(env, envKeys) ?? fromConfig(pluginConfig, configPaths, toStr) ?? fallback;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  pluginConfig: UnknownRecord,
  envKeys: string[],
  configPaths: string[],
  fallback: number,
): number {
  return fromEnvNumber(env, envKeys) ?? fromConfig(pluginConfig, configPaths, toNumber) ?? fallback;
}

function readBool(
  env: NodeJS.ProcessEnv,
  pluginConfig: UnknownRecord,
  envKeys: string[],
  configPaths: string[],
  fallback: boolean,
): boolean {
  return fromEnvBool(env, envKeys) ?? fromConfig(pluginConfig, configPaths, toBool) ?? fallback;
}

/**
 * Resolve Engram configuration while preserving the older flat LCM shape.
 *
 * Precedence:
 * 1. `ENGRAM_*` env vars
 * 2. legacy `LCM_*` env vars
 * 3. nested `engram-v2` plugin config
 * 4. legacy flat plugin config
 * 5. hardcoded defaults
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  const pc = pluginConfig ?? {};

  return {
    enabled: readBool(env, pc, ["ENGRAM_ENABLED", "LCM_ENABLED"], ["enabled"], true),
    databasePath: readString(
      env,
      pc,
      ["ENGRAM_DATABASE_PATH", "LCM_DATABASE_PATH"],
      ["databasePath", "dbPath"],
      join(homedir(), ".openclaw", "lcm.db"),
    ),
    agentNamespace: readString(
      env,
      pc,
      ["ENGRAM_AGENT_NAMESPACE"],
      ["agentNamespace"],
      "default",
    ),
    contextThreshold: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_CONTEXT_THRESHOLD", "LCM_CONTEXT_THRESHOLD"],
      ["compaction.contextThreshold", "contextThreshold"],
      0.75,
    ),
    freshTailCount: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_FRESH_TAIL_COUNT", "LCM_FRESH_TAIL_COUNT"],
      ["compaction.freshTailCount", "freshTailCount"],
      32,
    ),
    leafMinFanout: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_LEAF_MIN_FANOUT", "LCM_LEAF_MIN_FANOUT"],
      ["compaction.leafMinFanout", "leafMinFanout"],
      8,
    ),
    condensedMinFanout: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_CONDENSED_MIN_FANOUT", "LCM_CONDENSED_MIN_FANOUT"],
      ["compaction.condensedMinFanout", "condensedMinFanout"],
      4,
    ),
    condensedMinFanoutHard: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_CONDENSED_MIN_FANOUT_HARD", "LCM_CONDENSED_MIN_FANOUT_HARD"],
      ["condensedMinFanoutHard"],
      2,
    ),
    incrementalMaxDepth: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_INCREMENTAL_MAX_DEPTH", "LCM_INCREMENTAL_MAX_DEPTH"],
      ["compaction.incrementalMaxDepth", "incrementalMaxDepth"],
      0,
    ),
    leafChunkTokens: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_LEAF_CHUNK_TOKENS", "LCM_LEAF_CHUNK_TOKENS"],
      ["compaction.leafChunkTokens", "leafChunkTokens"],
      20_000,
    ),
    leafTargetTokens: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_LEAF_TARGET_TOKENS", "LCM_LEAF_TARGET_TOKENS"],
      ["compaction.leafTargetTokens", "leafTargetTokens"],
      1200,
    ),
    condensedTargetTokens: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_CONDENSED_TARGET_TOKENS", "LCM_CONDENSED_TARGET_TOKENS"],
      ["compaction.condensedTargetTokens", "condensedTargetTokens"],
      2000,
    ),
    maxExpandTokens: readNumber(
      env,
      pc,
      ["ENGRAM_MAX_EXPAND_TOKENS", "LCM_MAX_EXPAND_TOKENS"],
      ["maxExpandTokens"],
      4000,
    ),
    compactionMaxRounds: readNumber(
      env,
      pc,
      ["ENGRAM_COMPACTION_MAX_ROUNDS"],
      ["compaction.maxRounds"],
      10,
    ),
    largeFileTokenThreshold: readNumber(
      env,
      pc,
      ["ENGRAM_LARGEFILES_TOKEN_THRESHOLD", "LCM_LARGE_FILE_TOKEN_THRESHOLD"],
      ["largeFiles.tokenThreshold", "largeFileThresholdTokens", "largeFileTokenThreshold"],
      25_000,
    ),
    largeFileSummaryProvider: readString(
      env,
      pc,
      ["ENGRAM_LARGEFILES_SUMMARY_PROVIDER", "LCM_LARGE_FILE_SUMMARY_PROVIDER"],
      ["largeFiles.summaryProvider", "largeFileSummaryProvider"],
      "",
    ),
    largeFileSummaryModel: readString(
      env,
      pc,
      ["ENGRAM_LARGEFILES_SUMMARY_MODEL", "LCM_LARGE_FILE_SUMMARY_MODEL"],
      ["largeFiles.summaryModel", "largeFileSummaryModel"],
      "",
    ),
    autocompactDisabled: readBool(
      env,
      pc,
      ["ENGRAM_COMPACTION_AUTOCOMPACT_DISABLED", "LCM_AUTOCOMPACT_DISABLED"],
      ["compaction.autocompactDisabled", "autocompactDisabled"],
      false,
    ),
    timezone:
      fromEnvString(env, ["ENGRAM_COMPACTION_TIMEZONE", "TZ"]) ??
      fromConfig(pc, ["compaction.timezone", "timezone"], toStr) ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk: readBool(
      env,
      pc,
      ["ENGRAM_PRUNE_HEARTBEAT_OK", "LCM_PRUNE_HEARTBEAT_OK"],
      ["pruneHeartbeatOk"],
      false,
    ),
    captureEnabled: readBool(
      env,
      pc,
      ["ENGRAM_CAPTURE_ENABLED"],
      ["capture.enabled"],
      true,
    ),
    captureRequireMemoryNote: readBool(
      env,
      pc,
      ["ENGRAM_CAPTURE_REQUIRE_MEMORY_NOTE"],
      ["capture.requireMemoryNote"],
      true,
    ),
    captureMinConfidence: readNumber(
      env,
      pc,
      ["ENGRAM_CAPTURE_MIN_CONFIDENCE"],
      ["capture.minConfidence"],
      0.65,
    ),
    captureMinContentChars: readNumber(
      env,
      pc,
      ["ENGRAM_CAPTURE_MIN_CONTENT_CHARS"],
      ["capture.minContentChars"],
      25,
    ),
    captureDedupeAuto: readNumber(
      env,
      pc,
      ["ENGRAM_CAPTURE_DEDUPE_AUTO"],
      ["capture.dedupeAuto"],
      0.92,
    ),
    captureDedupeReview: readNumber(
      env,
      pc,
      ["ENGRAM_CAPTURE_DEDUPE_REVIEW"],
      ["capture.dedupeReview"],
      0.85,
    ),
    captureQueueOnModelUnavailable: readBool(
      env,
      pc,
      ["ENGRAM_CAPTURE_QUEUE_ON_MODEL_UNAVAILABLE"],
      ["capture.queueOnModelUnavailable"],
      true,
    ),
    capturePreCompactionExtraction: readBool(
      env,
      pc,
      ["ENGRAM_CAPTURE_PRE_COMPACTION_EXTRACTION"],
      ["capture.preCompactionExtraction"],
      true,
    ),
    recallTopK: readNumber(
      env,
      pc,
      ["ENGRAM_RECALL_TOPK"],
      ["recall.topK"],
      8,
    ),
    recallMinScore: readNumber(
      env,
      pc,
      ["ENGRAM_RECALL_MIN_SCORE"],
      ["recall.minScore"],
      0.45,
    ),
    recallMaxTokens: readNumber(
      env,
      pc,
      ["ENGRAM_RECALL_MAX_TOKENS"],
      ["recall.maxTokens"],
      1200,
    ),
    recallArchiveFallback: readBool(
      env,
      pc,
      ["ENGRAM_RECALL_ARCHIVE_FALLBACK"],
      ["recall.archiveFallback"],
      true,
    ),
    recallDefaultStrategy: readString(
      env,
      pc,
      ["ENGRAM_RECALL_DEFAULT_STRATEGY"],
      ["recall.defaultStrategy"],
      "auto",
    ),
    recallEntityLockEnabled: readBool(
      env,
      pc,
      ["ENGRAM_RECALL_ENTITY_LOCK_ENABLED"],
      ["recall.entityLockEnabled"],
      true,
    ),
    nativeEnabled: readBool(
      env,
      pc,
      ["ENGRAM_NATIVE_ENABLED"],
      ["native.enabled"],
      true,
    ),
    nativeMemoryMdPath: readString(
      env,
      pc,
      ["ENGRAM_NATIVE_MEMORY_MD_PATH"],
      ["native.memoryMdPath"],
      "MEMORY.md",
    ),
    nativeDailyNotesGlob: readString(
      env,
      pc,
      ["ENGRAM_NATIVE_DAILY_NOTES_GLOB"],
      ["native.dailyNotesGlob"],
      "memory/????-??-??*.md",
    ),
    nativeSyncMode: readString(
      env,
      pc,
      ["ENGRAM_NATIVE_SYNC_MODE"],
      ["native.syncMode"],
      "hybrid",
    ),
    nativeMaxChunkChars: readNumber(
      env,
      pc,
      ["ENGRAM_NATIVE_MAX_CHUNK_CHARS"],
      ["native.maxChunkChars"],
      900,
    ),
    temporalEnabled: readBool(
      env,
      pc,
      ["ENGRAM_TEMPORAL_ENABLED"],
      ["temporal.enabled"],
      true,
    ),
    temporalEntityExtraction: readBool(
      env,
      pc,
      ["ENGRAM_TEMPORAL_ENTITY_EXTRACTION"],
      ["temporal.entityExtraction"],
      true,
    ),
    temporalEpisodeIngestion: readBool(
      env,
      pc,
      ["ENGRAM_TEMPORAL_EPISODE_INGESTION"],
      ["temporal.episodeIngestion"],
      true,
    ),
    temporalPollIntervalSeconds: readNumber(
      env,
      pc,
      ["ENGRAM_TEMPORAL_POLL_INTERVAL_SECONDS"],
      ["temporal.pollIntervalSeconds"],
      5,
    ),
    temporalChunkSize: readNumber(
      env,
      pc,
      ["ENGRAM_TEMPORAL_CHUNK_SIZE"],
      ["temporal.chunkSize"],
      10,
    ),
    temporalDedupTokenOverlapMin: readNumber(
      env,
      pc,
      ["ENGRAM_TEMPORAL_DEDUPLICATION_TOKEN_OVERLAP_MIN"],
      ["temporal.deduplication.tokenOverlapMin"],
      0.4,
    ),
    temporalDedupLshThreshold: readNumber(
      env,
      pc,
      ["ENGRAM_TEMPORAL_DEDUPLICATION_LSH_THRESHOLD"],
      ["temporal.deduplication.lshThreshold"],
      0.5,
    ),
    temporalDedupLlmConfidenceMin: readNumber(
      env,
      pc,
      ["ENGRAM_TEMPORAL_DEDUPLICATION_LLM_CONFIDENCE_MIN"],
      ["temporal.deduplication.llmConfidenceMin"],
      0.85,
    ),
    vaultDistillationEnabled: readBool(
      env,
      pc,
      ["ENGRAM_VAULT_DISTILLATION_ENABLED"],
      ["vault.distillationEnabled"],
      false,
    ),
    vaultClassificationIntervalSeconds: readNumber(
      env,
      pc,
      ["ENGRAM_VAULT_CLASSIFICATION_INTERVAL_SECONDS"],
      ["vault.classificationIntervalSeconds"],
      300,
    ),
    vaultDecayDays: readNumber(
      env,
      pc,
      ["ENGRAM_VAULT_DECAY_DAYS"],
      ["vault.decayDays"],
      90,
    ),
    vaultEpisodesPerBatch: readNumber(
      env,
      pc,
      ["ENGRAM_VAULT_EPISODES_PER_BATCH"],
      ["vault.episodesPerBatch"],
      20,
    ),
    gradientEnabled: readBool(
      env,
      pc,
      ["ENGRAM_GRADIENT_ENABLED"],
      ["gradient.enabled"],
      true,
    ),
    gradientObserveOnly: readBool(
      env,
      pc,
      ["ENGRAM_GRADIENT_OBSERVE_ONLY"],
      ["gradient.observeOnly"],
      true,
    ),
    gradientDriftWindowSize: readNumber(
      env,
      pc,
      ["ENGRAM_GRADIENT_DRIFT_WINDOW_SIZE"],
      ["gradient.driftWindowSize"],
      20,
    ),
    gradientDriftAlertThreshold: readNumber(
      env,
      pc,
      ["ENGRAM_GRADIENT_DRIFT_ALERT_THRESHOLD"],
      ["gradient.driftAlertThreshold"],
      0.65,
    ),
    gradientConsecutiveFlagLimit: readNumber(
      env,
      pc,
      ["ENGRAM_GRADIENT_CONSECUTIVE_FLAG_LIMIT"],
      ["gradient.consecutiveFlagLimit"],
      5,
    ),
    vaultEnabled: readBool(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_ENABLED", "LCM_VAULT_ENABLED"],
      ["obsidian.enabled", "vaultEnabled"],
      false,
    ),
    vaultPath: readString(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_PATH", "LCM_VAULT_PATH"],
      ["obsidian.path", "vaultPath"],
      "",
    ),
    vaultSubdir: readString(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_SUBDIR", "LCM_VAULT_SUBDIR"],
      ["obsidian.subdir", "vaultSubdir"],
      "Engram",
    ),
    vaultHomeNoteName: readString(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_HOME_NOTE_NAME", "LCM_VAULT_HOME_NOTE_NAME"],
      ["vaultHomeNoteName"],
      "Home",
    ),
    vaultManualFolders: readString(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_MANUAL_FOLDERS", "LCM_VAULT_MANUAL_FOLDERS"],
      ["obsidian.manualFolders", "vaultManualFolders"],
      "Inbox,Manual",
    ),
    vaultClean: readBool(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_CLEAN", "LCM_VAULT_CLEAN"],
      ["obsidian.clean", "vaultClean"],
      true,
    ),
    vaultReportsEnabled: readBool(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_REPORTS_ENABLED", "LCM_VAULT_REPORTS_ENABLED"],
      ["obsidian.reportsEnabled", "vaultReportsEnabled"],
      true,
    ),
    obsidianMode: readString(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_MODE", "LCM_OBSIDIAN_MODE"],
      ["obsidian.mode", "obsidianMode"],
      "curated",
    ),
    obsidianExportDiagnostics: readBool(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_EXPORT_DIAGNOSTICS", "LCM_OBSIDIAN_EXPORT_DIAGNOSTICS"],
      ["obsidianExportDiagnostics"],
      false,
    ),
    obsidianEntityPages: readBool(
      env,
      pc,
      ["ENGRAM_OBSIDIAN_ENTITY_PAGES"],
      ["obsidian.entityPages"],
      false,
    ),
    falkorDbEnabled: readBool(
      env,
      pc,
      ["ENGRAM_FALKORDB_ENABLED"],
      ["falkordb.enabled"],
      false,
    ),
    falkorDbHost: readString(
      env,
      pc,
      ["ENGRAM_FALKORDB_HOST"],
      ["falkordb.host"],
      "localhost",
    ),
    falkorDbPort: readNumber(
      env,
      pc,
      ["ENGRAM_FALKORDB_PORT"],
      ["falkordb.port"],
      6379,
    ),
    falkorDbPassword: readString(
      env,
      pc,
      ["ENGRAM_FALKORDB_PASSWORD"],
      ["falkordb.password"],
      "",
    ),
    falkorDbTemporalGraph: readString(
      env,
      pc,
      ["ENGRAM_FALKORDB_TEMPORAL_GRAPH"],
      ["falkordb.temporalGraph"],
      "engram_temporal",
    ),
    falkorDbKnowledgeGraph: readString(
      env,
      pc,
      ["ENGRAM_FALKORDB_KNOWLEDGE_GRAPH"],
      ["falkordb.knowledgeGraph"],
      "engram_knowledge",
    ),
    vectorBackend: readString(
      env,
      pc,
      ["ENGRAM_VECTOR_BACKEND"],
      ["vector.backend"],
      "sqlite_vec",
    ),
    vectorDimensions: readNumber(
      env,
      pc,
      ["ENGRAM_VECTOR_DIMENSIONS"],
      ["vector.dimensions"],
      1536,
    ),
    vectorEmbeddingModel: readString(
      env,
      pc,
      ["ENGRAM_VECTOR_EMBEDDING_MODEL"],
      ["vector.embeddingModel"],
      "text-embedding-3-small",
    ),
    vectorEmbeddingProvider: readString(
      env,
      pc,
      ["ENGRAM_VECTOR_EMBEDDING_PROVIDER"],
      ["vector.embeddingProvider"],
      "openai",
    ),
    vaultSyncIntervalHours: readNumber(
      env,
      pc,
      ["ENGRAM_VAULT_SYNC_INTERVAL_HOURS"],
      ["vault.syncIntervalHours", "vaultSyncIntervalHours"],
      24,
    ),
    episodeRetentionDays: readNumber(
      env,
      pc,
      ["ENGRAM_EPISODE_RETENTION_DAYS"],
      ["hygiene.episodeRetentionDays", "episodeRetentionDays"],
      7,
    ),
    heartbeatDedupeThreshold: readNumber(
      env,
      pc,
      ["ENGRAM_HEARTBEAT_DEDUPE_THRESHOLD"],
      ["hygiene.heartbeatDedupeThreshold", "heartbeatDedupeThreshold"],
      0.7,
    ),
    fragmentMinContentChars: readNumber(
      env,
      pc,
      ["ENGRAM_FRAGMENT_MIN_CONTENT_CHARS"],
      ["hygiene.fragmentMinContentChars", "fragmentMinContentChars"],
      50,
    ),
    harvestEnabled: readBool(
      env,
      pc,
      ["ENGRAM_HARVEST_ENABLED"],
      ["periodicHarvest.enabled", "harvestEnabled"],
      true,
    ),
    harvestEveryNTurns: readNumber(
      env,
      pc,
      ["ENGRAM_HARVEST_EVERY_N_TURNS"],
      ["periodicHarvest.everyNTurns", "harvestEveryNTurns"],
      10,
    ),
    harvestLookbackTurns: readNumber(
      env,
      pc,
      ["ENGRAM_HARVEST_LOOKBACK_TURNS"],
      ["periodicHarvest.lookbackTurns", "harvestLookbackTurns"],
      20,
    ),
    harvestModel: readString(
      env,
      pc,
      ["ENGRAM_HARVEST_MODEL"],
      ["periodicHarvest.model", "harvestModel"],
      "",
    ),
  };
}
