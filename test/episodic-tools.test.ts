import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LcmContextEngine } from "../src/context/engine.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import {
  resetEpisodicIngestionSchedulersForTests,
  setEpisodicIngestionHooksForTests,
  waitForEpisodicIngestionIdle,
} from "../src/memory/episodic-jobs.js";
import {
  createMemoryIngestNowTool,
  createMemoryJobStatusTool,
  createMemoryListAgentsTool,
} from "../src/surface/episodic-tools.js";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import type { LcmDependencies } from "../src/types.js";
import { makeTestConfig } from "./test-config.js";

const tempDirs: string[] = [];
type AgentMessage = Parameters<LcmContextEngine["ingest"]>[0]["message"];

function createTestConfig(databasePath: string): LcmConfig {
  return makeTestConfig({
    databasePath,
    contextThreshold: 0.75,
    freshTailCount: 8,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    vaultEnabled: false,
    vaultPath: "",
    vaultSubdir: "Engram",
    vaultHomeNoteName: "Home",
    vaultManualFolders: "Inbox,Manual",
    vaultClean: true,
    vaultReportsEnabled: true,
    obsidianMode: "curated",
    obsidianExportDiagnostics: false,
  });
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY),
    requireApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY ?? "test-api-key"),
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => process.env.HOME ?? tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createEngineAndConfig(): { config: LcmConfig; engine: LcmContextEngine } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-episodic-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  return {
    config,
    engine: new LcmContextEngine(createTestDeps(config)),
  };
}

