/**
 * Compatibility bridge for OpenClaw context-engine symbols.
 *
 * The published `openclaw/plugin-sdk` package in this workspace does not yet
 * export the context-engine interfaces that the runtime supports dynamically.
 * Engram uses this local bridge so the plugin can type-check against the
 * runtime contract without depending on unpublished SDK declarations.
 */

export type ContextEngineMessage = {
  role: string;
  content: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
};

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
};

export type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages: number;
  reason?: string;
};

export type IngestResult = {
  ingested: boolean;
};

export type IngestBatchResult = {
  ingestedCount: number;
};

export type AssembleResult = {
  messages: ContextEngineMessage[];
  estimatedTokens: number;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    tokensBefore?: number;
    tokensAfter?: number;
    details?: Record<string, unknown>;
  };
};

export type SubagentSpawnPreparation = {
  rollback?: () => void | Promise<void>;
};

export type SubagentEndReason = "completed" | "deleted" | "released" | "swept";

export interface ContextEngine {
  info: ContextEngineInfo;
  bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;
  ingest(params: {
    sessionId: string;
    message: ContextEngineMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;
  ingestBatch(params: {
    sessionId: string;
    messages: ContextEngineMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: ContextEngineMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void>;
  assemble(params: {
    sessionId: string;
    messages: ContextEngineMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
    force?: boolean;
  }): Promise<CompactResult>;
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void>;
  dispose?(): Promise<void>;
}

export type ContextEngineFactory = () => ContextEngine;

export function registerContextEngine(
  api: { registerContextEngine?: unknown },
  id: string,
  factory: ContextEngineFactory,
): void {
  const register = api.registerContextEngine;
  if (typeof register === "function") {
    (register as (id: string, factory: ContextEngineFactory) => void)(id, factory);
  }
}
