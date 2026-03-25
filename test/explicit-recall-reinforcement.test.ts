import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import { createMemoryQueryTool } from "../src/surface/memory-query-tool.js";
import { createMemoryRecallTool } from "../src/surface/memory-recall-tool.js";
import { createMemorySearchTool } from "../src/surface/memory-search-tool.js";
import { makeTestConfig } from "./test-config.js";

type MemoryState = {
  retrieval_count: number;
  reinforcement_count: number;
  activation_strength: number;
  last_retrieved_at: string | null;
  last_reinforced_at: string | null;
};

type ReinforcementEvent = {
  memory_id: string;
};

function makeConfig(databasePath: string): LcmConfig {
  return makeTestConfig({
    databasePath,
    activationModelEnabled: true,
    activationModelRolloutFraction: 1,
    recallTopK: 6,
    recallMinScore: 0.1,
    recallMaxTokens: 1200,
  });
}

function readMemoryState(db: ReturnType<typeof getLcmConnection>, memoryId: string): MemoryState {
  return db
    .prepare(`
      SELECT retrieval_count, reinforcement_count, activation_strength, last_retrieved_at, last_reinforced_at
      FROM memory_current
      WHERE memory_id = ?
    `)
    .get(memoryId) as MemoryState;
}

function readReinforcementEvents(
  db: ReturnType<typeof getLcmConnection>,
  component: string,
  action: string,
): ReinforcementEvent[] {
  return db
    .prepare(`
      SELECT memory_id
      FROM memory_events
      WHERE component = ? AND action = ?
      ORDER BY timestamp, memory_id
    `)
    .all(component, action) as ReinforcementEvent[];
}

function collectGroupedIds(grouped: Record<string, Array<{ id: string }>>): string[] {
  return Object.values(grouped).flatMap((items) => items.map((item) => item.id));
}

