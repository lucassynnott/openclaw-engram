import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import {
  DEFAULT_MEMORY_NAMESPACE,
  normalizeMemoryNamespace,
  resolveMemoryNamespaceFromSessionContext,
} from "../memory/agent-namespace.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import {
  enqueueEpisodicIngestionJob,
  getEpisodicIngestionJob,
  getEpisodicIngestionQueueSummary,
  kickEpisodicIngestionScheduler,
} from "../memory/episodic-jobs.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const GetEntitySchema = Type.Object({
  entityId: Type.String({
    description: "Entity UUID to look up.",
  }),
});

export function createMemoryGetEntityTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_get_entity",
    label: "Get Memory Entity",
    description:
      "Fetch a specific entity by UUID from the memory entity registry. " +
      "Returns entity metadata and associated memories.",
    parameters: GetEntitySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const entityId = (typeof p.entityId === "string" ? p.entityId : "").trim();
      if (!entityId) {
        return jsonResult({ error: "entityId is required." });
      }

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      ensureMemoryTables(db);

      const entity = db
        .prepare("SELECT * FROM memory_entities WHERE entity_id = ?")
        .get(entityId) as Record<string, unknown> | undefined;

      if (!entity) {
        return jsonResult({ error: `Entity not found: ${entityId}` });
      }

      const memories = db
        .prepare(`
          SELECT memory_id, type, content, confidence, created_at
          FROM memory_current
          WHERE status = 'active' AND (tags LIKE ? OR content LIKE ?)
          ORDER BY confidence DESC
          LIMIT 10
        `)
        .all(`%${entity.display_name}%`, `%${entity.display_name}%`) as Array<Record<string, unknown>>;

      return jsonResult({
        entity: {
          id: entity.entity_id,
          kind: entity.kind,
          name: entity.display_name,
          status: entity.status,
          confidence: entity.confidence,
          created_at: entity.created_at,
          updated_at: entity.updated_at,
        },
        memories: memories.map((memory) => ({
          id: memory.memory_id,
          kind: memory.type,
          content: memory.content,
          confidence: memory.confidence,
          created_at: memory.created_at,
        })),
      });
    },
  };
}

const GetEpisodeSchema = Type.Object({
  episodeId: Type.String({
    description: "Episode UUID to fetch.",
  }),
});

export function createMemoryGetEpisodeTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_get_episode",
    label: "Get Memory Episode",
    description:
      "Fetch a specific episode by UUID from the memory episode store. " +
      "Episodes are structured summaries of discrete events or decision points.",
    parameters: GetEpisodeSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const episodeId = (typeof p.episodeId === "string" ? p.episodeId : "").trim();
      if (!episodeId) {
        return jsonResult({ error: "episodeId is required." });
      }

      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          error: "Memory store unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      ensureMemoryTables(db);

      const episode = db
        .prepare("SELECT * FROM memory_episodes WHERE episode_id = ?")
        .get(episodeId) as Record<string, unknown> | undefined;

      if (!episode) {
        return jsonResult({ error: `Episode not found: ${episodeId}` });
      }

      return jsonResult({
        episode: {
          id: episode.episode_id,
          title: episode.title,
          summary: episode.summary,
          start_date: episode.start_date,
          end_date: episode.end_date,
          status: episode.status,
          primary_entity_id: episode.primary_entity_id,
          source_memory_ids: (() => {
            try {
              return JSON.parse(episode.source_memory_ids as string);
            } catch {
              return [];
            }
          })(),
        },
      });
    },
  };
}

export function createMemoryNamespaceStatusTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_namespace_status",
    label: "Memory Namespace Status",
    description:
      "Check memory store health and statistics. Returns counts of active memories, entities, episodes, and events.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      let db: DatabaseSync;
      try {
        db = getLcmConnection(input.config.databasePath);
      } catch (err) {
        return jsonResult({
          status: "unavailable",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const memoriesCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE status = 'active'").get() as Record<string, unknown>
        )?.c ?? 0;
        const entitiesCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE status = 'active'").get() as Record<string, unknown>
        )?.c ?? 0;
        const episodesCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memory_episodes").get() as Record<string, unknown>
        )?.c ?? 0;
        const eventsCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memory_events").get() as Record<string, unknown>
        )?.c ?? 0;
        const byKind = db
          .prepare(
            "SELECT type, COUNT(*) AS c FROM memory_current WHERE status = 'active' GROUP BY type ORDER BY c DESC",
          )
          .all() as Array<Record<string, unknown>>;

        return jsonResult({
          status: "healthy",
          memories: { total: memoriesCount, byKind },
          entities: entitiesCount,
          episodes: episodesCount,
          events: eventsCount,
        });
      } catch (err) {
        return jsonResult({
          status: "degraded",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

type NamespaceMetricsRow = {
  namespace?: string;
  memory_count?: number;
  job_count?: number;
  active_jobs?: number;
  ingested_sessions?: number;
  last_seen_at?: string | null;
};

type AgentNamespaceSummary = {
  namespace: string;
  memoryCount: number;
  jobCount: number;
  activeJobs: number;
  ingestedSessions: number;
  lastSeenAt: string | null;
  synthetic: boolean;
};

type IngestionToolDeps = Pick<LcmDependencies, "resolveSessionIdFromSessionKey"> &
  Partial<Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">>;

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName),
  );
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function getNamespaceEntry(
  entries: Map<string, AgentNamespaceSummary>,
  namespace: string,
): AgentNamespaceSummary {
  const existing = entries.get(namespace);
  if (existing) return existing;
  const created: AgentNamespaceSummary = {
    namespace,
    memoryCount: 0,
    jobCount: 0,
    activeJobs: 0,
    ingestedSessions: 0,
    lastSeenAt: null,
    synthetic: true,
  };
  entries.set(namespace, created);
  return created;
}

function mergeLastSeen(current: string | null, candidate: string | null | undefined): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return current >= candidate ? current : candidate;
}

