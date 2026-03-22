import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import type { LcmContextEngine } from "../src/context/engine.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
} from "../src/context/expansion-auth.js";
import {
  createEntityGetTool,
  createGradientScoreTool,
  createMemoryGetTool,
  createOpsStatusTool,
  createVaultQueryTool,
} from "../src/surface/engram-v2-compat-tools.js";
import { createLcmDescribeTool } from "../src/surface/lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "../src/surface/lcm-expand-query-tool.js";
import { createLcmExpandTool } from "../src/surface/lcm-expand-tool.js";
import { createLcmGrepTool } from "../src/surface/lcm-grep-tool.js";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import { createMemoryQueryTool } from "../src/surface/memory-query-tool.js";
import { createMemorySearchTool } from "../src/surface/memory-search-tool.js";
import type { LcmDependencies } from "../src/types.js";

const README_V2_TOOL_NAMES = [
  "lcm_grep",
  "lcm_describe",
  "lcm_expand_query",
  "memory_add",
  "memory_search",
  "memory_query",
  "memory_get",
  "entity_get",
  "vault_query",
  "gradient_score",
  "ops_status",
  "lcm_expand",
] as const;

function resultText(result: { content: Array<{ type?: unknown; text?: unknown }> }): string {
  return result.content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

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
    recallMinScore: 0.12,
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

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

function readLatestAssistantReply(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const block = part as { type?: unknown; text?: unknown };
          return block.type === "text" && typeof block.text === "string" ? block.text : "";
        })
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function makeDeps(
  config: LcmConfig,
  callGateway: (params: { method: string; params?: Record<string, unknown> }) => Promise<unknown>,
): LcmDependencies {
  return {
    config,
    complete: vi.fn(),
    callGateway,
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as LcmDependencies;
}

function makeEngine(params: {
  grep?: ReturnType<typeof vi.fn>;
  describe?: ReturnType<typeof vi.fn>;
  expand?: ReturnType<typeof vi.fn>;
  conversationId?: number;
}): LcmContextEngine {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    getRetrieval: () => ({
      grep: params.grep ?? vi.fn(),
      describe: params.describe ?? vi.fn(),
      expand: params.expand ?? vi.fn(),
    }),
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(async () =>
        typeof params.conversationId === "number"
          ? {
              conversationId: params.conversationId,
              sessionId: "session-1",
              title: null,
              bootstrappedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }
          : null,
      ),
    }),
  } as unknown as LcmContextEngine;
}

type RegisteredEngineFactory = (() => unknown) | undefined;

function buildApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
} {
  let factory: RegisteredEngineFactory;
  const api = {
    id: "engram",
    name: "Engram",
    source: "/tmp/engram",
    config: {},
    pluginConfig,
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      modelAuth: {
        getApiKeyForModel: vi.fn(async () => undefined),
        resolveApiKeyForProvider: vi.fn(async () => undefined),
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn((_id: string, nextFactory: () => unknown) => {
      factory = nextFactory;
    }),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getFactory: () => factory,
  };
}

function collectRegisteredToolNames(api: OpenClawPluginApi): string[] {
  const registerTool = api.registerTool as unknown as ReturnType<typeof vi.fn>;
  return registerTool.mock.calls
    .map(([factory]) => {
      const tool = (
        factory as (ctx: { sessionKey: string }) => {
          name: string;
        }
      )({ sessionKey: "agent:main:test-session" });
      return tool.name;
    })
    .sort();
}

describe("Engram v2 README contract", () => {
  let databasePath: string;
  let config: LcmConfig;

  beforeEach(() => {
    databasePath = join(tmpdir(), `engram-readme-${randomUUID()}.sqlite`);
    config = makeConfig(databasePath);
    resetDelegatedExpansionGrantsForTests();
  });

  afterEach(() => {
    resetDelegatedExpansionGrantsForTests();
    closeLcmConnection(databasePath);
    rmSync(databasePath, { force: true });
  });

  it("registers the exact 12 README tool names from the v2 contract", () => {
    const { api } = buildApi({
      enabled: true,
      databasePath,
    });

    lcmPlugin.register(api);

    const registered = collectRegisteredToolNames(api);
    expect(registered).toEqual(expect.arrayContaining([...README_V2_TOOL_NAMES]));
  });

  it("exercises the README memory-side tools together", async () => {
    const addTool = createMemoryAddTool({ config });
    const searchTool = createMemorySearchTool({ config });
    const queryTool = createMemoryQueryTool({ config });
    const getTool = createMemoryGetTool({ config });
    const entityGetTool = createEntityGetTool({ config });
    const vaultQueryTool = createVaultQueryTool({ config });
    const gradientTool = createGradientScoreTool({ config });
    const opsStatusTool = createOpsStatusTool({ config });

    const addResult = await addTool.execute("readme-memory-add", {
      content: "Jordan prefers peppermint tea when fixing late-night Engram issues.",
      kind: "PREFERENCE",
      entities: ["Jordan", "Engram"],
    });

    expect(addResult.details.stored).toBe(true);
    expect(addResult.details.memoryId).toMatch(/^mem_/);

    const searchResult = await searchTool.execute("readme-memory-search", {
      query: "What drink does Jordan prefer?",
      topK: 5,
      minScore: 0.12,
    });
    expect(searchResult.details.count).toBeGreaterThan(0);
    expect(searchResult.details.memories[0].content).toContain("peppermint tea");

    const queryResult = await queryTool.execute("readme-memory-query", {
      query: "What drink does Jordan prefer when working late?",
      topK: 5,
      minScore: 0.12,
    });
    expect(queryResult.details.result).toContain("peppermint tea");
    expect(queryResult.details.sourceIds).toContain(addResult.details.memoryId);

    const getResult = await getTool.execute("readme-memory-get", {
      id: addResult.details.memoryId,
    });
    expect(getResult.details.itemType).toBe("memory");
    expect(getResult.details.memory.content).toContain("peppermint tea");

    const entityResult = await entityGetTool.execute("readme-entity-get", {
      name: "Jordan",
    });
    expect(entityResult.details.itemType).toBe("entity");
    expect(entityResult.details.entity.name).toBe("Jordan");

    const db = getLcmConnection(databasePath);
    db.exec(`CREATE TABLE IF NOT EXISTS openstinger_vault_entries (
      entry_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_episodes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    db.prepare(
      `INSERT INTO openstinger_vault_entries (
        entry_id, category, key, value, confidence, source_episodes
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "vault_readme_1",
      "methodology",
      "tea_preference",
      "Jordan reaches for peppermint tea during late-night debugging sessions.",
      0.91,
      JSON.stringify(["ep_tea"]),
    );

    const vaultResult = await vaultQueryTool.execute("readme-vault-query", {
      query: "peppermint",
      category: "methodology",
    });
    expect(vaultResult.details.count).toBe(1);
    expect(vaultResult.details.results[0].value).toContain("peppermint tea");

    const gradientResult = await gradientTool.execute("readme-gradient-score", {
      response: "Ship the fix without deleting user data and verify it first.",
    });
    expect(gradientResult.details.status).toBe("active");
    expect(gradientResult.details.verdict).toBe("pass");

    const opsResult = await opsStatusTool.execute("readme-ops-status", {});
    expect(opsResult.details.memory.active_memories).toBeGreaterThan(0);
    expect(opsResult.details.memory.vector_rows).toBeGreaterThan(0);
    expect(opsResult.details.memory.vector_backend).toBe("sqlite_vec");
  });

  it("exercises the README LCM-side tools together", async () => {
    const grep = vi.fn(async () => ({
      messages: [
        {
          messageId: 101,
          conversationId: 42,
          role: "assistant",
          snippet: "Jordan prefers peppermint tea during incident response.",
          createdAt: new Date("2026-03-19T10:00:00.000Z"),
          rank: 0,
        },
      ],
      summaries: [
        {
          summaryId: "sum_readme",
          conversationId: 42,
          kind: "leaf",
          snippet: "Jordan prefers peppermint tea during incident response.",
          createdAt: new Date("2026-03-19T10:00:00.000Z"),
        },
      ],
      totalMatches: 2,
    }));
    const describe = vi.fn(async () => ({
      id: "sum_readme",
      type: "summary",
      summary: {
        conversationId: 42,
        kind: "leaf",
        content: "Jordan prefers peppermint tea during incident response.",
        depth: 0,
        tokenCount: 18,
        descendantCount: 0,
        descendantTokenCount: 0,
        sourceMessageTokenCount: 18,
        fileIds: [],
        parentIds: [],
        childIds: [],
        messageIds: [101],
        earliestAt: new Date("2026-03-19T10:00:00.000Z"),
        latestAt: new Date("2026-03-19T10:00:00.000Z"),
        subtree: [
          {
            summaryId: "sum_readme",
            parentSummaryId: null,
            depthFromRoot: 0,
            kind: "leaf",
            depth: 0,
            tokenCount: 18,
            descendantCount: 0,
            descendantTokenCount: 0,
            sourceMessageTokenCount: 18,
            earliestAt: new Date("2026-03-19T10:00:00.000Z"),
            latestAt: new Date("2026-03-19T10:00:00.000Z"),
            childCount: 0,
            path: "",
          },
        ],
        createdAt: new Date("2026-03-19T10:00:00.000Z"),
      },
    }));
    const expand = vi.fn(async () => ({
      children: [],
      messages: [],
      estimatedTokens: 36,
      truncated: false,
    }));

    const callGateway = vi.fn(async (params: { method: string; params?: Record<string, unknown> }) => {
      if (params.method === "agent") {
        return { runId: "run-readme" };
      }
      if (params.method === "agent.wait") {
        return { status: "ok" };
      }
      if (params.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Jordan prefers peppermint tea.",
                    citedIds: ["sum_readme"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 36,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (params.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps(config, callGateway);
    const engine = makeEngine({
      grep,
      describe,
      expand,
      conversationId: 42,
    });

    const grepTool = createLcmGrepTool({
      deps,
      lcm: engine,
      sessionId: "agent:main:main",
    });
    const grepResult = await grepTool.execute("readme-lcm-grep", {
      pattern: "peppermint",
    });
    expect(resultText(grepResult)).toContain("peppermint tea");

    const describeTool = createLcmDescribeTool({
      deps,
      lcm: engine,
      sessionId: "agent:main:main",
    });
    const describeResult = await describeTool.execute("readme-lcm-describe", {
      id: "sum_readme",
      allConversations: true,
    });
    expect(resultText(describeResult)).toContain("manifest");

    const expandQueryTool = createLcmExpandQueryTool({
      deps,
      lcm: engine,
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const expandQueryResult = await expandQueryTool.execute("readme-lcm-expand-query", {
      summaryIds: ["sum_readme"],
      prompt: "What drink does Jordan prefer?",
      conversationId: 42,
      maxTokens: 400,
    });
    expect(expandQueryResult.details.answer).toContain("peppermint tea");
    expect(expandQueryResult.details.citedIds).toEqual(["sum_readme"]);

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:readme-contract",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });

    const expandTool = createLcmExpandTool({
      deps,
      lcm: engine,
      sessionId: "agent:main:subagent:readme-contract",
    });
    const expandResult = await expandTool.execute("readme-lcm-expand", {
      summaryIds: ["sum_readme"],
      conversationId: 42,
    });
    expect(expandResult.details.expansionCount).toBe(1);
    expect(expandResult.details.totalTokens).toBe(36);
    expect(expand).toHaveBeenCalledOnce();
  });
});
