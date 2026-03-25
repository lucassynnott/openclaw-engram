import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import type { LcmConfig } from "../src/db/config.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import {
  archiveColdTierEpisodes,
  archiveFragments,
  archiveStaleEpisodes,
  archiveStaleHeartbeats,
  runMemoryHygiene,
} from "../src/memory/memory-hygiene.js";
import {
  isFragmentContent,
  isHeartbeatPattern,
} from "../src/memory/memory-utils.js";
import { storeMemory } from "../src/surface/memory-add-tool.js";
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
    episodeRetentionDays: 7,
    heartbeatDedupeThreshold: 0.7,
    fragmentMinContentChars: 50,
    harvestEnabled: true,
    harvestEveryNTurns: 10,
    harvestLookbackTurns: 20,
    harvestModel: "",
    ...overrides,
  });
}

function insertMemoryDirect(params: {
  config: LcmConfig;
  memoryId: string;
  type: string;
  content: string;
  status?: string;
  createdAt?: string;
  contentTime?: string;
  valueScore?: number | null;
  lastReviewedAt?: string | null;
}): void {
  const db = getLcmConnection(params.config.databasePath);
  ensureMemoryTables(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash,
      source, confidence, scope, status,
      value_score, last_reviewed_at,
      created_at, updated_at, content_time, source_layer
    ) VALUES (?, ?, ?, '', '', 'test', 0.75, 'shared', ?, ?, ?, ?, ?, ?, 'registry')
  `).run(
    params.memoryId,
    params.type,
    params.content,
    params.status ?? "active",
    params.valueScore ?? null,
    params.lastReviewedAt ?? null,
    params.createdAt ?? now,
    now,
    params.contentTime ?? params.createdAt ?? now,
  );
}

describe("isHeartbeatPattern", () => {
  it("detects heartbeat keywords", () => {
    expect(isHeartbeatPattern("Heartbeat recheck: Core health remains clean, same blockers")).toBe(true);
    expect(isHeartbeatPattern("HEARTBEAT_OK: all systems nominal")).toBe(true);
    expect(isHeartbeatPattern("Health check complete, no issues found")).toBe(true);
    expect(isHeartbeatPattern("Approval queue is unchanged since last review")).toBe(true);
    expect(isHeartbeatPattern("Status check shows everything is clean and good")).toBe(true);
    expect(isHeartbeatPattern("Same blockers as before, nothing new")).toBe(true);
  });

  it("does not match normal content", () => {
    expect(isHeartbeatPattern("Lucas deployed the new gateway configuration")).toBe(false);
    expect(isHeartbeatPattern("Decided to use SQLite for memory storage")).toBe(false);
    expect(isHeartbeatPattern("The user prefers dark mode")).toBe(false);
  });
});

describe("isFragmentContent", () => {
  it("detects short fragment content", () => {
    expect(isFragmentContent("Time: 10 minutes")).toBe(true);
    expect(isFragmentContent("Status: OK")).toBe(true);
    expect(isFragmentContent("Lucas preferences")).toBe(true);
    expect(isFragmentContent("")).toBe(true);
  });

  it("allows meaningful short content through", () => {
    expect(isFragmentContent("User prefers dark mode in editors")).toBe(false);
    expect(isFragmentContent("Lucas lives in Amsterdam and works remotely")).toBe(false);
  });

  it("respects custom minChars threshold", () => {
    // Content with 5 distinct meaningful words is not a fragment regardless of threshold
    expect(isFragmentContent("Short but meaningful text here", 20)).toBe(false);
    // Below minChars but has enough distinct words to be meaningful
    expect(isFragmentContent("Short but meaningful text here", 100)).toBe(false);
    // A true fragment: short label-like content with higher minChars
    expect(isFragmentContent("Time: 10 minutes", 100)).toBe(true);
    // Short content with few distinct words under a higher threshold
    expect(isFragmentContent("some query", 100)).toBe(true);
  });
});

describe("archiveStaleEpisodes", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig({ episodeRetentionDays: 7 });
  });

  afterEach(() => {
    closeLcmConnection();
  });

  it("archives EPISODE entries older than retention period", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_old_episode_01",
      type: "EPISODE",
      content: "Heartbeat recheck completed, Core health remains clean",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_recent_ep_01",
      type: "EPISODE",
      content: "Deployed new feature to production today",
      createdAt: twoDaysAgo,
      contentTime: twoDaysAgo,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_old_fact_001",
      type: "USER_FACT",
      content: "Lucas uses TypeScript",
      createdAt: tenDaysAgo,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const result = archiveStaleEpisodes({ db, retentionDays: 7 });

    expect(result.archived).toBe(1);

    // Verify the old episode was archived
    const oldEp = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_old_episode_01") as { status: string };
    expect(oldEp.status).toBe("archived");

    // Verify the recent episode was NOT archived
    const recentEp = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_recent_ep_01") as { status: string };
    expect(recentEp.status).toBe("active");

    // Verify the USER_FACT was NOT touched
    const fact = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_old_fact_001") as { status: string };
    expect(fact.status).toBe("active");
  });

  it("returns zero when no stale episodes exist", () => {
    const db = getLcmConnection(TEST_DB_PATH);
    ensureMemoryTables(db);
    const result = archiveStaleEpisodes({ db, retentionDays: 7 });
    expect(result.archived).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it("does not re-archive already archived episodes", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_already_arch",
      type: "EPISODE",
      content: "Old heartbeat that was already archived",
      status: "archived",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const result = archiveStaleEpisodes({ db, retentionDays: 7 });
    expect(result.archived).toBe(0);
  });
});

describe("archiveStaleHeartbeats", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection();
  });

  it("archives only heartbeat-pattern episodes past retention", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_hb_old_0001",
      type: "EPISODE",
      content: "Heartbeat recheck: Core health remains clean, same blockers",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_real_ep_001",
      type: "EPISODE",
      content: "Deployed the new gateway configuration to production",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const result = archiveStaleHeartbeats({ db, retentionDays: 7 });

    expect(result.archived).toBe(1);

    const hb = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hb_old_0001") as { status: string };
    expect(hb.status).toBe("archived");

    const real = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_real_ep_001") as { status: string };
    expect(real.status).toBe("active");
  });
});

describe("archiveColdTierEpisodes", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection();
  });

  it("archives only low-activation low-value non-heartbeat episodes", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_cold_candidate",
      type: "EPISODE",
      content: "Paired with teammate to run a small migration checklist and notes",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.2,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_cold_high_value",
      type: "EPISODE",
      content: "Shipped high-impact production fix with rollout plan and validation",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.8,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_cold_heartbeat",
      type: "EPISODE",
      content: "HEARTBEAT_OK: all systems nominal, no blockers found",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.1,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_cold_reviewed",
      type: "EPISODE",
      content: "Tracked a small status check from previous sprint handoff",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.2,
      lastReviewedAt: now,
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_cold_activated",
      type: "EPISODE",
      content: "Captured an old task update for reference",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.2,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    db.prepare(`
      INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
      VALUES (?, ?, 'test', 'recall', ?, 'test', '{}')
    `).run("evt_cold_activation", now, "mem_cold_activated");

    const result = archiveColdTierEpisodes({
      db,
      retentionDays: 7,
      maxValueScore: 0.35,
      maxActivationEvents: 0,
      requireUnreviewed: true,
    });

    expect(result.archived).toBe(1);

    const candidate = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_cold_candidate") as { status: string };
    expect(candidate.status).toBe("archived");

    const highValue = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_cold_high_value") as { status: string };
    expect(highValue.status).toBe("active");

    const heartbeat = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_cold_heartbeat") as { status: string };
    expect(heartbeat.status).toBe("active");

    const reviewed = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_cold_reviewed") as { status: string };
    expect(reviewed.status).toBe("active");

    const activated = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_cold_activated") as { status: string };
    expect(activated.status).toBe("active");
  });
});

describe("archiveFragments", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  afterEach(() => {
    closeLcmConnection();
  });

  it("archives short fragment entries", () => {
    insertMemoryDirect({
      config,
      memoryId: "mem_frag_time01",
      type: "USER_FACT",
      content: "Time: 10 minutes",
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_frag_query1",
      type: "USER_FACT",
      content: "Lucas preferences",
    });
    insertMemoryDirect({
      config,
      memoryId: "mem_good_fact01",
      type: "USER_FACT",
      content: "Lucas is a senior software engineer who builds AI memory systems for developer agents",
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const result = archiveFragments({ db, minContentChars: 50 });

    expect(result.archived).toBe(2);

    const frag1 = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_frag_time01") as { status: string };
    expect(frag1.status).toBe("archived");

    const frag2 = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_frag_query1") as { status: string };
    expect(frag2.status).toBe("archived");

    const good = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_good_fact01") as { status: string };
    expect(good.status).toBe("active");
  });
});

describe("runMemoryHygiene", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig({ episodeRetentionDays: 7, fragmentMinContentChars: 50 });
  });

  afterEach(() => {
    closeLcmConnection();
  });

  it("runs all hygiene in one pass", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    // Old episode (content must be >= 50 chars to avoid fragment archival overlap)
    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_old_ep1",
      type: "EPISODE",
      content: "HEARTBEAT_OK: all systems are healthy and running, no blockers found today",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
    });
    // Fragment
    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_frag_01",
      type: "USER_FACT",
      content: "Status: OK",
    });
    // Good content
    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_good_01",
      type: "USER_FACT",
      content: "Lucas prefers TypeScript for all new projects and configurations",
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const result = runMemoryHygiene({ db, config });

    expect(result.staleEpisodes.archived).toBe(1);
    expect(result.staleHeartbeats.archived).toBe(1);
    expect(result.coldTierEpisodes.archived).toBe(0);
    expect(result.fragments.archived).toBe(1);

    // Verify states
    const oldEp = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_old_ep1") as { status: string };
    expect(oldEp.status).toBe("archived");

    const frag = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_frag_01") as { status: string };
    expect(frag.status).toBe("archived");

    const good = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_good_01") as { status: string };
    expect(good.status).toBe("active");
  });

  it("keeps cold-tier archival disabled by default", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_cold_off",
      type: "EPISODE",
      content: "Captured a low-value old update from a previous checklist",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.15,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const result = runMemoryHygiene({ db, config });

    expect(result.coldTierEpisodes.archived).toBe(0);

    const row = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_cold_off") as { status: string };
    expect(row.status).toBe("active");
  });

  it("can enable cold-tier archival via runtime config fields", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_cold_on",
      type: "EPISODE",
      content: "Captured a low-value old update from a previous checklist",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.15,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const runtimeConfig = {
      ...config,
      coldTierEnabled: true,
      coldTierRetentionDays: 7,
      coldTierMaxValueScore: 0.35,
      coldTierMaxActivationEvents: 0,
    } as LcmConfig;

    const result = runMemoryHygiene({ db, config: runtimeConfig });

    expect(result.staleHeartbeats.archived).toBe(0);
    expect(result.coldTierEpisodes.archived).toBe(1);
    expect(result.staleEpisodes.archived).toBe(1);

    const row = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_cold_on") as { status: string };
    expect(row.status).toBe("archived");
  });

  it("supports hygiene tiering rollout flags in enforce mode", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_tiering_enforce",
      type: "EPISODE",
      content: "Captured a low-value old update from a previous checklist",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.15,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const rolloutConfig = {
      ...makeConfig({
        hygieneTieringEnabled: true,
        hygieneTieringMode: "enforce",
      }),
      hygieneTieringEnabled: true,
      hygieneTieringMode: "enforce",
      coldTierRetentionDays: 7,
      coldTierMaxValueScore: 0.35,
      coldTierMaxActivationEvents: 0,
    } as LcmConfig;
    const result = runMemoryHygiene({ db, config: rolloutConfig });

    expect(result.coldTierEpisodes.archived).toBe(1);
    const row = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_tiering_enforce") as { status: string };
    expect(row.status).toBe("archived");
  });

  it("supports hygiene tiering rollout flags in observe mode without archiving", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemoryDirect({
      config,
      memoryId: "mem_hyg_tiering_observe",
      type: "EPISODE",
      content: "Captured a low-value old update from a previous checklist",
      createdAt: tenDaysAgo,
      contentTime: tenDaysAgo,
      valueScore: 0.15,
    });

    const db = getLcmConnection(TEST_DB_PATH);
    const rolloutConfig = {
      ...makeConfig({
        hygieneTieringEnabled: true,
        hygieneTieringMode: "observe",
      }),
      hygieneTieringEnabled: true,
      hygieneTieringMode: "observe",
      coldTierRetentionDays: 7,
      coldTierMaxValueScore: 0.35,
      coldTierMaxActivationEvents: 0,
    } as LcmConfig;
    const result = runMemoryHygiene({ db, config: rolloutConfig });

    expect(result.coldTierEpisodes.archived).toBe(0);
    const row = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hyg_tiering_observe") as { status: string };
    expect(row.status).toBe("active");
  });
});

describe("heartbeat dedupe threshold", () => {
  let config: LcmConfig;

  beforeEach(() => {
    config = makeConfig({
      heartbeatDedupeThreshold: 0.7,
      activationModelEnabled: true,
      activationModelRolloutFraction: 1,
    });
  });

  afterEach(() => {
    // Force-close all connections (storeMemory increments refs internally)
    closeLcmConnection();
  });

  it("catches near-duplicate heartbeat episodes with lower threshold", () => {
    // Store first heartbeat
    const r1 = storeMemory({
      config,
      content: "Heartbeat recheck at 14:30 UTC: Core health remains clean, same blockers, no new issues found",
      kind: "EPISODE",
      source: "test",
      component: "test",
    });
    expect(r1.stored).toBe(true);

    // Store a similar heartbeat with slightly different timestamp/wording
    const r2 = storeMemory({
      config,
      content: "Heartbeat recheck at 15:00 UTC: Core health remains clean, same blockers, no issues found",
      kind: "EPISODE",
      source: "test",
      component: "test",
    });
    expect(r2.stored).toBe(true);
    expect(r2.reinforced).toBe(true);
    expect(r2.memoryId).toBe(r1.memoryId);

    const db = getLcmConnection(TEST_DB_PATH);
    const row = db
      .prepare(`
        SELECT COUNT(*) AS c, MAX(reinforcement_count) AS reinforcement_count
        FROM memory_current
        WHERE type = 'EPISODE'
          AND content LIKE ?
      `)
      .get("%Heartbeat recheck%") as Record<string, unknown>;
    expect(Number(row.c)).toBe(1);
    expect(Number(row.reinforcement_count)).toBeGreaterThan(1);
  });

  it("does not over-dedupe distinct episode content", () => {
    const r1 = storeMemory({
      config,
      content: "Deployed the new gateway configuration to production server cluster today",
      kind: "EPISODE",
      source: "test",
      component: "test",
    });
    expect(r1.stored).toBe(true);

    const r2 = storeMemory({
      config,
      content: "Heartbeat recheck: Core health remains clean, same blockers present",
      kind: "EPISODE",
      source: "test",
      component: "test",
    });
    expect(r2.stored).toBe(true);
  });
});

describe("episodeRetentionDays config", () => {
  it("defaults to 7 days", () => {
    const config = makeConfig();
    expect(config.episodeRetentionDays).toBe(7);
  });

  it("can be overridden", () => {
    const config = makeConfig({ episodeRetentionDays: 14 });
    expect(config.episodeRetentionDays).toBe(14);
  });
});

describe("heartbeatDedupeThreshold config", () => {
  it("defaults to 0.7", () => {
    const config = makeConfig();
    expect(config.heartbeatDedupeThreshold).toBe(0.7);
  });

  it("can be overridden", () => {
    const config = makeConfig({ heartbeatDedupeThreshold: 0.65 });
    expect(config.heartbeatDedupeThreshold).toBe(0.65);
  });
});