function listAgentNamespaces(params: {
  config: LcmConfig;
  currentNamespace: string;
}): AgentNamespaceSummary[] {
  const db = getLcmConnection(params.config.databasePath);
  const entries = new Map<string, AgentNamespaceSummary>();

  if (hasTable(db, "memory_current")) {
    const rows = db
      .prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(source_agent), ''), ?) AS namespace,
          COUNT(*) AS memory_count,
          MAX(updated_at) AS last_seen_at
        FROM memory_current
        GROUP BY namespace
      `)
      .all(DEFAULT_MEMORY_NAMESPACE) as NamespaceMetricsRow[];
    for (const row of rows) {
      const namespace = normalizeMemoryNamespace(String(row.namespace ?? DEFAULT_MEMORY_NAMESPACE));
      const entry = getNamespaceEntry(entries, namespace);
      entry.synthetic = false;
      entry.memoryCount += Number(row.memory_count ?? 0);
      entry.lastSeenAt = mergeLastSeen(entry.lastSeenAt, row.last_seen_at);
    }
  }

  if (hasTable(db, "memory_ingestion_jobs")) {
    const namespaceExpr = hasColumn(db, "memory_ingestion_jobs", "agent_namespace")
      ? "COALESCE(NULLIF(TRIM(agent_namespace), ''), 'default')"
      : "'default'";
    const rows = db
      .prepare(`
        SELECT
          ${namespaceExpr} AS namespace,
          COUNT(*) AS job_count,
          SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS active_jobs,
          MAX(updated_at) AS last_seen_at
        FROM memory_ingestion_jobs
        GROUP BY namespace
      `)
      .all() as NamespaceMetricsRow[];
    for (const row of rows) {
      const namespace = normalizeMemoryNamespace(String(row.namespace ?? DEFAULT_MEMORY_NAMESPACE));
      const entry = getNamespaceEntry(entries, namespace);
      entry.synthetic = false;
      entry.jobCount += Number(row.job_count ?? 0);
      entry.activeJobs += Number(row.active_jobs ?? 0);
      entry.lastSeenAt = mergeLastSeen(entry.lastSeenAt, row.last_seen_at);
    }
  }

  if (hasTable(db, "memory_ingestion_state")) {
    const namespaceExpr = hasColumn(db, "memory_ingestion_state", "agent_namespace")
      ? "COALESCE(NULLIF(TRIM(agent_namespace), ''), 'default')"
      : "'default'";
    const rows = db
      .prepare(`
        SELECT
          ${namespaceExpr} AS namespace,
          COUNT(*) AS ingested_sessions,
          MAX(updated_at) AS last_seen_at
        FROM memory_ingestion_state
        GROUP BY namespace
      `)
      .all() as NamespaceMetricsRow[];
    for (const row of rows) {
      const namespace = normalizeMemoryNamespace(String(row.namespace ?? DEFAULT_MEMORY_NAMESPACE));
      const entry = getNamespaceEntry(entries, namespace);
      entry.synthetic = false;
      entry.ingestedSessions += Number(row.ingested_sessions ?? 0);
      entry.lastSeenAt = mergeLastSeen(entry.lastSeenAt, row.last_seen_at);
    }
  }

  getNamespaceEntry(entries, params.currentNamespace);

  return Array.from(entries.values()).sort((left, right) => {
    if (left.namespace === params.currentNamespace && right.namespace !== params.currentNamespace) return -1;
    if (right.namespace === params.currentNamespace && left.namespace !== params.currentNamespace) return 1;
    if (left.namespace === DEFAULT_MEMORY_NAMESPACE && right.namespace !== DEFAULT_MEMORY_NAMESPACE) return -1;
    if (right.namespace === DEFAULT_MEMORY_NAMESPACE && left.namespace !== DEFAULT_MEMORY_NAMESPACE) return 1;
    return left.namespace.localeCompare(right.namespace);
  });
}

function resolveOptionalNamespaceDeps(
  deps: IngestionToolDeps | undefined,
): Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId"> | undefined {
  if (!deps?.parseAgentSessionKey || !deps.normalizeAgentId) return undefined;
  return {
    parseAgentSessionKey: deps.parseAgentSessionKey,
    normalizeAgentId: deps.normalizeAgentId,
  };
}

export function createMemoryListAgentsTool(input: {
  config: LcmConfig;
  deps?: Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "memory_list_agents",
    label: "List Memory Agents",
    description:
      "List registered agent namespaces in the memory system. Discovers namespaces from stored memories and ingestion job state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const currentNamespace = resolveMemoryNamespaceFromSessionContext({
        deps: input.deps,
        sessionKey: input.sessionKey,
      });
      const agents = listAgentNamespaces({
        config: input.config,
        currentNamespace,
      });
      return jsonResult({
        currentNamespace,
        agents: agents.map((agent) => ({
          namespace: agent.namespace,
          status: agent.activeJobs > 0 ? "ingesting" : "active",
          current: agent.namespace === currentNamespace,
          defaultNamespace: agent.namespace === DEFAULT_MEMORY_NAMESPACE,
          memoryCount: agent.memoryCount,
          jobCount: agent.jobCount,
          activeJobs: agent.activeJobs,
          ingestedSessions: agent.ingestedSessions,
          lastSeenAt: agent.lastSeenAt,
          note:
            agent.synthetic && agent.namespace === DEFAULT_MEMORY_NAMESPACE
              ? "No agent-specific namespaces have been stored yet."
              : undefined,
        })),
      });
    },
  };
}

async function resolveIngestionSessionId(input: {
  deps?: IngestionToolDeps;
  sessionId?: string;
  sessionKey?: string;
  params: Record<string, unknown>;
}): Promise<string | undefined> {
  const explicit = typeof input.params.sessionId === "string" ? input.params.sessionId.trim() : "";
  if (explicit) return explicit;
  const direct = input.sessionId?.trim();
  if (direct) return direct;
  const sessionKey = input.sessionKey?.trim();
  if (!sessionKey || !input.deps) return undefined;
  const resolved = await input.deps.resolveSessionIdFromSessionKey(sessionKey);
  return resolved?.trim() ? resolved.trim() : undefined;
}

export function createMemoryIngestNowTool(input: {
  config: LcmConfig;
  deps?: IngestionToolDeps;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "memory_ingest_now",
    label: "Trigger Memory Ingest",
    description:
      "Trigger immediate ingestion of pending session activity into long-term memory. Creates or resumes a background episodic ingestion job.",
    parameters: Type.Object({
      sessionId: Type.Optional(
        Type.String({ description: "Session ID to ingest. Defaults to current session." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const sessionId = await resolveIngestionSessionId({
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!sessionId) {
        return jsonResult({
          error: "No sessionId was provided and the current session could not be resolved from sessionKey.",
        });
      }

      const result = enqueueEpisodicIngestionJob({
        config: input.config,
        sessionId,
        agentNamespace: resolveMemoryNamespaceFromSessionContext({
          deps: resolveOptionalNamespaceDeps(input.deps),
          sessionKey: input.sessionKey,
        }),
      });
      return jsonResult(result);
    },
  };
}

export function createMemoryJobStatusTool(input: { config: LcmConfig }): AnyAgentTool {
  return {
    name: "memory_job_status",
    label: "Memory Job Status",
    description:
      "Check the status of a background ingestion job. Returns queue counts when jobId is omitted.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({ description: "Job ID to check. If omitted, returns queue summary." }),
      ),
    }),
    async execute(_toolCallId, params) {
      kickEpisodicIngestionScheduler(input.config);
      const p = params as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId.trim() : "";
      if (jobId) {
        const job = getEpisodicIngestionJob({ config: input.config, jobId });
        if (!job) {
          return jsonResult({ error: `Job not found: ${jobId}` });
        }

        const progress = job.messageCount > 0 ? Math.min(1, job.processedCount / job.messageCount) : 1;
        return jsonResult({
          status: job.status,
          job,
          progress,
        });
      }

      return jsonResult({
        status: "ok",
        queue: getEpisodicIngestionQueueSummary({ config: input.config }),
      });
    },
  };
}
