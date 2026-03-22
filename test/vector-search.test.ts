import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { clearVectorRuntime, registerVectorRuntime } from "../src/memory/vector-runtime.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import { createMemoryQueryTool } from "../src/surface/memory-query-tool.js";
import { createMemorySearchTool } from "../src/surface/memory-search-tool.js";

function makeConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
    agentNamespace: "default",
    contextThreshold: 0.75,
    freshTailCount: 8,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 120,
    compactionMaxRounds: 8,
    largeFileTokenThreshold: 25_000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    captureEnabled: true,
    captureRequireMemoryNote: false,
    captureMinConfidence: 0.6,
    captureMinContentChars: 24,
    captureDedupeAuto: 0.9,
    captureDedupeReview: 0.78,
    captureQueueOnModelUnavailable: true,
    capturePreCompactionExtraction: true,
    recallTopK: 8,
    recallMinScore: 0.18,
    recallMaxTokens: 1400,
    recallArchiveFallback: true,
    recallDefaultStrategy: "auto",
    recallEntityLockEnabled: true,
    nativeEnabled: false,
    nativeMemoryMdPath: "",
    nativeDailyNotesGlob: "memory/????-??-??*.md",
    nativeSyncMode: "hybrid",
    nativeMaxChunkChars: 900,
    temporalEnabled: true,
    temporalEntityExtraction: true,
    temporalEpisodeIngestion: true,
    temporalPollIntervalSeconds: 5,
    temporalChunkSize: 10,
    temporalDedupTokenOverlapMin: 0.4,
    temporalDedupLshThreshold: 0.5,
    temporalDedupLlmConfidenceMin: 0.85,
    vaultDistillationEnabled: false,
    vaultClassificationIntervalSeconds: 300,
    vaultDecayDays: 90,
    vaultEpisodesPerBatch: 20,
    gradientEnabled: true,
    gradientObserveOnly: true,
    gradientDriftWindowSize: 20,
    gradientDriftAlertThreshold: 0.65,
    gradientConsecutiveFlagLimit: 5,
    vaultEnabled: false,
    vaultPath: "",
    vaultSubdir: "Engram",
    vaultHomeNoteName: "Home",
    vaultManualFolders: "Inbox,Manual",
    vaultClean: true,
    vaultReportsEnabled: true,
    obsidianMode: "curated",
    obsidianExportDiagnostics: false,
    obsidianEntityPages: false,
    falkorDbEnabled: false,
    falkorDbHost: "localhost",
    falkorDbPort: 6379,
    falkorDbPassword: "",
    falkorDbTemporalGraph: "engram_temporal",
    falkorDbKnowledgeGraph: "engram_knowledge",
    vectorBackend: "sqlite_vec",
    vectorDimensions: 384,
    vectorEmbeddingModel: "text-embedding-3-small",
    vectorEmbeddingProvider: "openai",
    vaultSyncIntervalHours: 24,
    episodeRetentionDays: 7,
    heartbeatDedupeThreshold: 0.7,
    fragmentMinContentChars: 50,
    harvestEnabled: true,
    harvestEveryNTurns: 10,
    harvestLookbackTurns: 20,
    harvestModel: "",
    harvestMinCooldownSeconds: 60,
    dbOptimizeEnabled: true,
  };
}

function unitVector(index: number, dimensions = 64): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[index] = 1;
  return vector;
}

