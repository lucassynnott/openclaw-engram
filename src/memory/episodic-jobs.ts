import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { normalizeMemoryNamespace } from "./agent-namespace.js";
import { ensureMemoryTables } from "./memory-schema.js";
import { reindexMemoryVectorById } from "./vector-search.js";
import { storeMemory } from "../surface/memory-add-tool.js";

const JOB_POLL_INTERVAL_MS = 250;
const JOB_CHUNK_SIZE = 16;

type JobStatus = "pending" | "running" | "completed" | "failed";

type JobRow = {
  job_id: string;
  session_id: string;
  agent_namespace: string;
  conversation_id: number;
  status: JobStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  attempts: number;
  start_seq: number;
  target_seq: number;
  last_processed_seq: number;
  message_count: number;
  processed_count: number;
  stored_count: number;
  skipped_count: number;
  chunk_count: number;
  error: string | null;
};

type MessageRow = {
  message_id: number;
  seq: number;
  role: string;
  content: string;
  created_at: string;
};

type CountRow = {
  c: number;
};

type StateRow = {
  last_ingested_seq: number;
};

type SchedulerWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type SchedulerState = {
  draining: boolean;
  pollHandle?: ReturnType<typeof setInterval>;
  wakeHandle?: ReturnType<typeof setTimeout>;
  waiters: SchedulerWaiter[];
};

export type EpisodicIngestionJob = {
  jobId: string;
  sessionId: string;
  agentNamespace: string;
  conversationId: number;
  status: JobStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  attempts: number;
  startSeq: number;
  targetSeq: number;
  lastProcessedSeq: number;
  messageCount: number;
  processedCount: number;
  storedCount: number;
  skippedCount: number;
  chunkCount: number;
  error: string | null;
};

export type EpisodicQueueSummary = {
  pending: number;
  running: number;
  completed: number;
  failed: number;
};

export type EnqueueEpisodicIngestionResult =
  | {
      status: "queued" | "running";
      jobId: string;
      sessionId: string;
      agentNamespace: string;
      conversationId: number;
      pendingMessages: number;
      deduped: boolean;
      retried: boolean;
    }
  | {
      status: "idle";
      sessionId: string;
      agentNamespace: string;
      conversationId: number;
      pendingMessages: 0;
      message: string;
    }
  | {
      status: "unavailable";
      sessionId: string;
      agentNamespace: string;
      message: string;
    };

type EpisodicIngestionHooks = {
  beforeProcessMessage?: (params: {
    jobId: string;
    sessionId: string;
    messageId: number;
    seq: number;
    role: string;
    content: string;
  }) => void | Promise<void>;
};

