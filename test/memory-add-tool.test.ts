import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyValue } from "../src/memory/memory-utils.js";
import { createMemoryAddTool, storeMemory } from "../src/surface/memory-add-tool.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import { makeTestConfig } from "./test-config.js";

const TEST_DB_PATH = ":memory:";

function makeConfig(overrides: Partial<LcmConfig> = {}): LcmConfig {
  return makeTestConfig({
    databasePath: TEST_DB_PATH,
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
    ...overrides,
  });
}

function findArchiveCandidateContent(): string {
  const candidates = [
    "OpenClaw update: cron pipeline implementation notes",
    "The script runs as part of the nightly cron pipeline",
    "OpenClaw update: implementation notes for the cron pipeline",
    "Context: cron pipeline and script follow-up",
    "Release checklist for the cron pipeline implementation",
  ];
  const match = candidates.find((content) => classifyValue(content, "CONTEXT", 0.75).action === "archive");
  if (!match) {
    throw new Error("failed to find an archive-candidate sample for memory_add tests");
  }
  return match;
}

describe("memory_add tool", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection(TEST_DB_PATH);
  });

  it("has the correct name and description", () => {
    const tool = createMemoryAddTool({ config });
    expect(tool.name).toBe("memory_add");
    expect(tool.description).toContain("Manually store");
  });

  it("stores a PREFERENCE memory successfully", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t1", {
      content: "Lucas prefers dark mode in all editor configurations",
      kind: "PREFERENCE",
      scope: "shared",
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.kind).toBe("PREFERENCE");
    expect(result.details.scope).toBe("shared");
    expect(result.details.status).toBe("active");
    expect(result.details.memoryId).toMatch(/^mem_/);
  });

  it("persists to the database", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t1", {
      content: "Lucas is a senior software engineer who builds AI memory systems",
      kind: "USER_FACT",
    });
    expect(result.details.stored).toBe(true);

    // Verify it's actually in the DB
    const db = getLcmConnection(TEST_DB_PATH);
    const row = db
      .prepare("SELECT * FROM memory_current WHERE memory_id = ?")
      .get(result.details.memoryId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.type).toBe("USER_FACT");
    expect(row?.scope).toBe("shared");
    expect(Number(row?.truth_confidence)).toBeGreaterThan(0);
    expect(Number(row?.activation_strength)).toBeGreaterThan(0);
    expect(Number(row?.reinforcement_count)).toBe(1);
  });

  it("rejects junk content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t2", { content: "API_KEY=abc123secret" });
    expect(result.details.stored).toBe(false);
    expect(result.details.reason).toBe("rejected_quality_gate");
    expect(result.details.gate).toBe("junk");
  });

  it("rejects content that is too short", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t3", { content: "hi" });
    expect(result.details.stored).toBe(false);
    expect(result.details.gate).toBe("junk");
    expect(result.details.detail).toBe("too_short");
  });

  it("rejects empty content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t4", { content: "" });
    expect(result.details.error).toBeDefined();
  });

  it("returns error for missing content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t5", {});
    expect(result.details.error).toBeDefined();
  });

  it("creates an episode for temporal content", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t6", {
      content: "Today Lucas finished implementing the memory_add tool for engram",
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.kind).toBe("EPISODE");
    expect(result.details.episodeId).toMatch(/^ep_/);

    // Verify episode in DB
    const db = getLcmConnection(TEST_DB_PATH);
    const ep = db
      .prepare("SELECT * FROM memory_episodes WHERE episode_id = ?")
      .get(result.details.episodeId) as Record<string, unknown> | undefined;
    expect(ep).toBeDefined();
    expect(ep?.status).toBe("completed");
  });

  it("creates episode when kind is EPISODE explicitly", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t7", {
      content: "Lucas attended the OpenClaw architecture review session last week",
      kind: "EPISODE",
    });
    expect(result.details.kind).toBe("EPISODE");
    expect(result.details.episodeId).not.toBeNull();
  });

  it("links entities and creates them in the DB", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t8", {
      content: "Lucas and Viktor are collaborating on the engram plugin project",
      entities: ["Lucas", "Viktor"],
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.entityIds).toHaveLength(2);

    const db = getLcmConnection(TEST_DB_PATH);
    const entities = db
      .prepare("SELECT * FROM memory_entities ORDER BY normalized_name")
      .all() as Array<Record<string, unknown>>;
    expect(entities.some((e) => e.normalized_name === "lucas")).toBe(true);
    expect(entities.some((e) => e.normalized_name === "viktor")).toBe(true);
  });

  it("infers kind from content when not provided", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t9", {
      content: "User prefers TypeScript over JavaScript for all new projects",
    });
    expect(result.details.stored).toBe(true);
    expect(result.details.kind).toBe("PREFERENCE");
  });

  it("defaults scope to 'shared'", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t10", {
      content: "Lucas is working on an AI-powered memory system for developer agents",
    });
    expect(result.details.scope).toBe("shared");
  });

  it("respects custom scope", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t11", {
      content: "This project uses TypeScript with strict null checks enabled everywhere",
      scope: "engram",
    });
    expect(result.details.scope).toBe("engram");
  });

  it("writes an audit event to memory_events", async () => {
    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t12", {
      content: "Lucas decided to use SQLite with WAL mode for the unified memory store",
      kind: "DECISION",
    });
    expect(result.details.stored).toBe(true);

    const db = getLcmConnection(TEST_DB_PATH);
    const event = db
      .prepare("SELECT * FROM memory_events WHERE memory_id = ?")
      .get(result.details.memoryId) as Record<string, unknown> | undefined;
    expect(event).toBeDefined();
    expect(event?.action).toBe("store");
    expect(event?.component).toBe("memory_add");
  });

  it("stores low-value classifications as active by default", async () => {
    const content = findArchiveCandidateContent();
    expect(classifyValue(content, "CONTEXT", 0.75).action).toBe("archive");

    const tool = createMemoryAddTool({ config });
    const result = await tool.execute("t13", {
      content,
      kind: "CONTEXT",
    });

    expect(result.details.stored).toBe(true);
    expect(result.details.status).toBe("active");
    expect(result.details.value_label).toBe("archive_candidate");

    const db = getLcmConnection(TEST_DB_PATH);
    const row = db
      .prepare("SELECT status, archived_at, value_label, value_score FROM memory_current WHERE memory_id = ?")
      .get(result.details.memoryId) as Record<string, unknown> | undefined;
    expect(row?.status).toBe("active");
    expect(row?.archived_at).toBeNull();
    expect(row?.value_label).toBe("archive_candidate");
    expect(Number(row?.value_score)).toBeLessThan(0.3);

    const firstContent = result.content?.[0];
    const text = firstContent?.type === "text" ? String(firstContent.text ?? "") : "";
    expect(text).toContain("stored with a low-value ranking");
    expect(text).not.toContain("archived");
  });

  it("rejects low-value archive candidates when skipArchiveCandidates is set", () => {
    const content = findArchiveCandidateContent();
    const db = getLcmConnection(TEST_DB_PATH);
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content = ?")
      .get(content) as Record<string, unknown> | undefined;
    const result = storeMemory({
      config,
      content,
      kind: "CONTEXT",
      skipArchiveCandidates: true,
      source: "manual",
      component: "memory_add",
    });

    expect(result.stored).toBe(false);
    expect(result.reason).toBe("low_value");
    expect(result.detail).toBe("archive_candidate");
    expect(result.value_label).toBe("archive_candidate");
    expect(result.value_score).toBeDefined();
    expect(result.reason_codes).toContain("low_value");

    const after = db
      .prepare("SELECT COUNT(*) AS c FROM memory_current WHERE content = ?")
      .get(content) as Record<string, unknown> | undefined;
    expect(Number(after?.c)).toBe(Number(before?.c));
  });

  it("reinforces duplicate captures instead of writing a second row", async () => {
    const tool = createMemoryAddTool({
      config: makeConfig({
        activationModelEnabled: true,
        activationModelRolloutFraction: 1,
      }),
    });
    const first = await tool.execute("t13", {
      content: "Lucas prefers explicit rollout checklists before any deploy.",
      kind: "PREFERENCE",
    });
    const second = await tool.execute("t14", {
      content: "Lucas prefers explicit rollout checklists before any deploy.",
      kind: "PREFERENCE",
    });

    expect(first.details.stored).toBe(true);
    expect(second.details.stored).toBe(true);
    expect(second.details.reinforced).toBe(true);
    expect(second.details.memoryId).toBe(first.details.memoryId);

    const db = getLcmConnection(TEST_DB_PATH);
    const counts = db
      .prepare("SELECT COUNT(*) AS c FROM memory_current WHERE type = ? AND content = ?")
      .get("PREFERENCE", "Lucas prefers explicit rollout checklists before any deploy.") as Record<string, unknown>;
    expect(Number(counts.c)).toBe(1);

    const row = db
      .prepare("SELECT reinforcement_count, activation_strength FROM memory_current WHERE memory_id = ?")
      .get(first.details.memoryId) as Record<string, unknown> | undefined;
    expect(Number(row?.reinforcement_count)).toBeGreaterThan(1);
    expect(Number(row?.activation_strength)).toBeGreaterThan(0);
  });

  it("keeps legacy duplicate suppression when activation rollout is disabled", async () => {
    const tool = createMemoryAddTool({ config: makeConfig() });
    const first = await tool.execute("t15", {
      content: "Lucas wants deploy notes attached to each release candidate.",
      kind: "USER_FACT",
    });
    const second = await tool.execute("t16", {
      content: "Lucas wants deploy notes attached to each release candidate.",
      kind: "USER_FACT",
    });

    expect(first.details.stored).toBe(true);
    expect(second.details.stored).toBe(false);
    expect(second.details.reason).toBe("duplicate");
  });
});