describe("explicit recall reinforcement surfaces", () => {
  let config: LcmConfig;
  let databasePath: string;

  beforeEach(() => {
    databasePath = join(mkdtempSync(join(tmpdir(), "openclaw-explicit-recall-")), "lcm.sqlite");
    config = makeConfig(databasePath);
  });

  afterEach(() => {
    closeLcmConnection(databasePath);
    rmSync(join(databasePath, ".."), { recursive: true, force: true });
  });

  it("reinforces only search results that were actually returned", async () => {
    const addTool = createMemoryAddTool({ config });
    const searchTool = createMemorySearchTool({ config });
    const db = getLcmConnection(databasePath);

    const first = await addTool.execute("seed-1", {
      content: "Lucas prefers explicit rollout checklists before any deploy.",
      kind: "PREFERENCE",
    });
    const second = await addTool.execute("seed-2", {
      content: "The team keeps an explicit rollout checklist for every release candidate.",
      kind: "DECISION",
    });
    const third = await addTool.execute("seed-3", {
      content: "Viktor enjoys archive gardening on weekends.",
      kind: "USER_FACT",
    });

    const beforeFirst = readMemoryState(db, first.details.memoryId);
    const beforeSecond = readMemoryState(db, second.details.memoryId);
    const beforeThird = readMemoryState(db, third.details.memoryId);

    const result = await searchTool.execute("search-1", {
      query: "explicit rollout checklist",
      topK: 2,
      minScore: 0,
    });

    const returnedIds = result.details.memories.map((memory: { memoryId: string }) => memory.memoryId);
    expect(returnedIds).toHaveLength(2);

    const events = readReinforcementEvents(db, "memory_search", "reinforce_search");
    expect(events.map((event) => event.memory_id)).toEqual([...returnedIds].sort());

    const afterFirst = readMemoryState(db, first.details.memoryId);
    const afterSecond = readMemoryState(db, second.details.memoryId);
    const afterThird = readMemoryState(db, third.details.memoryId);

    expect(afterFirst.retrieval_count).toBe(beforeFirst.retrieval_count + 1);
    expect(afterFirst.reinforcement_count).toBe(beforeFirst.reinforcement_count + 1);
    expect(afterFirst.activation_strength).toBeGreaterThan(beforeFirst.activation_strength);
    expect(afterFirst.last_retrieved_at).not.toBeNull();
    expect(afterFirst.last_reinforced_at).not.toBeNull();

    expect(afterSecond.retrieval_count).toBe(beforeSecond.retrieval_count + 1);
    expect(afterSecond.reinforcement_count).toBe(beforeSecond.reinforcement_count + 1);
    expect(afterSecond.activation_strength).toBeGreaterThan(beforeSecond.activation_strength);

    expect(afterThird.retrieval_count).toBe(beforeThird.retrieval_count);
    expect(afterThird.reinforcement_count).toBe(beforeThird.reinforcement_count);
    expect(afterThird.activation_strength).toBe(beforeThird.activation_strength);
  });

  it("reinforces only recall results that were actually returned", async () => {
    const addTool = createMemoryAddTool({ config });
    const recallTool = createMemoryRecallTool({ config });
    const db = getLcmConnection(databasePath);

    const preference = await addTool.execute("seed-4", {
      content: "Lucas prefers structured recall summaries.",
      kind: "PREFERENCE",
    });
    const decision = await addTool.execute("seed-5", {
      content: "The team decided to keep SQLite as the durable memory store.",
      kind: "DECISION",
    });
    const fact = await addTool.execute("seed-6", {
      content: "Viktor usually works in the afternoon.",
      kind: "USER_FACT",
    });

    const beforePreference = readMemoryState(db, preference.details.memoryId);
    const beforeDecision = readMemoryState(db, decision.details.memoryId);
    const beforeFact = readMemoryState(db, fact.details.memoryId);

    const result = await recallTool.execute("recall-1", {
      topK: 2,
      minConfidence: 0.1,
    });

    const returnedIds = collectGroupedIds(result.details.grouped as Record<string, Array<{ id: string }>>);
    expect(returnedIds).toHaveLength(2);

    const events = readReinforcementEvents(db, "memory_recall", "reinforce_recall");
    expect(events.map((event) => event.memory_id)).toEqual([...returnedIds].sort());

    const afterPreference = readMemoryState(db, preference.details.memoryId);
    const afterDecision = readMemoryState(db, decision.details.memoryId);
    const afterFact = readMemoryState(db, fact.details.memoryId);

    for (const [before, after] of [
      [beforePreference, afterPreference],
      [beforeDecision, afterDecision],
    ] as const) {
      expect(after.retrieval_count).toBe(before.retrieval_count + 1);
      expect(after.reinforcement_count).toBe(before.reinforcement_count + 1);
      expect(after.activation_strength).toBeGreaterThan(before.activation_strength);
      expect(after.last_retrieved_at).not.toBeNull();
      expect(after.last_reinforced_at).not.toBeNull();
    }

    expect(afterFact.retrieval_count).toBe(beforeFact.retrieval_count);
    expect(afterFact.reinforcement_count).toBe(beforeFact.reinforcement_count);
    expect(afterFact.activation_strength).toBe(beforeFact.activation_strength);
  });

  it("reinforces only query results that were actually returned", async () => {
    const addTool = createMemoryAddTool({ config });
    const queryTool = createMemoryQueryTool({ config });
    const db = getLcmConnection(databasePath);

    const first = await addTool.execute("seed-7", {
      content: "Engram keeps explicit rollout checklists for safe deploys.",
      kind: "USER_FACT",
      entities: ["Engram"],
    });
    const second = await addTool.execute("seed-8", {
      content: "Engram favors short, structured recall summaries.",
      kind: "PREFERENCE",
      entities: ["Engram"],
    });

    const beforeFirst = readMemoryState(db, first.details.memoryId);
    const beforeSecond = readMemoryState(db, second.details.memoryId);

    const result = await queryTool.execute("query-1", {
      query: "explicit rollout checklist",
      strategy: "quick_context",
      topK: 2,
      minScore: 0,
    });

    const returnedIds = (result.details.memories as Array<{ id: string }>).map((memory) => memory.id);
    expect(returnedIds).toHaveLength(2);

    const events = readReinforcementEvents(db, "memory_query", "reinforce_query");
    expect(events.map((event) => event.memory_id)).toEqual([...returnedIds].sort());

    const afterFirst = readMemoryState(db, first.details.memoryId);
    const afterSecond = readMemoryState(db, second.details.memoryId);

    expect(afterFirst.retrieval_count).toBe(beforeFirst.retrieval_count + 1);
    expect(afterFirst.reinforcement_count).toBe(beforeFirst.reinforcement_count + 1);
    expect(afterSecond.retrieval_count).toBe(beforeSecond.retrieval_count + 1);
    expect(afterSecond.reinforcement_count).toBe(beforeSecond.reinforcement_count + 1);
  });
});
