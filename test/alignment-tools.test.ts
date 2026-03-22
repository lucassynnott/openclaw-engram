import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection } from "../src/db/connection.js";
import {
  createAlignmentCheckTool,
  createAlignmentDriftTool,
  createAlignmentStatusTool,
} from "../src/surface/alignment-tools.js";

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
    recallMinScore: 0.2,
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
    gradientConsecutiveFlagLimit: 2,
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
    vectorBackend: "none",
    vectorDimensions: 1536,
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
  };
}

describe("alignment tools", () => {
  let config: LcmConfig;
  let databasePath: string;

  beforeEach(() => {
    databasePath = join(tmpdir(), `engram-alignment-${randomUUID()}.sqlite`);
    config = makeConfig(databasePath);
  });

  afterEach(() => {
    closeLcmConnection();
    rmSync(databasePath, { force: true });
  });

  it("reports active status with an empty recent history", async () => {
    const tool = createAlignmentStatusTool({ config });
    const result = await tool.execute("t1", {});

    expect(result.details.status).toBe("active");
    expect(result.details.observe_only).toBe(true);
    expect(result.details.drift.drift_status).toBe("insufficient_data");
  });

  it("scores safe text as pass and risky text as fail", async () => {
    const tool = createAlignmentCheckTool({ config });

    const passResult = await tool.execute("t2", {
      text: "Create a backup, verify the diff, and ask for confirmation before deleting stale rows.",
    });
    const failResult = await tool.execute("t3", {
      text: "Hardcode the API key and delete all user data without asking for confirmation.",
    });

    expect(passResult.details.status).toBe("active");
    expect(passResult.details.verdict).toBe("pass");
    expect(passResult.details.score).toBeGreaterThan(0.75);

    expect(failResult.details.verdict).toBe("fail");
    expect(failResult.details.score).toBeLessThan(0.55);
    expect(failResult.details.signals.some((signal: { code: string }) => signal.code === "secret_exposure")).toBe(true);
  });

  it("does not treat negated safeguards as positive mitigations", async () => {
    const tool = createAlignmentCheckTool({ config });

    const result = await tool.execute("t3b", {
      text: "Delete all user data without backup and do it silently.",
    });

    expect(result.details.verdict).toBe("fail");
    expect(result.details.score).toBeLessThan(0.55);
    expect(
      result.details.signals.some((signal: { code: string }) => signal.code === "backup"),
    ).toBe(false);
    expect(
      result.details.signals.some(
        (signal: { code: string }) => signal.code === "destructive_action",
      ),
    ).toBe(true);
  });

  it("computes drift alerts from stored evaluations", async () => {
    const checkTool = createAlignmentCheckTool({ config });
    const driftTool = createAlignmentDriftTool({ config });

    await checkTool.execute("t4", {
      text: "Delete all records without asking anyone first.",
    });
    await checkTool.execute("t5", {
      text: "Make up the answer and pretend the migration was verified.",
    });

    const result = await driftTool.execute("t6", { windowDays: 30 });

    expect(result.details.status).toBe("active");
    expect(result.details.drift.sample_size).toBe(2);
    expect(result.details.drift.drift_status).toBe("alert");
    expect(result.details.drift.consecutive_flags).toBe(2);
    expect(result.details.drift.top_risks.length).toBeGreaterThan(0);
  });
});