const schedulerStates = new Map<string, SchedulerState>();
let testHooks: EpisodicIngestionHooks | undefined;
const _tablesInitialized = new WeakMap<DatabaseSync, boolean>();

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) as Record<string, unknown> | undefined,
  );
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureJobTables(db: DatabaseSync): void {
  if (_tablesInitialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_ingestion_jobs (
      job_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_namespace TEXT NOT NULL DEFAULT 'default',
      conversation_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      start_seq INTEGER NOT NULL DEFAULT 0,
      target_seq INTEGER NOT NULL DEFAULT 0,
      last_processed_seq INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      stored_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_ingestion_jobs_status_requested
      ON memory_ingestion_jobs(status, requested_at);
    CREATE INDEX IF NOT EXISTS idx_memory_ingestion_jobs_session_updated
      ON memory_ingestion_jobs(session_id, updated_at);

    CREATE TABLE IF NOT EXISTS memory_ingestion_state (
      session_id TEXT PRIMARY KEY,
      agent_namespace TEXT NOT NULL DEFAULT 'default',
      conversation_id INTEGER NOT NULL,
      last_ingested_seq INTEGER NOT NULL DEFAULT 0,
      last_job_id TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  if (!hasColumn(db, "memory_ingestion_jobs", "agent_namespace")) {
    db.exec("ALTER TABLE memory_ingestion_jobs ADD COLUMN agent_namespace TEXT NOT NULL DEFAULT 'default'");
  }
  if (!hasColumn(db, "memory_ingestion_state", "agent_namespace")) {
    db.exec("ALTER TABLE memory_ingestion_state ADD COLUMN agent_namespace TEXT NOT NULL DEFAULT 'default'");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_ingestion_jobs_namespace_status
      ON memory_ingestion_jobs(agent_namespace, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_ingestion_state_namespace_updated
      ON memory_ingestion_state(agent_namespace, updated_at);
  `);
  _tablesInitialized.set(db, true);
}

function getSchedulerState(databasePath: string): SchedulerState {
  const existing = schedulerStates.get(databasePath);
  if (existing) return existing;
  const created: SchedulerState = { draining: false, waiters: [] };
  schedulerStates.set(databasePath, created);
  return created;
}

function toJob(row: JobRow): EpisodicIngestionJob {
  return {
    jobId: row.job_id,
    sessionId: row.session_id,
    agentNamespace: normalizeMemoryNamespace(row.agent_namespace),
    conversationId: row.conversation_id,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    attempts: row.attempts,
    startSeq: row.start_seq,
    targetSeq: row.target_seq,
    lastProcessedSeq: row.last_processed_seq,
    messageCount: row.message_count,
    processedCount: row.processed_count,
    storedCount: row.stored_count,
    skippedCount: row.skipped_count,
    chunkCount: row.chunk_count,
    error: row.error,
  };
}

function fetchQueueSummary(db: DatabaseSync): EpisodicQueueSummary {
  const summary: EpisodicQueueSummary = { pending: 0, running: 0, completed: 0, failed: 0 };
  if (!hasTable(db, "memory_ingestion_jobs")) return summary;
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM memory_ingestion_jobs GROUP BY status`)
    .all() as Array<{ status?: string; c?: number }>;
  for (const row of rows) {
    const status = String(row.status ?? "") as keyof EpisodicQueueSummary;
    if (status in summary) summary[status] = Number(row.c ?? 0);
  }
  return summary;
}

function fetchJobById(db: DatabaseSync, jobId: string): EpisodicIngestionJob | null {
  if (!hasTable(db, "memory_ingestion_jobs")) return null;
  const row = db
    .prepare(`
      SELECT
        job_id, session_id, agent_namespace, conversation_id, status, requested_at, started_at, completed_at,
        updated_at, attempts, start_seq, target_seq, last_processed_seq, message_count,
        processed_count, stored_count, skipped_count, chunk_count, error
      FROM memory_ingestion_jobs
      WHERE job_id = ?
    `)
    .get(jobId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

function getConversationForSession(
  db: DatabaseSync,
  sessionId: string,
): { conversationId: number; latestSeq: number } | null {
  if (!hasTable(db, "conversations") || !hasTable(db, "messages")) return null;
  const conversation = db
    .prepare(`
      SELECT conversation_id
      FROM conversations
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(sessionId) as { conversation_id?: number } | undefined;
  if (!conversation?.conversation_id) return null;

  const latestSeq = Number(
    (
      db
        .prepare(`
          SELECT COALESCE(MAX(seq), 0) AS c
          FROM messages
          WHERE conversation_id = ?
        `)
        .get(conversation.conversation_id) as CountRow | undefined
    )?.c ?? 0,
  );

  return { conversationId: conversation.conversation_id, latestSeq };
}

function getSessionCursor(db: DatabaseSync, sessionId: string): number {
  if (!hasTable(db, "memory_ingestion_state")) return 0;
  const row = db
    .prepare(`
      SELECT last_ingested_seq
      FROM memory_ingestion_state
      WHERE session_id = ?
    `)
    .get(sessionId) as StateRow | undefined;
  return Number(row?.last_ingested_seq ?? 0);
}

function countMessagesInWindow(
  db: DatabaseSync,
  conversationId: number,
  startSeq: number,
  targetSeq: number,
): number {
  return Number(
    (
      db
        .prepare(`
          SELECT COUNT(*) AS c
          FROM messages
          WHERE conversation_id = ? AND seq > ? AND seq <= ?
        `)
        .get(conversationId, startSeq, targetSeq) as CountRow | undefined
    )?.c ?? 0,
  );
}

function getActiveSessionJob(db: DatabaseSync, sessionId: string): EpisodicIngestionJob | null {
  if (!hasTable(db, "memory_ingestion_jobs")) return null;
  const row = db
    .prepare(`
      SELECT
        job_id, session_id, agent_namespace, conversation_id, status, requested_at, started_at, completed_at,
        updated_at, attempts, start_seq, target_seq, last_processed_seq, message_count,
        processed_count, stored_count, skipped_count, chunk_count, error
      FROM memory_ingestion_jobs
      WHERE session_id = ? AND status IN ('pending', 'running')
      ORDER BY requested_at ASC
      LIMIT 1
    `)
    .get(sessionId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

function getRetryableSessionJob(db: DatabaseSync, sessionId: string): EpisodicIngestionJob | null {
  if (!hasTable(db, "memory_ingestion_jobs")) return null;
  const row = db
    .prepare(`
      SELECT
        job_id, session_id, agent_namespace, conversation_id, status, requested_at, started_at, completed_at,
        updated_at, attempts, start_seq, target_seq, last_processed_seq, message_count,
        processed_count, stored_count, skipped_count, chunk_count, error
      FROM memory_ingestion_jobs
      WHERE session_id = ? AND status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(sessionId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

function resolveNextJob(db: DatabaseSync): EpisodicIngestionJob | null {
  if (!hasTable(db, "memory_ingestion_jobs")) return null;
  const row = db
    .prepare(`
      SELECT
        job_id, session_id, agent_namespace, conversation_id, status, requested_at, started_at, completed_at,
        updated_at, attempts, start_seq, target_seq, last_processed_seq, message_count,
        processed_count, stored_count, skipped_count, chunk_count, error
      FROM memory_ingestion_jobs
      WHERE status IN ('running', 'pending')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, requested_at ASC
      LIMIT 1
    `)
    .get() as JobRow | undefined;
  return row ? toJob(row) : null;
}

function hasOutstandingJobs(db: DatabaseSync): boolean {
  if (!hasTable(db, "memory_ingestion_jobs")) return false;
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM memory_ingestion_jobs WHERE status IN ('pending', 'running')")
    .get() as CountRow | undefined;
  return Number(row?.c ?? 0) > 0;
}

function clearPollingIfIdle(config: LcmConfig): void {
  const state = getSchedulerState(config.databasePath);
  const db = getLcmConnection(config.databasePath);
  ensureJobTables(db);
  if (state.draining || hasOutstandingJobs(db)) return;
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = undefined;
  }
  if (state.wakeHandle) {
    clearTimeout(state.wakeHandle);
    state.wakeHandle = undefined;
  }
  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timeoutHandle);
    waiter.resolve();
  }
}

async function processJobChunk(config: LcmConfig): Promise<boolean> {
  const db = getLcmConnection(config.databasePath);
  ensureMemoryTables(db);
  ensureJobTables(db);

  const nextJob = resolveNextJob(db);
  if (!nextJob) return false;

  const now = new Date().toISOString();
  if (nextJob.status === "pending") {
    db.prepare(`
      UPDATE memory_ingestion_jobs
      SET status = 'running',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, ?),
          updated_at = ?,
          error = NULL
      WHERE job_id = ?
    `).run(now, now, nextJob.jobId);
  }

  const chunk = db
    .prepare(`
      SELECT message_id, seq, role, content, created_at
      FROM messages
      WHERE conversation_id = ? AND seq > ? AND seq <= ?
      ORDER BY seq
      LIMIT ?
    `)
    .all(
      nextJob.conversationId,
      nextJob.lastProcessedSeq,
      nextJob.targetSeq,
      JOB_CHUNK_SIZE,
    ) as MessageRow[];

  if (chunk.length === 0) {
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE memory_ingestion_jobs
      SET status = 'completed',
          completed_at = ?,
          updated_at = ?
      WHERE job_id = ?
    `).run(completedAt, completedAt, nextJob.jobId);
    db.prepare(`
      INSERT INTO memory_ingestion_state (
        session_id, agent_namespace, conversation_id, last_ingested_seq, last_job_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        agent_namespace = excluded.agent_namespace,
        conversation_id = excluded.conversation_id,
        last_ingested_seq = MAX(last_ingested_seq, excluded.last_ingested_seq),
        last_job_id = excluded.last_job_id,
        updated_at = excluded.updated_at
    `).run(
      nextJob.sessionId,
      nextJob.agentNamespace,
      nextJob.conversationId,
      nextJob.targetSeq,
      nextJob.jobId,
      completedAt,
    );
    return true;
  }

  try {
    for (const message of chunk) {
      await testHooks?.beforeProcessMessage?.({
        jobId: nextJob.jobId,
        sessionId: nextJob.sessionId,
        messageId: message.message_id,
        seq: message.seq,
        role: message.role,
        content: message.content,
      });

      let stored = false;
      if (message.role === "user" || message.role === "assistant") {
        const result = storeMemory({
          config,
          content: message.content,
          confidence: message.role === "user" ? 0.68 : 0.6,
          source: "episodic_ingest",
          sourceAgent: nextJob.agentNamespace,
          sourceSession: nextJob.sessionId,
          sourceTrigger: "episodic_ingest",
          component: "episodic_ingestion",
          contentTime: message.created_at,
          dedupeMode: "session",
          skipArchiveCandidates: true,
          provenance: {
            jobId: nextJob.jobId,
            messageId: message.message_id,
            messageSeq: message.seq,
            conversationId: nextJob.conversationId,
            role: message.role,
          },
        });
        stored = result.stored;
        if (stored && result.memoryId) {
          await reindexMemoryVectorById({
            db,
            config,
            memoryId: result.memoryId,
          }).catch(() => false);
        }
      }

      db.prepare(`
        UPDATE memory_ingestion_jobs
        SET last_processed_seq = ?,
            processed_count = processed_count + 1,
            stored_count = stored_count + ?,
            skipped_count = skipped_count + ?,
            updated_at = ?
        WHERE job_id = ?
      `).run(
        message.seq,
        stored ? 1 : 0,
        stored ? 0 : 1,
        new Date().toISOString(),
        nextJob.jobId,
      );
    }

    db.prepare(`
      UPDATE memory_ingestion_jobs
      SET chunk_count = chunk_count + 1,
          updated_at = ?
      WHERE job_id = ?
    `).run(new Date().toISOString(), nextJob.jobId);
  } catch (error) {
    db.prepare(`
      UPDATE memory_ingestion_jobs
      SET status = 'failed',
          updated_at = ?,
          error = ?
      WHERE job_id = ?
    `).run(
      new Date().toISOString(),
      error instanceof Error ? error.message : String(error),
      nextJob.jobId,
    );
  }

  return true;
}

async function drainScheduler(config: LcmConfig): Promise<void> {
  const state = getSchedulerState(config.databasePath);
  if (state.draining) return;
  state.draining = true;
  try {
    while (await processJobChunk(config)) {
      // keep draining
    }
  } finally {
    state.draining = false;
    clearPollingIfIdle(config);
  }
}

function scheduleDrain(config: LcmConfig): void {
  const state = getSchedulerState(config.databasePath);
  if (state.wakeHandle) return;
  state.wakeHandle = setTimeout(() => {
    state.wakeHandle = undefined;
    void drainScheduler(config);
  }, 0);
  state.wakeHandle.unref?.();
}

export function kickEpisodicIngestionScheduler(config: LcmConfig): void {
  const state = getSchedulerState(config.databasePath);
  if (!state.pollHandle) {
    state.pollHandle = setInterval(() => {
      void drainScheduler(config);
    }, JOB_POLL_INTERVAL_MS);
    state.pollHandle.unref?.();
  }
  scheduleDrain(config);
}

export function enqueueEpisodicIngestionJob(params: {
  config: LcmConfig;
  sessionId: string;
  agentNamespace?: string;
}): EnqueueEpisodicIngestionResult {
  const sessionId = params.sessionId.trim();
  const agentNamespace = normalizeMemoryNamespace(params.agentNamespace);
  if (!sessionId) {
    return { status: "unavailable", sessionId: "", agentNamespace, message: "sessionId is required." };
  }

  const db = getLcmConnection(params.config.databasePath);
  ensureMemoryTables(db);
  ensureJobTables(db);

  const conversation = getConversationForSession(db, sessionId);
  if (!conversation) {
    return {
      status: "unavailable",
      sessionId,
      agentNamespace,
      message: "No stored LCM conversation found for this session.",
    };
  }

  const cursor = getSessionCursor(db, sessionId);
  const activeJob = getActiveSessionJob(db, sessionId);
  if (activeJob) {
    let pendingMessages = countMessagesInWindow(
      db,
      conversation.conversationId,
      activeJob.startSeq,
      Math.max(activeJob.targetSeq, conversation.latestSeq),
    );
    if (conversation.latestSeq > activeJob.targetSeq) {
      db.prepare(`
        UPDATE memory_ingestion_jobs
        SET agent_namespace = ?, target_seq = ?, message_count = ?, updated_at = ?
        WHERE job_id = ?
      `).run(
        agentNamespace,
        conversation.latestSeq,
        pendingMessages,
        new Date().toISOString(),
        activeJob.jobId,
      );
      pendingMessages = countMessagesInWindow(
        db,
        conversation.conversationId,
        activeJob.startSeq,
        conversation.latestSeq,
      );
    }
    kickEpisodicIngestionScheduler(params.config);
    return {
      status: activeJob.status === "running" ? "running" : "queued",
      jobId: activeJob.jobId,
      sessionId,
      agentNamespace: activeJob.agentNamespace,
      conversationId: activeJob.conversationId,
      pendingMessages,
      deduped: true,
      retried: false,
    };
  }

  if (conversation.latestSeq <= cursor) {
    return {
      status: "idle",
      sessionId,
      agentNamespace,
      conversationId: conversation.conversationId,
      pendingMessages: 0,
      message: "No pending session activity to ingest.",
    };
  }

  const retryableJob = getRetryableSessionJob(db, sessionId);
  if (retryableJob && retryableJob.lastProcessedSeq < conversation.latestSeq) {
    const pendingMessages = countMessagesInWindow(
      db,
      conversation.conversationId,
      retryableJob.startSeq,
      conversation.latestSeq,
    );
    db.prepare(`
      UPDATE memory_ingestion_jobs
      SET status = 'pending',
          agent_namespace = ?,
          conversation_id = ?,
          target_seq = ?,
          message_count = ?,
          completed_at = NULL,
          updated_at = ?,
          error = NULL
      WHERE job_id = ?
    `).run(
      agentNamespace,
      conversation.conversationId,
      conversation.latestSeq,
      pendingMessages,
      new Date().toISOString(),
      retryableJob.jobId,
    );
    kickEpisodicIngestionScheduler(params.config);
    return {
      status: "queued",
      jobId: retryableJob.jobId,
      sessionId,
      agentNamespace,
      conversationId: conversation.conversationId,
      pendingMessages,
      deduped: false,
      retried: true,
    };
  }

  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const pendingMessages = countMessagesInWindow(db, conversation.conversationId, cursor, conversation.latestSeq);
  db.prepare(`
    INSERT INTO memory_ingestion_jobs (
      job_id, session_id, agent_namespace, conversation_id, status, requested_at, updated_at,
      start_seq, target_seq, last_processed_seq, message_count
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    sessionId,
    agentNamespace,
    conversation.conversationId,
    now,
    now,
    cursor,
    conversation.latestSeq,
    cursor,
    pendingMessages,
  );

  kickEpisodicIngestionScheduler(params.config);
  return {
    status: "queued",
    jobId,
    sessionId,
    agentNamespace,
    conversationId: conversation.conversationId,
    pendingMessages,
    deduped: false,
    retried: false,
  };
}

export function getEpisodicIngestionJob(params: {
  config: LcmConfig;
  jobId: string;
}): EpisodicIngestionJob | null {
  const db = getLcmConnection(params.config.databasePath);
  ensureJobTables(db);
  return fetchJobById(db, params.jobId.trim());
}

export function getEpisodicIngestionQueueSummary(params: {
  config: LcmConfig;
}): EpisodicQueueSummary {
  const db = getLcmConnection(params.config.databasePath);
  ensureJobTables(db);
  return fetchQueueSummary(db);
}

export async function waitForEpisodicIngestionIdle(
  config: LcmConfig,
  timeoutMs = 5_000,
): Promise<void> {
  const state = getSchedulerState(config.databasePath);
  const db = getLcmConnection(config.databasePath);
  ensureJobTables(db);

  if (!state.draining && !hasOutstandingJobs(db)) {
    clearPollingIfIdle(config);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out waiting for episodic ingestion idle after ${timeoutMs}ms.`));
    }, timeoutMs);
    state.waiters.push({ resolve, reject, timeoutHandle });
  });
}

export function setEpisodicIngestionHooksForTests(hooks: EpisodicIngestionHooks | undefined): void {
  testHooks = hooks;
}

export function resetEpisodicIngestionSchedulersForTests(): void {
  testHooks = undefined;
  for (const state of schedulerStates.values()) {
    if (state.pollHandle) clearInterval(state.pollHandle);
    if (state.wakeHandle) clearTimeout(state.wakeHandle);
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timeoutHandle);
      waiter.reject(new Error("Episodic ingestion scheduler reset during test."));
    }
  }
  schedulerStates.clear();
}
