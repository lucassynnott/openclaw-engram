import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { hashNormalized, normalizeContent } from "../src/memory/memory-utils.js";
import { createMemoryAddTool } from "../src/surface/memory-add-tool.js";
import {
  createEntityGetTool,
  createEntityMergeTool,
  createGradientScoreTool,
  createMemoryGetTool,
  createOpsStatusTool,
  createVaultQueryTool,
} from "../src/surface/engram-v2-compat-tools.js";
import { makeTestConfig } from "./test-config.js";

const TEST_DB_PATH = ":memory:";

function makeConfig(): LcmConfig {
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

describe("engram v2 compatibility tools", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection(TEST_DB_PATH);
  });

  it("memory_get fetches a raw memory by ID", async () => {
    const addTool = createMemoryAddTool({ config });
    const getTool = createMemoryGetTool({ config });

    const addResult = await addTool.execute("t1", {
      content: "Lucas prefers exact tool contracts over vague plugin promises",
      kind: "PREFERENCE",
      entities: ["Lucas"],
    });

    const result = await getTool.execute("t2", {
      id: addResult.details.memoryId,
    });

    expect(result.details.itemType).toBe("memory");
    expect(result.details.memory.id).toBe(addResult.details.memoryId);
    expect(result.details.memory.kind).toBe("PREFERENCE");
  });

  it("memory_get fetches summary and file records by ID", async () => {
    const db = getLcmConnection(TEST_DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        earliest_at TEXT,
        latest_at TEXT,
        descendant_count INTEGER NOT NULL DEFAULT 0,
        descendant_token_count INTEGER NOT NULL DEFAULT 0,
        source_message_token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS large_files (
        file_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        file_name TEXT,
        mime_type TEXT,
        byte_size INTEGER,
        storage_uri TEXT NOT NULL,
        exploration_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
    db.prepare(
      `INSERT INTO summaries (
        summary_id, conversation_id, kind, depth, content, token_count, file_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("sum_demo", 1, "leaf", 0, "Compacted Engram detail", 42, JSON.stringify(["file_demo"]));
    db.prepare(
      `INSERT INTO large_files (
        file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("file_demo", 1, "notes.md", "text/markdown", 1234, "file:///tmp/notes.md", "A markdown file");

    const getTool = createMemoryGetTool({ config });

    const summaryResult = await getTool.execute("t3", { id: "sum_demo" });
    const fileResult = await getTool.execute("t4", { id: "file_demo" });

    expect(summaryResult.details.itemType).toBe("summary");
    expect(summaryResult.details.summary.id).toBe("sum_demo");
    expect(fileResult.details.itemType).toBe("file");
    expect(fileResult.details.file.id).toBe("file_demo");
  });

  it("entity_get resolves by fuzzy name and returns related memories", async () => {
    const addTool = createMemoryAddTool({ config });
    const entityGetTool = createEntityGetTool({ config });

    await addTool.execute("t5", {
      content: "Lucas is building Engram v2 compatibility surfaces this week",
      kind: "USER_FACT",
      entities: ["Lucas", "Engram"],
    });

    const result = await entityGetTool.execute("t6", {
      name: "Lucas",
    });

    expect(result.details.itemType).toBe("entity");
    expect(result.details.entity.name).toBe("Lucas");
    expect(Array.isArray(result.details.links)).toBe(true);
    expect(Array.isArray(result.details.memories) || Array.isArray(result.details.beliefs)).toBe(true);
  });

  it("entity_merge persists a durable merge override", async () => {
    const addTool = createMemoryAddTool({ config });
    const mergeTool = createEntityMergeTool({ config });
    const entityGetTool = createEntityGetTool({ config });

    await addTool.execute("t_merge_1", {
      content: "Lucas owns Engram release coordination and rollout diagnostics",
      kind: "USER_FACT",
      entities: ["Lucas"],
      dedupeMode: "none",
    });
    await addTool.execute("t_merge_2", {
      content: "Lukas handles Engram partner coordination and launch notes",
      kind: "USER_FACT",
      entities: ["Lukas"],
      dedupeMode: "none",
    });

    const mergeResult = await mergeTool.execute("t_merge_3", {
      winnerName: "Lucas",
      loserName: "Lukas",
      reason: "same person alias",
    });

    expect(mergeResult.details.ok).toBe(true);
    expect(mergeResult.details.winnerEntityId).toMatch(/^person:/);

    const entityResult = await entityGetTool.execute("t_merge_4", {
      entityId: String(mergeResult.details.winnerEntityId),
    });
    expect(entityResult.details.entity.id).toBe(mergeResult.details.winnerEntityId);
    expect(Array.isArray(entityResult.details.links)).toBe(true);
  });

  it("ops_status aggregates counts across memory and LCM surfaces", async () => {
    const addTool = createMemoryAddTool({ config });
    await addTool.execute("t7", {
      content: "Lucas decided to expose memory_get and entity_get in Engram",
      kind: "DECISION",
      entities: ["Lucas", "Engram"],
    });

    const db = getLcmConnection(TEST_DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      earliest_at TEXT,
      latest_at TEXT,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      descendant_token_count INTEGER NOT NULL DEFAULT 0,
      source_message_token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_ids TEXT NOT NULL DEFAULT '[]'
    );`);
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, file_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sum_ops", 1, "leaf", 0, "Ops summary", 10, "[]");

    const tool = createOpsStatusTool({ config });
    const result = await tool.execute("t8", {});

    expect(result.details.status).toBe("healthy");
    expect(result.details.rollout.ready).toBe(true);
    expect(result.details.warnings).toContain("vault mirror is disabled");
    expect(result.details.memory.active_memories).toBeGreaterThan(0);
    expect(result.details.memory.vector_rows).toBeGreaterThan(0);
    expect(result.details.lcm.summaries).toBeGreaterThan(0);
    expect(result.details.world_model.links).toBeGreaterThanOrEqual(0);
    expect(result.details.alignment.status).toBe("active");
  });

  it("ops_status exposes activation rollout observability counters", async () => {
    config.activationModelEnabled = true;
    config.activationModelRolloutFraction = 1;
    config.hygieneTieringEnabled = true;
    config.hygieneTieringMode = "observe";

    const addTool = createMemoryAddTool({ config });
    const addResult = await addTool.execute("t_ops_obs_1", {
      content: "Engram keeps explicit rollout checklists before every deploy.",
      kind: "DECISION",
    });
    await addTool.execute("t_ops_obs_2", {
      content: "Engram keeps explicit rollout checklists before every deploy.",
      kind: "DECISION",
    });

    const db = getLcmConnection(TEST_DB_PATH);
    db.prepare(`
      UPDATE memory_current
      SET retrieval_count = 1,
          reinforcement_count = 2,
          activation_strength = 0.88,
          truth_confidence = COALESCE(truth_confidence, confidence),
          last_reinforced_at = ?,
          last_retrieved_at = ?
      WHERE memory_id = ?
    `).run(
      "2026-03-20T12:00:00.000Z",
      "2026-03-21T09:30:00.000Z",
      addResult.details.memoryId,
    );

    db.prepare(`
      INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
      VALUES (?, ?, 'memory_search', 'reinforce_search', ?, 'system', ?)
    `).run(
      "evt_ops_search",
      "2026-03-21T09:30:00.000Z",
      addResult.details.memoryId,
      JSON.stringify({ query: "rollout checklist" }),
    );

    const coldCandidateContent = "January checkpoint: reviewed a minor note about backlog triage.";
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, truth_confidence, activation_strength, reinforcement_count, retrieval_count,
        last_reinforced_at, last_retrieved_at, decay_exempt, scope, status, value_score, value_label,
        created_at, updated_at, archived_at, tags, superseded_by,
        content_time, source_layer, source_path, source_line, last_reviewed_at
      ) VALUES (?, 'EPISODE', ?, ?, ?, 'manual', 0.42, 0.42, 0.08, 0, 0, NULL, NULL, 0, 'shared', 'active', 0.2, 'archive_candidate', ?, ?, NULL, '[]', NULL, ?, 'registry', NULL, NULL, NULL)
    `).run(
      "mem_ops_cold_candidate",
      coldCandidateContent,
      normalizeContent(coldCandidateContent),
      hashNormalized(coldCandidateContent),
      "2026-01-10T10:00:00.000Z",
      "2026-01-10T10:00:00.000Z",
      "2026-01-10",
    );

    const archivedEpisodeContent = "February checkpoint: archived deployment housekeeping note.";
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash,
        source, confidence, truth_confidence, activation_strength, reinforcement_count, retrieval_count,
        last_reinforced_at, last_retrieved_at, decay_exempt, scope, status, value_score, value_label,
        created_at, updated_at, archived_at, tags, superseded_by,
        content_time, source_layer, source_path, source_line, last_reviewed_at
      ) VALUES (?, 'EPISODE', ?, ?, ?, 'manual', 0.38, 0.38, 0.04, 0, 0, NULL, NULL, 0, 'shared', 'archived', 0.18, 'archive_candidate', ?, ?, ?, '[]', NULL, ?, 'registry', NULL, NULL, NULL)
    `).run(
      "mem_ops_cold_archived",
      archivedEpisodeContent,
      normalizeContent(archivedEpisodeContent),
      hashNormalized(archivedEpisodeContent),
      "2026-02-01T09:00:00.000Z",
      "2026-02-01T09:00:00.000Z",
      "2026-03-01T09:00:00.000Z",
      "2026-02-01",
    );

    const tool = createOpsStatusTool({ config });
    const result = await tool.execute("t_ops_obs_3", {});
    const activation = result.details.memory.activation_model as Record<string, unknown>;

    expect(activation.enabled).toBe(true);
    expect(activation.rollout_fraction).toBe(1);
    expect(activation.hygiene_tiering_mode).toBe("observe");
    expect(Number(activation.reinforce_capture_events)).toBeGreaterThanOrEqual(1);
    expect(Number(activation.reinforce_search_events)).toBe(1);
    expect(Number(activation.total_reinforcement_events)).toBeGreaterThanOrEqual(2);
    expect(Number(activation.duplicate_to_reinforce_ratio)).toBeGreaterThan(0);
    expect(Number(activation.retrieved_memories)).toBeGreaterThanOrEqual(1);
    expect(Number(activation.cold_tier_candidate_episodes)).toBeGreaterThanOrEqual(1);
    expect(Number(activation.cold_tier_archived_episodes)).toBeGreaterThanOrEqual(1);
  });

  it("gradient_score exposes the alignment compatibility surface", async () => {
    const tool = createGradientScoreTool({ config });
    const result = await tool.execute("t9", {
      response: "Ship the change without deleting user data.",
    });

    expect(result.details.compatibility_alias).toBe("alignment_check");
    expect(result.details.status).toBe("active");
    expect(result.details.verdict).toBe("pass");
  });

  it("vault_query reads imported StingerVault entries when available", async () => {
    const db = getLcmConnection(TEST_DB_PATH);
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
      "vault_1",
      "methodology",
      "coding_style",
      "Lucas prefers TypeScript and explicit contracts.",
      0.93,
      JSON.stringify(["ep_1"]),
    );

    const tool = createVaultQueryTool({ config });
    const result = await tool.execute("t10", {
      query: "TypeScript",
      category: "methodology",
    });

    expect(result.details.source).toBe("openstinger_vault_entries");
    expect(result.details.count).toBe(1);
    expect(result.details.results[0].category).toBe("methodology");
  });
});
