import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import {
  ensureHarvestTable,
  shouldHarvest,
  updateHarvestState,
  countUserTurns,
  formatMessagesForHarvest,
  parseHarvestResponse,
  runHarvest,
  type HarvestDeps,
  type HarvestMessage,
} from "../src/memory/periodic-harvest.js";
import type { LcmConfig } from "../src/db/config.js";
import { resolveLcmConfig } from "../src/db/config.js";

function makeConfig(overrides?: Partial<LcmConfig>): LcmConfig {
  return resolveLcmConfig({}, {
    ...overrides,
  });
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryTables(db);
  ensureHarvestTable(db);
  return db;
}

describe("ensureHarvestTable", () => {
  it("creates the harvest_state table", () => {
    const db = new DatabaseSync(":memory:");
    ensureHarvestTable(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='harvest_state'").get() as { name: string } | undefined;
    expect(row?.name).toBe("harvest_state");
    db.close();
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    ensureHarvestTable(db);
    ensureHarvestTable(db);
    db.close();
  });
});

describe("shouldHarvest", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it("returns true when no previous harvest exists and turns exceed threshold", () => {
    expect(shouldHarvest(db, "sess-1", 10, 10)).toBe(true);
  });

  it("returns false when turns are below threshold", () => {
    expect(shouldHarvest(db, "sess-1", 5, 10)).toBe(false);
  });

  it("returns true when turns since last harvest exceed threshold", () => {
    updateHarvestState(db, "sess-1", 10);
    expect(shouldHarvest(db, "sess-1", 20, 10)).toBe(true);
  });

  it("returns false when turns since last harvest are below threshold", () => {
    updateHarvestState(db, "sess-1", 10);
    expect(shouldHarvest(db, "sess-1", 15, 10)).toBe(false);
  });
});

describe("updateHarvestState", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it("inserts state for new session", () => {
    updateHarvestState(db, "sess-1", 10);
    const row = db.prepare("SELECT * FROM harvest_state WHERE session_id = ?").get("sess-1") as Record<string, unknown>;
    expect(row.last_harvest_turn).toBe(10);
    expect(row.last_harvest_at).toBeTruthy();
  });

  it("updates state on subsequent calls", () => {
    updateHarvestState(db, "sess-1", 10);
    updateHarvestState(db, "sess-1", 25);
    const row = db.prepare("SELECT * FROM harvest_state WHERE session_id = ?").get("sess-1") as Record<string, unknown>;
    expect(row.last_harvest_turn).toBe(25);
  });
});

describe("countUserTurns", () => {
  it("counts user messages", () => {
    const messages: HarvestMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "good" },
    ];
    expect(countUserTurns(messages)).toBe(2);
  });

  it("returns 0 for empty array", () => {
    expect(countUserTurns([])).toBe(0);
  });

  it("ignores non-user roles", () => {
    const messages: HarvestMessage[] = [
      { role: "system", content: "prompt" },
      { role: "assistant", content: "hello" },
    ];
    expect(countUserTurns(messages)).toBe(0);
  });
});

describe("formatMessagesForHarvest", () => {
  it("formats recent messages with role labels", () => {
    const messages: HarvestMessage[] = [
      { role: "user", content: "I prefer dark mode" },
      { role: "assistant", content: "Noted." },
    ];
    const result = formatMessagesForHarvest(messages, 5);
    expect(result).toContain("[USER]: I prefer dark mode");
    expect(result).toContain("[ASSISTANT]: Noted.");
  });

  it("respects lookback limit", () => {
    const messages: HarvestMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    const result = formatMessagesForHarvest(messages, 3);
    // 3 turns = 6 messages from the end
    expect(result).not.toContain("Message 0");
    expect(result).toContain("Message 19");
  });

  it("truncates very long messages", () => {
    const messages: HarvestMessage[] = [
      { role: "user", content: "x".repeat(3000) },
    ];
    const result = formatMessagesForHarvest(messages, 5);
    expect(result.length).toBeLessThan(2100);
    expect(result).toContain("...");
  });

  it("handles array content blocks", () => {
    const messages: HarvestMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ];
    const result = formatMessagesForHarvest(messages, 5);
    expect(result).toContain("hello world");
  });
});

