import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import {
  captureMemoryNotesFromAgentEnd,
  capturePreCompactionMemories,
  parseMemoryNotes,
  sanitizeMemoryNoteMessage,
} from "../src/memory/capture.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import { makeTestConfig } from "./test-config.js";

const TEST_DB_PATH = ":memory:";

function makeConfig(databasePath = TEST_DB_PATH): LcmConfig {
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
    maxExpandTokens: 120,
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

function buildApi(dbPath: string): OpenClawPluginApi {
  return {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig: { enabled: true, dbPath },
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
    registerContextEngine: vi.fn(),
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
}

describe("memory_note capture", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection(TEST_DB_PATH);
  });

  it("parses explicit memory_note tags", () => {
    const notes = parseMemoryNotes(`
      <memory_note type="FACT" confidence="0.93">Riley is Jordan's partner.</memory_note>
      <memory_note type='USERFACT' confidence='high' scope="shared" entities="Riley, Jordan">Jordan likes mozzarella.</memory_note>
      <memory_note action="protect" target_memory_id="x"></memory_note>
    `);

    expect(notes).toEqual([
      {
        kind: "USER_FACT",
        content: "Riley is Jordan's partner.",
        confidence: 0.93,
        scope: undefined,
        entities: [],
      },
      {
        kind: "USER_FACT",
        content: "Jordan likes mozzarella.",
        confidence: 0.9,
        scope: "shared",
        entities: ["Riley", "Jordan"],
      },
    ]);
  });

  it("stores explicit memory_note captures through the shared memory pipeline", () => {
    const result = captureMemoryNotesFromAgentEnd({
      config,
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: [
        { role: "user", content: "remember this" },
        {
          role: "assistant",
          content: `
            Saved.
            <memory_note type="PREFERENCE" confidence="0.9" entities="Lucas">User prefers peppermint tea.</memory_note>
            <memory_note type="CONTEXT" confidence="0.4">User is tired right now.</memory_note>
          `,
        },
      ],
    });

    expect(result).toEqual({
      processed: 2,
      stored: 1,
      skippedLowConfidence: 1,
      rejected: 0,
      memoryIds: [expect.stringMatching(/^mem_/)],
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const memory = db.prepare(`
      SELECT type, content, source, source_agent, source_session, source_trigger, confidence, provenance
      FROM memory_current
      WHERE content = 'User prefers peppermint tea.'
    `).get() as Record<string, unknown> | undefined;
    expect(memory).toBeDefined();
    expect(memory?.type).toBe("PREFERENCE");
    expect(memory?.source).toBe("capture");
    expect(memory?.source_agent).toBe("main");
    expect(memory?.source_session).toBe("agent:main:main");
    expect(memory?.source_trigger).toBe("agent_end");
    expect(Number(memory?.confidence)).toBe(0.9);
    expect(JSON.parse(String(memory?.provenance ?? "{}"))).toMatchObject({
      trigger: "agent_end",
      extractor: "memory_note",
      sourceMessage: {
        role: "assistant",
      },
      note: {
        kind: "PREFERENCE",
        entities: ["Lucas"],
      },
    });

    const event = db.prepare(`
      SELECT component, source
      FROM memory_events
      WHERE memory_id = ?
    `).get(result.memoryIds[0]) as Record<string, unknown> | undefined;
    expect(event?.component).toBe("capture_hook");
    expect(event?.source).toBe("capture");
  });

  it("captures durable pre-compaction memories with provenance", () => {
    const result = capturePreCompactionMemories({
      config,
      conversationId: 42,
      sessionFile: "/tmp/pre-compaction-session.jsonl",
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: [
        {
          messageId: 11,
          seq: 3,
          role: "assistant",
          content: "We decided to use SQLite for memory storage.",
          createdAt: new Date("2026-03-19T12:00:00.000Z"),
        },
        {
          messageId: 12,
          seq: 4,
          role: "user",
          content: "I prefer peppermint tea.",
          createdAt: new Date("2026-03-19T12:01:00.000Z"),
        },
      ],
    });

    expect(result).toEqual({
      processed: 2,
      stored: 2,
      skippedLowConfidence: 0,
      rejected: 0,
      memoryIds: [expect.stringMatching(/^mem_/), expect.stringMatching(/^mem_/)],
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const rows = db.prepare(`
      SELECT type, content, source, source_trigger, provenance
      FROM memory_current
      WHERE source = 'pre_compaction'
      ORDER BY type ASC
    `).all() as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.type)).toEqual(["DECISION", "PREFERENCE"]);
    expect(rows.map((row) => row.source_trigger)).toEqual(["pre_compaction", "pre_compaction"]);

    const decisionProvenance = JSON.parse(String(rows[0]?.provenance ?? "{}")) as Record<string, unknown>;
    const preferenceProvenance = JSON.parse(String(rows[1]?.provenance ?? "{}")) as Record<string, unknown>;

    expect(decisionProvenance).toMatchObject({
      trigger: "pre_compaction",
      extractor: "heuristic",
      conversationId: 42,
      sessionFile: "/tmp/pre-compaction-session.jsonl",
      sourceMessage: {
        role: "assistant",
        messageId: 11,
        seq: 3,
      },
      rule: "decision_statement",
    });
    expect(preferenceProvenance).toMatchObject({
      trigger: "pre_compaction",
      extractor: "heuristic",
      conversationId: 42,
      sourceMessage: {
        role: "user",
        messageId: 12,
        seq: 4,
      },
      rule: "preference_statement",
    });
  });

  it("strips memory_note tags from assistant messages before persistence", () => {
    expect(
      sanitizeMemoryNoteMessage({
        role: "assistant",
        content: "Saved.\n<memory_note type=\"USER_FACT\" confidence=\"0.9\">User likes tea.</memory_note>",
      }),
    ).toEqual({
      message: {
        role: "assistant",
        content: "Saved.",
      },
    });

    expect(
      sanitizeMemoryNoteMessage({
        role: "assistant",
        content: "<memory_note type=\"USER_FACT\" confidence=\"0.9\">User likes tea.</memory_note>",
      }),
    ).toEqual({ block: true });
  });
});

describe("agent_end capture hook", () => {
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
  });

  it("registers agent_end capture and stores emitted memory_note tags", async () => {
    const dbPath = join(tmpdir(), `engram-capture-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const api = buildApi(dbPath);
    lcmPlugin.register(api);

    const beforeWriteHook = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === "before_message_write",
    )?.[1] as
      | ((event: { message: { role: string; content: string } }) => { block?: boolean; message?: unknown })
      | undefined;
    expect(beforeWriteHook).toBeTypeOf("function");
    expect(
      beforeWriteHook?.({
        message: {
          role: "assistant",
          content:
            'Done.\n<memory_note type="USER_FACT" confidence="0.9">User likes tea.</memory_note>',
        },
      }),
    ).toEqual({
      message: {
        role: "assistant",
        content: "Done.",
      },
    });

    const hook = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === "agent_end",
    )?.[1] as
      | ((event: { messages: unknown[] }, ctx: { agentId?: string; sessionKey?: string }) => Promise<void>)
      | undefined;
    expect(hook).toBeTypeOf("function");

    await hook?.(
      {
        messages: [
          {
            role: "assistant",
            content:
              '<memory_note type="DECISION" confidence="0.82">We decided to use SQLite for memory storage.</memory_note>',
          },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    );

    const db = getLcmConnection(dbPath);
    const row = db.prepare(`
      SELECT type, content, source, source_agent, source_session
      FROM memory_current
      WHERE content = 'We decided to use SQLite for memory storage.'
    `).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.type).toBe("DECISION");
    expect(row?.source).toBe("capture");
    expect(row?.source_agent).toBe("main");
    expect(row?.source_session).toBe("agent:main:main");
  });
});