describe("vector-backed memory recall", () => {
  let config: LcmConfig;
  let databasePath: string;

  beforeEach(() => {
    databasePath = join(tmpdir(), `engram-vector-${randomUUID()}.sqlite`);
    config = makeConfig(databasePath);
  });

  afterEach(() => {
    void clearVectorRuntime(databasePath);
    closeLcmConnection();
    rmSync(databasePath, { force: true });
  });

  it("backfills vectors for legacy rows during memory_search", async () => {
    const db = getLcmConnection(databasePath);
    ensureMemoryTables(db);
    db.prepare(
      `INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status,
        value_score, value_label, created_at, updated_at, tags, provenance, source_layer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "mem_legacytea",
      "PREFERENCE",
      "Jordan prefers peppermint tea when working late.",
      "jordan prefer peppermint tea when working late",
      "legacy-hash",
      "legacy",
      0.82,
      "shared",
      "active",
      0.86,
      "core",
      "2026-03-19T00:00:00.000Z",
      "2026-03-19T00:00:00.000Z",
      JSON.stringify(["Jordan"]),
      "{}",
      "registry",
    );

    const tool = createMemorySearchTool({ config });
    const result = await tool.execute("t1", {
      query: "What drink does Jordan favor during late work?",
      topK: 5,
      minScore: 0.12,
    });

    expect(result.details.usedVectorSearch).toBe(true);
    expect(result.details.vectorBackfilled).toBeGreaterThan(0);
    expect(result.details.memories[0].memoryId).toBe("mem_legacytea");
    expect(result.details.memories[0].vectorSimilarity).toBeGreaterThan(0.05);
    expect(result.details.memories[0].scoreBreakdown.vector).toBeGreaterThan(0);

    const nativeArtifacts = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE name IN ('memory_vectors', 'memory_vector_rowids', 'memory_vector_index')
         ORDER BY name`,
      )
      .all() as Array<{ name?: string }>;
    expect(nativeArtifacts).toEqual([
      { name: "memory_vector_index" },
      { name: "memory_vector_rowids" },
      { name: "memory_vectors" },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM memory_vector_rowids").get() as { count: number },
    ).toEqual({ count: 1 });
  });

  it("surfaces vector usage through memory_query quick-context recall", async () => {
    const addTool = createMemoryAddTool({ config });
    const queryTool = createMemoryQueryTool({ config });

    await addTool.execute("t2", {
      content: "We decided to use SQLite as the primary database for Engram.",
      kind: "DECISION",
      entities: ["Engram"],
    });

    const result = await queryTool.execute("t3", {
      query: "What storage engine did we choose for Engram?",
      topK: 5,
      minScore: 0.12,
    });

    expect(result.details.usedVectorSearch).toBe(true);
    expect(result.details.vectorBackend).toBe("sqlite_vec");
    expect(result.details.memories.length).toBeGreaterThan(0);
    expect(result.details.memories[0].content).toContain("SQLite");
    expect(result.details.memories[0].vector_similarity).toBeGreaterThan(0.05);

    const db = getLcmConnection(databasePath);
    const version = db.prepare("SELECT vec_version() AS version").get() as { version?: string };
    expect(String(version.version || "")).toContain("v0.");
  });

  it("uses registered provider embeddings for indexing and recall", async () => {
    const embedText = vi.fn(async (text: string) => {
      if (/sqlite/i.test(text)) {
        return unitVector(0);
      }
      return unitVector(1);
    });
    registerVectorRuntime(databasePath, {
      embedderLabel: "provider:openai:test-embed",
      backendLabel: "provider:openai:test-embed",
      embedText,
    });

    const addTool = createMemoryAddTool({ config });
    const searchTool = createMemorySearchTool({ config });

    await addTool.execute("provider-add", {
      content: "We selected SQLite as the durable store for Engram.",
      kind: "DECISION",
    });

    const result = await searchTool.execute("provider-search", {
      query: "Which durable store did we choose?",
      topK: 3,
      minScore: 0.1,
    });

    expect(embedText).toHaveBeenCalled();
    expect(result.details.memories[0].content).toContain("SQLite");

    const db = getLcmConnection(databasePath);
    const row = db
      .prepare("SELECT dense_embedding_json, embedding_signature FROM memory_vectors LIMIT 1")
      .get() as { dense_embedding_json?: string; embedding_signature?: string };
    expect(row.dense_embedding_json).toContain("[1,0,0");
    expect(String(row.embedding_signature || "")).toContain("provider:openai:test-embed");
  });

  it("uses Falkor external neighbors when configured as the vector backend", async () => {
    config = {
      ...config,
      falkorDbEnabled: true,
      vectorBackend: "falkordb",
    };
    const embedText = vi.fn(async (text: string) =>
      /jordan/i.test(text) ? unitVector(0) : unitVector(1));
    const upsertExternalMemoryVector = vi.fn(async () => undefined);
    const queryExternalNeighbors = vi.fn(async () => [
      { memoryId: "mem_falkor_1", similarity: 0.91 },
    ]);
    registerVectorRuntime(databasePath, {
      embedderLabel: "provider:openai:test-embed",
      externalBackendLabel: "falkordb:test",
      backendLabel: "provider:openai:test-embed+falkordb:test",
      embedText,
      upsertExternalMemoryVector,
      queryExternalNeighbors,
    });

    const db = getLcmConnection(databasePath);
    ensureMemoryTables(db);
    db.prepare(
      `INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status,
        value_score, value_label, created_at, updated_at, tags, provenance, source_layer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "mem_falkor_1",
      "USER_FACT",
      "Jordan prefers oolong tea during code reviews.",
      "jordan prefers oolong tea during code reviews",
      "falkor-hash",
      "manual",
      0.92,
      "shared",
      "active",
      0.88,
      "core",
      "2026-03-19T00:00:00.000Z",
      "2026-03-19T00:00:00.000Z",
      JSON.stringify(["Jordan"]),
      "{}",
      "registry",
    );

    const searchTool = createMemorySearchTool({ config });
    const result = await searchTool.execute("falkor-search", {
      query: "What tea does Jordan prefer?",
      topK: 3,
      minScore: 0.1,
    });

    expect(queryExternalNeighbors).toHaveBeenCalledTimes(1);
    expect(upsertExternalMemoryVector).toHaveBeenCalled();
    expect(result.details.vectorBackend).toBe("falkordb");
    expect(result.details.memories[0].memoryId).toBe("mem_falkor_1");
    expect(result.details.memories[0].vectorSimilarity).toBeGreaterThan(0.8);
  });
});