function makeMessage(params: { role?: string; content: string }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

async function seedMessages(params: {
  engine: LcmContextEngine;
  sessionId: string;
  messages: AgentMessage[];
}): Promise<void> {
  for (const message of params.messages) {
    await params.engine.ingest({
      sessionId: params.sessionId,
      message,
    });
  }
}

afterEach(() => {
  resetEpisodicIngestionSchedulersForTests();
  setEpisodicIngestionHooksForTests(undefined);
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("episodic ingestion tools", () => {
  it("queues and completes a background ingestion job for the current session", async () => {
    const { config, engine } = createEngineAndConfig();
    const sessionId = "episodic-session-1";
    const sessionKey = "agent:main:episodic-session-1";
    await seedMessages({
      engine,
      sessionId,
      messages: [
        makeMessage({
          role: "user",
          content: "User prefers TypeScript over JavaScript for new services",
        }),
        makeMessage({
          role: "assistant",
          content: "Today Lucas finished the background episodic ingestion job rollout",
        }),
      ],
    });

    const ingestTool = createMemoryIngestNowTool({
      config,
      deps: {
        resolveSessionIdFromSessionKey: async (key) => (key === sessionKey ? sessionId : undefined),
      },
      sessionKey,
    });
    const start = await ingestTool.execute("call-1", {});

    expect(start.details).toMatchObject({
      status: "queued",
      sessionId,
      deduped: false,
      retried: false,
    });

    await waitForEpisodicIngestionIdle(config);

    const statusTool = createMemoryJobStatusTool({ config });
    const status = await statusTool.execute("call-2", {
      jobId: (start.details as { jobId: string }).jobId,
    });

    expect(status.details).toMatchObject({
      status: "completed",
      job: expect.objectContaining({
        processedCount: 2,
        storedCount: 2,
        skippedCount: 0,
      }),
    });

    const db = getLcmConnection(config.databasePath);
    const memories = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_current").get() as { c: number } | undefined)?.c ?? 0,
    );
    const episodes = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_episodes").get() as { c: number } | undefined)?.c ?? 0,
    );
    expect(memories).toBe(2);
    expect(episodes).toBe(1);
  });

  it("dedupes active jobs and reports queue state", async () => {
    const { config, engine } = createEngineAndConfig();
    const sessionId = "episodic-session-2";
    await seedMessages({
      engine,
      sessionId,
      messages: [
        makeMessage({
          role: "user",
          content: "User prefers strict TypeScript settings in this repo",
        }),
        makeMessage({
          role: "assistant",
          content: "We decided to keep the queue state in SQLite for durability",
        }),
      ],
    });

    let releaseFirstMessage: (() => void) | undefined;
    let blocked = false;
    setEpisodicIngestionHooksForTests({
      beforeProcessMessage: async () => {
        if (blocked) return;
        blocked = true;
        await new Promise<void>((resolve) => {
          releaseFirstMessage = resolve;
        });
      },
    });

    const ingestTool = createMemoryIngestNowTool({ config, sessionId });
    const first = await ingestTool.execute("call-1", {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await ingestTool.execute("call-2", {});

    expect((second.details as { jobId: string }).jobId).toBe(
      (first.details as { jobId: string }).jobId,
    );
    expect(second.details).toMatchObject({
      deduped: true,
    });

    const statusTool = createMemoryJobStatusTool({ config });
    const queue = await statusTool.execute("call-3", {});
    const summary = queue.details as { queue: { pending: number; running: number } };
    expect(summary.queue.pending + summary.queue.running).toBe(1);

    releaseFirstMessage?.();
    await waitForEpisodicIngestionIdle(config);
  });

  it("retries failed jobs from the last successful message without duplicating memories", async () => {
    const { config, engine } = createEngineAndConfig();
    const sessionId = "episodic-session-3";
    await seedMessages({
      engine,
      sessionId,
      messages: [
        makeMessage({
          role: "user",
          content: "User prefers short, direct commit messages",
        }),
        makeMessage({
          role: "user",
          content: "Today Lucas implemented the ingestion retry path",
        }),
        makeMessage({
          role: "user",
          content: "User prefers storing retry state in SQLite for resilience",
        }),
      ],
    });

    let failedOnce = false;
    setEpisodicIngestionHooksForTests({
      beforeProcessMessage: async ({ seq }) => {
        if (!failedOnce && seq === 2) {
          failedOnce = true;
          throw new Error("forced failure");
        }
      },
    });

    const ingestTool = createMemoryIngestNowTool({ config, sessionId });
    const first = await ingestTool.execute("call-1", {});
    await waitForEpisodicIngestionIdle(config);

    const statusTool = createMemoryJobStatusTool({ config });
    const failedStatus = await statusTool.execute("call-2", {
      jobId: (first.details as { jobId: string }).jobId,
    });
    expect(failedStatus.details).toMatchObject({
      status: "failed",
      job: expect.objectContaining({
        attempts: 1,
        processedCount: 1,
        storedCount: 1,
      }),
    });

    setEpisodicIngestionHooksForTests(undefined);
    const retry = await ingestTool.execute("call-3", {});
    expect(retry.details).toMatchObject({
      jobId: (first.details as { jobId: string }).jobId,
      retried: true,
    });

    await waitForEpisodicIngestionIdle(config);

    const completedStatus = await statusTool.execute("call-4", {
      jobId: (first.details as { jobId: string }).jobId,
    });
    expect(completedStatus.details).toMatchObject({
      status: "completed",
      job: expect.objectContaining({
        attempts: 2,
        processedCount: 3,
        storedCount: 2,
        skippedCount: 1,
      }),
    });

    const db = getLcmConnection(config.databasePath);
    const stored = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memory_current").get() as { c: number } | undefined)?.c ?? 0,
    );
    expect(stored).toBe(2);
  });

  it("reads completed job state back from SQLite after reopening the database", async () => {
    const { config, engine } = createEngineAndConfig();
    const sessionId = "episodic-session-4";
    await seedMessages({
      engine,
      sessionId,
      messages: [
        makeMessage({
          role: "user",
          content: "User prefers reopening SQLite job state over rebuilding it in memory",
        }),
      ],
    });

    const ingestTool = createMemoryIngestNowTool({ config, sessionId });
    const start = await ingestTool.execute("call-1", {});
    await waitForEpisodicIngestionIdle(config);

    closeLcmConnection(config.databasePath);

    const statusTool = createMemoryJobStatusTool({ config });
    const status = await statusTool.execute("call-2", {
      jobId: (start.details as { jobId: string }).jobId,
    });

    expect(status.details).toMatchObject({
      status: "completed",
      job: expect.objectContaining({
        jobId: (start.details as { jobId: string }).jobId,
        sessionId,
        processedCount: 1,
        storedCount: 1,
      }),
    });
  });

  it("keeps the default namespace view for single-agent setups", async () => {
    const { config } = createEngineAndConfig();
    const listTool = createMemoryListAgentsTool({ config });
    const result = await listTool.execute("call-1", {});

    expect(result.details).toMatchObject({
      currentNamespace: "default",
      agents: [
        expect.objectContaining({
          namespace: "default",
          current: true,
          defaultNamespace: true,
          memoryCount: 0,
          jobCount: 0,
          activeJobs: 0,
          ingestedSessions: 0,
        }),
      ],
    });
  });

  it("lists discovered namespaces while folding the main agent into the default namespace", async () => {
    const { config, engine } = createEngineAndConfig();
    const deps = createTestDeps(config);

    const defaultAddTool = createMemoryAddTool({
      config,
      deps,
      sessionKey: "agent:main:memory-default",
    });
    await defaultAddTool.execute("call-1", {
      content: "User prefers keeping the shared namespace as the default for main-agent memories",
    });

    const plannerAddTool = createMemoryAddTool({
      config,
      deps,
      sessionKey: "agent:planner:memory-planner",
    });
    await plannerAddTool.execute("call-2", {
      content: "Planner agent prefers reviewing migration diffs before rollout",
    });

    const reviewerSessionId = "episodic-session-reviewer";
    await seedMessages({
      engine,
      sessionId: reviewerSessionId,
      messages: [
        makeMessage({
          role: "assistant",
          content: "Today the reviewer agent validated the SQLite namespace listing path",
        }),
      ],
    });

    const reviewerIngestTool = createMemoryIngestNowTool({
      config,
      deps,
      sessionId: reviewerSessionId,
      sessionKey: "agent:reviewer:episodic-reviewer",
    });
    await reviewerIngestTool.execute("call-3", {});
    await waitForEpisodicIngestionIdle(config);

    const listTool = createMemoryListAgentsTool({
      config,
      deps,
      sessionKey: "agent:planner:list-agents",
    });
    const result = await listTool.execute("call-4", {});
    const details = result.details as {
      currentNamespace: string;
      agents: Array<{
        namespace: string;
        current: boolean;
        defaultNamespace: boolean;
        memoryCount: number;
        jobCount: number;
        ingestedSessions: number;
      }>;
    };

    expect(details.currentNamespace).toBe("planner");
    expect(details.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "default",
          defaultNamespace: true,
          memoryCount: 1,
        }),
        expect.objectContaining({
          namespace: "planner",
          current: true,
          memoryCount: 1,
        }),
        expect.objectContaining({
          namespace: "reviewer",
          jobCount: 1,
          ingestedSessions: 1,
        }),
      ]),
    );
  });
});