describe("parseHarvestResponse", () => {
  it("parses valid JSON array", () => {
    const response = JSON.stringify([
      { kind: "PREFERENCE", content: "User prefers dark mode in all editors", confidence: 0.85 },
      { kind: "USER_FACT", content: "User works at Applied Leverage as founder", confidence: 0.9 },
    ]);
    const result = parseHarvestResponse(response);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("PREFERENCE");
    expect(result[0].confidence).toBe(0.85);
  });

  it("strips markdown code fences", () => {
    const response = "```json\n" + JSON.stringify([
      { kind: "DECISION", content: "Decided to use Engram for all memory operations", confidence: 0.8 },
    ]) + "\n```";
    const result = parseHarvestResponse(response);
    expect(result).toHaveLength(1);
  });

  it("rejects invalid kinds", () => {
    const response = JSON.stringify([
      { kind: "EPISODE", content: "This should be rejected since EPISODE is not valid", confidence: 0.7 },
      { kind: "PREFERENCE", content: "This should be kept since PREFERENCE is valid", confidence: 0.8 },
    ]);
    const result = parseHarvestResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("PREFERENCE");
  });

  it("rejects very short content", () => {
    const response = JSON.stringify([
      { kind: "USER_FACT", content: "short", confidence: 0.7 },
      { kind: "USER_FACT", content: "This is long enough to be a real memory entry", confidence: 0.7 },
    ]);
    const result = parseHarvestResponse(response);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseHarvestResponse("not json")).toEqual([]);
    expect(parseHarvestResponse("")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseHarvestResponse('{"key": "value"}')).toEqual([]);
  });

  it("clamps confidence to valid range", () => {
    const response = JSON.stringify([
      { kind: "USER_FACT", content: "This has no confidence field at all", },
    ]);
    const result = parseHarvestResponse(response);
    expect(result[0].confidence).toBe(0.7);
  });
});

describe("runHarvest", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it("extracts and stores memories from conversation", async () => {
    const extractedMemories = [
      { kind: "PREFERENCE", content: "User prefers TypeScript over JavaScript for all new code", confidence: 0.85 },
    ];

    const deps: HarvestDeps = {
      config: makeConfig({ databasePath: ":memory:" }),
      complete: async () => ({
        content: [{ type: "text", text: JSON.stringify(extractedMemories) }],
      }),
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      getApiKey: async () => "test-key",
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };

    const messages: HarvestMessage[] = [
      { role: "user", content: "Always use TypeScript, not JavaScript" },
      { role: "assistant", content: "Understood, I'll use TypeScript for all new code." },
    ];

    const result = await runHarvest({ db, deps, sessionId: "test-sess", messages });
    expect(result.extracted).toBe(1);
    expect(result.stored).toBe(1);
  });

  it("handles empty extraction gracefully", async () => {
    const deps: HarvestDeps = {
      config: makeConfig({ databasePath: ":memory:" }),
      complete: async () => ({
        content: [{ type: "text", text: "[]" }],
      }),
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      getApiKey: async () => "test-key",
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };

    const result = await runHarvest({
      db,
      deps,
      sessionId: "test-sess",
      messages: [{ role: "user", content: "What time is it?" }],
    });
    expect(result.extracted).toBe(0);
    expect(result.stored).toBe(0);
  });

  it("handles LLM errors gracefully", async () => {
    const deps: HarvestDeps = {
      config: makeConfig({ databasePath: ":memory:" }),
      complete: async () => { throw new Error("API error"); },
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      getApiKey: async () => "test-key",
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };

    await expect(
      runHarvest({
        db,
        deps,
        sessionId: "test-sess",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("API error");
  });

  it("skips empty message arrays", async () => {
    const deps: HarvestDeps = {
      config: makeConfig({ databasePath: ":memory:" }),
      complete: async () => ({ content: [] }),
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      getApiKey: async () => "test-key",
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };

    const result = await runHarvest({ db, deps, sessionId: "test-sess", messages: [] });
    expect(result.extracted).toBe(0);
  });
});
