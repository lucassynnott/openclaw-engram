import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import { buildProactiveMemoryContext } from "../src/memory/proactive-context.js";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import {
  createMemoryCorrectTool,
  createMemoryRetractTool,
} from "../src/surface/memory-mutation-tools.js";
import { makeTestConfig } from "./test-config.js";

const TEST_DB_PATH = ":memory:";

function makeConfig(): LcmConfig {
  return makeTestConfig({
    databasePath: TEST_DB_PATH,
    vaultEnabled: false,
    nativeEnabled: false,
    gradientEnabled: true,
  });
}

function makeDeps() {
  return {
    parseAgentSessionKey: vi.fn(() => ({ agentId: "main", suffix: "main" })),
    normalizeAgentId: vi.fn(() => "main"),
  };
}

describe("memory mutation and proactive context", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection(TEST_DB_PATH);
  });

  it("suppresses near-duplicate memory_add writes", async () => {
    const tool = createMemoryAddTool({
      config,
      deps: makeDeps(),
      sessionKey: "agent:main:main",
    });

    const first = await tool.execute("t1", {
      content: "Lucas shipped the vault sync fix and restarted the OpenClaw gateway cleanly.",
      kind: "DECISION",
    });
    const second = await tool.execute("t2", {
      content: "Lucas restarted the OpenClaw gateway cleanly after shipping the vault sync fix.",
      kind: "DECISION",
    });

    expect(first.details.stored).toBe(true);
    expect(second.details.stored).toBe(false);
    expect(second.details.reason).toBe("duplicate_semantic");
  });

  it("registers proactive trigger patterns via memory_add", async () => {
    const tool = createMemoryAddTool({
      config,
      deps: makeDeps(),
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("t3", {
      content: "If the user mentions vault sync failures, remind them about the circular Engram subdir check.",
      kind: "DECISION",
      triggerPattern: "vault sync",
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const triggerRow = db
      .prepare("SELECT memory_id, pattern FROM memory_triggers LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    expect(result.details.stored).toBe(true);
    expect(result.details.triggerIds).toHaveLength(1);
    expect(triggerRow?.memory_id).toBe(result.details.memoryId);
    expect(triggerRow?.pattern).toBe("vault sync");
  });

  it("corrects and retracts memories with supersession links", async () => {
    const addTool = createMemoryAddTool({
      config,
      deps: makeDeps(),
      sessionKey: "agent:main:main",
    });
    const correctTool = createMemoryCorrectTool({
      config,
      deps: makeDeps(),
      sessionKey: "agent:main:main",
    });
    const retractTool = createMemoryRetractTool({
      config,
      deps: makeDeps(),
      sessionKey: "agent:main:main",
    });

    const addResult = await addTool.execute("t4", {
      content: "Lucas prefers Vim.",
      kind: "PREFERENCE",
      entities: ["Lucas"],
    });
    const corrected = await correctTool.execute("t5", {
      memoryId: addResult.details.memoryId,
      content: "Lucas prefers Neovim.",
      kind: "PREFERENCE",
      reason: "Updated preference",
    });
    const retracted = await retractTool.execute("t6", {
      memoryId: corrected.details.newMemoryId,
      reason: "Temporary experiment only",
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const original = db
      .prepare("SELECT status, superseded_by FROM memory_current WHERE memory_id = ?")
      .get(addResult.details.memoryId) as Record<string, unknown> | undefined;
    const replacement = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get(corrected.details.newMemoryId) as Record<string, unknown> | undefined;

    expect(corrected.details.corrected).toBe(true);
    expect(original?.status).toBe("superseded");
    expect(original?.superseded_by).toBe(corrected.details.newMemoryId);
    expect(retracted.details.retracted).toBe(true);
    expect(replacement?.status).toBe("superseded");
  });

  it("builds relevance-filtered proactive memory context with trigger attribution", async () => {
    const tool = createMemoryAddTool({
      config,
      deps: makeDeps(),
      sessionKey: "agent:main:main",
    });

    await tool.execute("t7", {
      content: "Lucas tracks vault sync regressions in Engram.",
      kind: "DECISION",
      entities: ["Lucas", "Engram"],
      triggerPattern: "vault sync",
    });
    await tool.execute("t8", {
      content: "Lucas prefers explicit failure reasons from memory_add quality gates.",
      kind: "PREFERENCE",
      entities: ["Lucas"],
    });

    const context = await buildProactiveMemoryContext({
      db: getLcmConnection(TEST_DB_PATH),
      config,
      prompt: "Can you check the vault sync issue and remind me why memory_add rejected that note?",
    });

    expect(context).toContain("<engram-relevant-memory>");
    expect(context).toContain("Triggered memories:");
    expect(context).toContain("stored_by=main");
    expect(context).toContain("Relevant memories:");
  });
});
