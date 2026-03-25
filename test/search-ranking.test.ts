/**
 * Search ranking tests.
 *
 * Validates that the memory recall scoring system applies the correct
 * type-based multipliers, heartbeat penalties, and final sorting order.
 *
 * These tests import the scoreCandidate function indirectly by testing
 * the scoring logic through fetchMemoryCandidates with in-memory SQLite.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { makeTestConfig } from "./test-config.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import { hashNormalized, normalizeContent } from "../src/memory/memory-utils.js";
import { fetchMemoryCandidates } from "../src/surface/memory-recall-core.js";

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-ranking-"));
  tempDirs.add(dir);
  return dir;
}

function makeDb() {
  const dir = makeTempDir();
  const dbPath = join(dir, "lcm.db");
  dbPaths.add(dbPath);
  return { db: getLcmConnection(dbPath), dbPath, dir };
}

function makeActivationConfig() {
  return makeTestConfig({
    databasePath: ":memory:",
    activationModelEnabled: true,
    activationModelRolloutFraction: 1,
  });
}

function insertMemory(
  db: ReturnType<typeof getLcmConnection>,
  params: {
    memoryId: string;
    type: string;
    content: string;
    confidence?: number;
    valueScore?: number;
    status?: string;
    scope?: string;
    createdAt?: string;
    updatedAt?: string;
  },
) {
  const normalized = normalizeContent(params.content);
  const hash = hashNormalized(params.content);
  const createdAt = params.createdAt ?? new Date().toISOString();
  const updatedAt = params.updatedAt ?? createdAt;
  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash,
      source, confidence, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, tags, superseded_by,
      content_time, source_layer, source_path, source_line
    ) VALUES (?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, 'situational', ?, ?, NULL, '[]', NULL, NULL, 'registry', NULL, NULL)
  `).run(
    params.memoryId,
    params.type,
    params.content,
    normalized,
    hash,
    params.confidence ?? 0.8,
    params.scope ?? "shared",
    params.status ?? "active",
    params.valueScore ?? 0.7,
    createdAt,
    updatedAt,
  );
}

afterEach(() => {
  for (const dbPath of dbPaths) closeLcmConnection(dbPath);
  dbPaths.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ---------------------------------------------------------------------------
// Type multiplier tests
// ---------------------------------------------------------------------------

describe("search ranking — type multipliers", () => {
  it("EPISODE entries get 0.6x multiplier resulting in lower scores", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    // Insert two memories with identical text relevance but different types
    insertMemory(db, {
      memoryId: "mem_episode_1",
      type: "EPISODE",
      content: "Lucas deployed the new engram version today",
      confidence: 0.8,
      valueScore: 0.7,
    });
    insertMemory(db, {
      memoryId: "mem_userfact_1",
      type: "USER_FACT",
      content: "Lucas deployed the new engram version permanently",
      confidence: 0.8,
      valueScore: 0.7,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "Lucas engram deploy",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const episode = result.memories.find((m) => m.type === "EPISODE");
    const userFact = result.memories.find((m) => m.type === "USER_FACT");

    expect(episode).toBeDefined();
    expect(userFact).toBeDefined();
    expect(episode!.scoreBreakdown.typeMultiplier).toBeCloseTo(0.6, 1);
    expect(userFact!.scoreBreakdown.typeMultiplier).toBeCloseTo(1.0, 1);
    // USER_FACT should rank higher than EPISODE due to the multiplier
    expect(userFact!.score).toBeGreaterThan(episode!.score);
  });

  it("PREFERENCE entries get 1.3x multiplier resulting in higher scores", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_pref_1",
      type: "PREFERENCE",
      content: "Lucas prefers dark mode in all editors and terminals",
      confidence: 0.8,
      valueScore: 0.7,
    });
    insertMemory(db, {
      memoryId: "mem_fact_1",
      type: "USER_FACT",
      content: "Lucas uses dark mode in all editors and terminals",
      confidence: 0.8,
      valueScore: 0.7,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "dark mode editors",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const pref = result.memories.find((m) => m.type === "PREFERENCE");
    const fact = result.memories.find((m) => m.type === "USER_FACT");

    expect(pref).toBeDefined();
    expect(fact).toBeDefined();
    expect(pref!.scoreBreakdown.typeMultiplier).toBeCloseTo(1.3, 1);
    expect(fact!.scoreBreakdown.typeMultiplier).toBeCloseTo(1.0, 1);
    // PREFERENCE should rank higher than USER_FACT
    expect(pref!.score).toBeGreaterThan(fact!.score);
  });

  it("DECISION entries get 1.2x multiplier", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_decision_1",
      type: "DECISION",
      content: "We decided to use SQLite for all persistent storage needs",
      confidence: 0.8,
      valueScore: 0.7,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "SQLite storage",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const decision = result.memories.find((m) => m.type === "DECISION");
    expect(decision).toBeDefined();
    expect(decision!.scoreBreakdown.typeMultiplier).toBeCloseTo(1.2, 1);
  });

  it("CONTEXT entries get 0.8x multiplier", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_context_1",
      type: "CONTEXT",
      content: "The project uses a monorepo structure with TypeScript throughout",
      confidence: 0.8,
      valueScore: 0.7,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "monorepo TypeScript",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const ctx = result.memories.find((m) => m.type === "CONTEXT");
    expect(ctx).toBeDefined();
    expect(ctx!.scoreBreakdown.typeMultiplier).toBeCloseTo(0.8, 1);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat penalty tests
// ---------------------------------------------------------------------------

describe("search ranking — heartbeat penalty", () => {
  it("heartbeat-pattern EPISODEs get additional 0.5x penalty on top of EPISODE multiplier", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    // Use a shared keyword ("operational") so both match the same query
    insertMemory(db, {
      memoryId: "mem_heartbeat_1",
      type: "EPISODE",
      content: "HEARTBEAT_OK: all operational systems are nominal and health remains clean",
      confidence: 0.8,
      valueScore: 0.7,
    });
    insertMemory(db, {
      memoryId: "mem_normal_ep_1",
      type: "EPISODE",
      content: "Lucas paired with Viktor on the operational deployment today",
      confidence: 0.8,
      valueScore: 0.7,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "operational",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const heartbeat = result.memories.find((m) => m.id === "mem_heartbeat_1");
    const normalEp = result.memories.find((m) => m.id === "mem_normal_ep_1");

    expect(heartbeat).toBeDefined();
    expect(normalEp).toBeDefined();
    // Heartbeat EPISODE: 0.6 * 0.5 = 0.3 multiplier
    expect(heartbeat!.scoreBreakdown.typeMultiplier).toBeCloseTo(0.3, 1);
    // Normal EPISODE: 0.6 multiplier (no heartbeat penalty)
    expect(normalEp!.scoreBreakdown.typeMultiplier).toBeCloseTo(0.6, 1);
    expect(normalEp!.score).toBeGreaterThan(heartbeat!.score);
  });

  it("detects various heartbeat patterns for penalty", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    const heartbeatContents = [
      "heartbeat status report for all running agents in the cluster",
      "system health check completed with no errors found today",
      "status dump from the monitoring pipeline at midnight today",
    ];

    for (let i = 0; i < heartbeatContents.length; i++) {
      insertMemory(db, {
        memoryId: `mem_hb_${i}`,
        type: "EPISODE",
        content: heartbeatContents[i],
        confidence: 0.8,
        valueScore: 0.7,
      });
    }

    const result = await fetchMemoryCandidates(db, {
      query: "heartbeat health status dump monitoring",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    for (const memory of result.memories) {
      // All of these should have the additional heartbeat penalty applied
      expect(
        memory.scoreBreakdown.typeMultiplier,
        `${memory.content.slice(0, 40)} should have heartbeat penalty`,
      ).toBeCloseTo(0.3, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Score composition and sorting
// ---------------------------------------------------------------------------

describe("search ranking — score composition and sorting", () => {
  it("type multipliers are applied after raw score calculation", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_comp_1",
      type: "PREFERENCE",
      content: "Lucas prefers the Vitest test runner for all projects",
      confidence: 0.9,
      valueScore: 0.85,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "Vitest test runner",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const mem = result.memories.find((m) => m.id === "mem_comp_1");
    expect(mem).toBeDefined();

    // The final score = rawScore * typeMultiplier
    // Verify the breakdown components exist and multiply correctly
    const bd = mem!.scoreBreakdown;
    const rawScore = bd.confidence * bd.activation + bd.value + bd.lexical + bd.vector + bd.temporal + bd.entity;
    expect(mem!.score).toBeCloseTo(rawScore * bd.typeMultiplier, 2);
  });

  it("results are sorted by final weighted score descending", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    // Insert memories that should have different final scores
    insertMemory(db, {
      memoryId: "mem_sort_pref",
      type: "PREFERENCE",
      content: "Lucas strongly prefers using SQLite for embedded databases",
      confidence: 0.9,
      valueScore: 0.85,
    });
    insertMemory(db, {
      memoryId: "mem_sort_episode",
      type: "EPISODE",
      content: "Today Lucas tested SQLite performance for embedded databases",
      confidence: 0.9,
      valueScore: 0.85,
    });
    insertMemory(db, {
      memoryId: "mem_sort_fact",
      type: "USER_FACT",
      content: "Lucas uses SQLite as the main embedded database engine",
      confidence: 0.9,
      valueScore: 0.85,
    });

    const result = await fetchMemoryCandidates(db, {
      query: "SQLite embedded database",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    expect(result.memories.length).toBeGreaterThanOrEqual(2);

    // Verify descending order
    for (let i = 1; i < result.memories.length; i++) {
      expect(
        result.memories[i - 1].score,
        `memories[${i - 1}].score >= memories[${i}].score`,
      ).toBeGreaterThanOrEqual(result.memories[i].score);
    }
  });
});

describe("search ranking — activation-aware confidence", () => {
  it("falls back to legacy recency decay when activation columns are absent", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_activation_fresh",
      type: "USER_FACT",
      content: "Activation fallback check for ranking behavior",
      confidence: 0.9,
      valueScore: 0.7,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:00:00.000Z",
    });
    insertMemory(db, {
      memoryId: "mem_activation_old",
      type: "USER_FACT",
      content: "Activation fallback check for ranking behavior older",
      confidence: 0.9,
      valueScore: 0.7,
      createdAt: "2025-01-01T10:00:00.000Z",
      updatedAt: "2025-01-01T10:00:00.000Z",
    });

    const result = await fetchMemoryCandidates(db, {
      config: makeActivationConfig(),
      query: "activation fallback ranking behavior",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const fresh = result.memories.find((m) => m.id === "mem_activation_fresh");
    const old = result.memories.find((m) => m.id === "mem_activation_old");
    expect(fresh).toBeDefined();
    expect(old).toBeDefined();
    expect(fresh!.effectiveConfidence).toBeGreaterThan(old!.effectiveConfidence);
  });

  it("treats zero activation values as fallback and non-zero values as retrievability signals", async () => {
    const { db } = makeDb();
    ensureMemoryTables(db);
    db.exec("ALTER TABLE memory_current ADD COLUMN activation REAL");

    insertMemory(db, {
      memoryId: "mem_activation_zero",
      type: "USER_FACT",
      content: "Activation signal ranking memory zero",
      confidence: 0.9,
      valueScore: 0.7,
      createdAt: "2025-01-01T10:00:00.000Z",
      updatedAt: "2025-01-01T10:00:00.000Z",
    });
    insertMemory(db, {
      memoryId: "mem_activation_boosted",
      type: "USER_FACT",
      content: "Activation signal ranking memory boosted",
      confidence: 0.9,
      valueScore: 0.7,
      createdAt: "2025-01-01T10:00:00.000Z",
      updatedAt: "2025-01-01T10:00:00.000Z",
    });

    db.prepare("UPDATE memory_current SET activation = ? WHERE memory_id = ?").run(0, "mem_activation_zero");
    db.prepare("UPDATE memory_current SET activation = ? WHERE memory_id = ?").run(0.95, "mem_activation_boosted");

    const result = await fetchMemoryCandidates(db, {
      config: makeActivationConfig(),
      query: "activation signal ranking memory",
      topK: 10,
      minScore: 0,
      maxTokens: 5000,
      allScopes: true,
    });

    const zero = result.memories.find((m) => m.id === "mem_activation_zero");
    const boosted = result.memories.find((m) => m.id === "mem_activation_boosted");
    expect(zero).toBeDefined();
    expect(boosted).toBeDefined();

    // Zero activation should fall back to legacy decay and remain non-zero.
    expect(zero!.activation).toBeGreaterThan(0);
    expect(boosted!.activation).toBeGreaterThan(zero!.activation);
    expect(boosted!.effectiveConfidence).toBeGreaterThan(zero!.effectiveConfidence);
    expect(boosted!.score).toBeGreaterThan(zero!.score);
  });
});
