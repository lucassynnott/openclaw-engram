/**
 * Dedup and hygiene tests.
 *
 * Validates that:
 * - Near-duplicate heartbeat EPISODEs are detected and archived
 * - Stale heartbeat/status-spam episode archival is enforced
 * - Fragment memories are correctly identified
 * - The isHeartbeatPattern function catches known patterns
 * - The isFragmentContent function identifies short/label-like content
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import {
  archiveFragments,
  archiveStaleEpisodes,
  archiveStaleHeartbeats,
} from "../src/memory/memory-hygiene.js";
import { ensureMemoryTables } from "../src/memory/memory-schema.js";
import {
  hashNormalized,
  isFragmentContent,
  isHeartbeatPattern,
  normalizeContent,
} from "../src/memory/memory-utils.js";

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-dedup-"));
  tempDirs.add(dir);
  return dir;
}

function makeDb() {
  const dir = makeTempDir();
  const dbPath = join(dir, "lcm.db");
  dbPaths.add(dbPath);
  return { db: getLcmConnection(dbPath), dbPath, dir };
}

function insertMemory(
  db: ReturnType<typeof getLcmConnection>,
  params: {
    memoryId: string;
    type: string;
    content: string;
    status?: string;
    createdAt?: string;
    contentTime?: string;
  },
) {
  const normalized = normalizeContent(params.content);
  const hash = hashNormalized(params.content);
  const now = params.createdAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash,
      source, confidence, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, tags, superseded_by,
      content_time, source_layer, source_path, source_line
    ) VALUES (?, ?, ?, ?, ?, 'test', 0.7, 'shared', ?, 0.5, 'situational', ?, ?, NULL, '[]', NULL, ?, 'registry', NULL, NULL)
  `).run(
    params.memoryId,
    params.type,
    params.content,
    normalized,
    hash,
    params.status ?? "active",
    now,
    now,
    params.contentTime ?? now,
  );
}

afterEach(() => {
  for (const dbPath of dbPaths) closeLcmConnection(dbPath);
  dbPaths.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ---------------------------------------------------------------------------
// isHeartbeatPattern
// ---------------------------------------------------------------------------

describe("isHeartbeatPattern", () => {
  it("detects heartbeat patterns", () => {
    const heartbeats = [
      "Heartbeat recheck — all systems nominal",
      "HEARTBEAT_OK: no issues found",
      "Core health remains clean after the last check",
      "health check complete — all good",
      "Approval queue is unchanged since last check",
      "status check is clean and ok for the deployment",
      "no blockers found in the current sprint iteration",
      "same blockers as before: waiting on API review approval",
    ];
    for (const content of heartbeats) {
      expect(
        isHeartbeatPattern(content),
        `should detect heartbeat: "${content.slice(0, 50)}"`,
      ).toBe(true);
    }
  });

  it("does NOT flag normal content as heartbeat", () => {
    const normal = [
      "Lucas prefers dark mode in all editors",
      "We decided to use Vitest for testing",
      "Jordan is Lucas's partner",
      "The engram plugin stores durable memory in SQLite",
    ];
    for (const content of normal) {
      expect(
        isHeartbeatPattern(content),
        `should NOT detect heartbeat: "${content.slice(0, 50)}"`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isFragmentContent
// ---------------------------------------------------------------------------

describe("isFragmentContent", () => {
  it("identifies very short label-like content as fragments", () => {
    expect(isFragmentContent("Status: OK")).toBe(true);
    expect(isFragmentContent("Level: 3")).toBe(true);
    expect(isFragmentContent("Duration: 5 minutes")).toBe(true);
    expect(isFragmentContent("Score: 42")).toBe(true);
  });

  it("identifies very short content with few distinct words as fragments", () => {
    expect(isFragmentContent("hello world", 50)).toBe(true);
    expect(isFragmentContent("test test test", 50)).toBe(true);
  });

  it("does NOT flag content at or above minChars threshold", () => {
    const longEnough = "This is a sufficiently long memory entry that has plenty of words and details";
    expect(isFragmentContent(longEnough, 50)).toBe(false);
  });

  it("identifies empty content as fragments", () => {
    expect(isFragmentContent("")).toBe(true);
    expect(isFragmentContent("  ")).toBe(true);
  });

  it("does NOT flag short content with 4+ distinct meaningful words", () => {
    // "Lucas prefers dark mode" has 4 distinct words of 3+ chars
    expect(isFragmentContent("Lucas prefers dark mode", 50)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible stale episode archival (heartbeat/status-spam only)
// ---------------------------------------------------------------------------

describe("archiveStaleEpisodes", () => {
  it("archives stale heartbeat/status-spam EPISODE entries", () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    // Insert an old heartbeat episode (30 days ago)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    insertMemory(db, {
      memoryId: "mem_old_ep",
      type: "EPISODE",
      content: "HEARTBEAT_OK: no issues found, status unchanged since prior check",
      createdAt: thirtyDaysAgo,
      contentTime: thirtyDaysAgo,
    });

    // Insert a recent episode (1 hour ago)
    const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertMemory(db, {
      memoryId: "mem_recent_ep",
      type: "EPISODE",
      content: "Lucas just fixed the sync bug in the native layer an hour ago",
      createdAt: recentTime,
      contentTime: recentTime,
    });

    // Insert a non-episode (should not be touched)
    insertMemory(db, {
      memoryId: "mem_pref",
      type: "PREFERENCE",
      content: "Lucas prefers concise commit messages for all projects",
      createdAt: thirtyDaysAgo,
      contentTime: thirtyDaysAgo,
    });

    const result = archiveStaleEpisodes({
      db,
      retentionDays: 7, // Archive episodes older than 7 days
    });

    expect(result.archived).toBe(1);
    expect(result.scanned).toBe(1);

    // Verify the old episode was archived
    const oldRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_old_ep") as Record<string, unknown> | undefined;
    expect(oldRow?.status).toBe("archived");

    // Verify the recent episode is still active
    const recentRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_recent_ep") as Record<string, unknown> | undefined;
    expect(recentRow?.status).toBe("active");

    // Verify the preference was not touched
    const prefRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_pref") as Record<string, unknown> | undefined;
    expect(prefRow?.status).toBe("active");
  });

  it("returns zero when no stale episodes exist", () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    const recentTime = new Date().toISOString();
    insertMemory(db, {
      memoryId: "mem_fresh_ep",
      type: "EPISODE",
      content: "Lucas just deployed the latest version of the gateway to production",
      createdAt: recentTime,
      contentTime: recentTime,
    });

    const result = archiveStaleEpisodes({
      db,
      retentionDays: 7,
    });

    expect(result.archived).toBe(0);
    expect(result.scanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat-specific archival
// ---------------------------------------------------------------------------

describe("archiveStaleHeartbeats", () => {
  it("archives old heartbeat EPISODEs while keeping non-heartbeat episodes", () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertMemory(db, {
      memoryId: "mem_hb_old",
      type: "EPISODE",
      content: "HEARTBEAT_OK: all systems operational and nominal today",
      createdAt: oldTime,
      contentTime: oldTime,
    });
    insertMemory(db, {
      memoryId: "mem_real_old",
      type: "EPISODE",
      content: "Lucas paired with Viktor to fix the sync bug ten days ago",
      createdAt: oldTime,
      contentTime: oldTime,
    });

    const result = archiveStaleHeartbeats({
      db,
      retentionDays: 3,
    });

    expect(result.archived).toBe(1);

    // Heartbeat should be archived
    const hbRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_hb_old") as Record<string, unknown> | undefined;
    expect(hbRow?.status).toBe("archived");

    // Non-heartbeat episode should remain active
    const realRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_real_old") as Record<string, unknown> | undefined;
    expect(realRow?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Fragment archival
// ---------------------------------------------------------------------------

describe("archiveFragments", () => {
  it("archives fragment memories with short, label-like content", () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_fragment",
      type: "CONTEXT",
      content: "Status: OK",
    });
    insertMemory(db, {
      memoryId: "mem_good",
      type: "USER_FACT",
      content: "Lucas works as a software engineer in Vienna and loves his job very much",
    });

    const result = archiveFragments({
      db,
      minContentChars: 50,
    });

    expect(result.archived).toBe(1);

    // Fragment should be archived
    const fragRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_fragment") as Record<string, unknown> | undefined;
    expect(fragRow?.status).toBe("archived");

    // Good memory should remain active
    const goodRow = db
      .prepare("SELECT status FROM memory_current WHERE memory_id = ?")
      .get("mem_good") as Record<string, unknown> | undefined;
    expect(goodRow?.status).toBe("active");
  });

  it("returns zero when no fragments exist", () => {
    const { db } = makeDb();
    ensureMemoryTables(db);

    insertMemory(db, {
      memoryId: "mem_full",
      type: "USER_FACT",
      content: "This is a perfectly good memory with enough content to pass the fragment check easily",
    });

    const result = archiveFragments({
      db,
      minContentChars: 50,
    });

    expect(result.archived).toBe(0);
  });
});
