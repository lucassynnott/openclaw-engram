/**
 * Periodic Memory Harvest — "turn-nudge"
 *
 * Every N user turns, runs a background LLM extraction pass over the recent
 * conversation to capture preferences, corrections, decisions, and facts the
 * user reveals naturally. Results are stored directly in the Engram memory
 * pipeline (same dedup, quality filters, and entity linking as manual saves).
 *
 * Non-blocking: fires and forgets from afterTurn(). Never delays the main response.
 */

import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import type { CompleteFn, ResolveModelFn, GetApiKeyFn } from "../types.js";
import { storeMemory, type StoreMemoryParams } from "../surface/memory-add-tool.js";
import type { MemoryKind } from "../memory/memory-utils.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type HarvestMessage = {
  role: string;
  content: unknown;
};

export type HarvestDeps = {
  config: LcmConfig;
  complete: CompleteFn;
  resolveModel: ResolveModelFn;
  getApiKey: GetApiKeyFn;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
};

export type HarvestResult = {
  extracted: number;
  stored: number;
  skipped: number;
  errors: number;
};

type ExtractedMemory = {
  kind: string;
  content: string;
  entities?: string[];
  confidence?: number;
};

// ── DB table ─────────────────────────────────────────────────────────────────

const HARVEST_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS harvest_state (
    session_id TEXT PRIMARY KEY,
    turn_count INTEGER NOT NULL DEFAULT 0,
    last_harvest_at TEXT,
    last_harvest_turn INTEGER NOT NULL DEFAULT 0
  )
`;

export function ensureHarvestTable(db: DatabaseSync): void {
  db.exec(HARVEST_TABLE_DDL);
}

// ── Extraction prompt ────────────────────────────────────────────────────────

const HARVEST_SYSTEM_PROMPT = `You are a memory extraction agent. Review the conversation excerpt and extract any durable facts worth storing in long-term memory.

Focus on:
- Preferences the user expressed (how they want things done, communication style, tools they prefer)
- Corrections the user made (something that was wrong, something they clarified)
- Decisions made (things agreed upon that should survive this session)
- Facts about the user, their business, or their context

Rules:
- Only extract if the signal is clear and durable. Skip anything ephemeral or session-specific.
- Skip tool outputs, code blocks, error messages, and status checks.
- Skip anything that is just a task instruction ("do this", "run that").
- Each extracted fact must be a self-contained sentence that makes sense without the conversation.
- If nothing worth saving: return an empty array.
- Return ONLY valid JSON — no markdown fences, no explanation.

Response format: JSON array of objects:
[
  { "kind": "PREFERENCE|DECISION|USER_FACT", "content": "concise fact", "confidence": 0.7 }
]

Valid kinds: PREFERENCE, DECISION, USER_FACT. Do not use EPISODE or CONTEXT.
Confidence: 0.6-0.95. Use 0.6 for weak signals, 0.8 for clear statements, 0.9+ for explicit corrections.`;

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Check whether a harvest should run based on turn count.
 */
export function shouldHarvest(
  db: DatabaseSync,
  sessionId: string,
  currentUserTurns: number,
  everyNTurns: number,
): boolean {
  ensureHarvestTable(db);
  const row = db
    .prepare("SELECT last_harvest_turn FROM harvest_state WHERE session_id = ?")
    .get(sessionId) as { last_harvest_turn: number } | undefined;

  const lastTurn = row?.last_harvest_turn ?? 0;
  return currentUserTurns - lastTurn >= everyNTurns;
}

/**
 * Update harvest state after a successful run.
 */
export function updateHarvestState(
  db: DatabaseSync,
  sessionId: string,
  userTurns: number,
): void {
  ensureHarvestTable(db);
  db.prepare(
    `INSERT INTO harvest_state (session_id, turn_count, last_harvest_at, last_harvest_turn)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       turn_count = excluded.turn_count,
       last_harvest_at = excluded.last_harvest_at,
       last_harvest_turn = excluded.last_harvest_turn`,
  ).run(sessionId, userTurns, new Date().toISOString(), userTurns);
}

/**
 * Format messages into a text excerpt for the extraction prompt.
 */
export function formatMessagesForHarvest(
  messages: HarvestMessage[],
  lookbackTurns: number,
): string {
  // Take the last N messages by role turns (a "turn" = one user + one assistant)
  const totalMessages = messages.length;
  const sliceStart = Math.max(0, totalMessages - lookbackTurns * 2);
  const recent = messages.slice(sliceStart);

  const lines: string[] = [];
  for (const msg of recent) {
    const role = String(msg.role || "unknown").toUpperCase();
    const content = extractTextContent(msg.content);
    if (content.trim()) {
      // Truncate very long messages to avoid blowing up the extraction context
      const truncated = content.length > 2000 ? content.slice(0, 2000) + "..." : content;
      lines.push(`[${role}]: ${truncated}`);
    }
  }
  return lines.join("\n\n");
}

/**
 * Extract text from message content (handles string, array of blocks, etc.).
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text || "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Parse the LLM response into extracted memories.
 */
export function parseHarvestResponse(raw: string): ExtractedMemory[] {
  const trimmed = raw.trim();
  // Strip markdown code fences if present
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    const VALID_KINDS = new Set(["PREFERENCE", "DECISION", "USER_FACT"]);
    return parsed
      .filter(
        (item): item is ExtractedMemory =>
          item &&
          typeof item === "object" &&
          typeof item.content === "string" &&
          item.content.trim().length > 10 &&
          VALID_KINDS.has(String(item.kind || "").toUpperCase()),
      )
      .map((item) => ({
        kind: String(item.kind).toUpperCase(),
        content: item.content.trim(),
        entities: Array.isArray(item.entities) ? item.entities.map(String) : undefined,
        confidence:
          typeof item.confidence === "number" && item.confidence >= 0.1 && item.confidence <= 1.0
            ? item.confidence
            : 0.7,
      }));
  } catch {
    return [];
  }
}

/**
 * Run the harvest extraction: call LLM, parse results, store memories.
 */
export async function runHarvest(params: {
  db: DatabaseSync;
  deps: HarvestDeps;
  sessionId: string;
  messages: HarvestMessage[];
}): Promise<HarvestResult> {
  const { db, deps, sessionId, messages } = params;
  const { config } = deps;
  const result: HarvestResult = { extracted: 0, stored: 0, skipped: 0, errors: 0 };

  const excerpt = formatMessagesForHarvest(messages, config.harvestLookbackTurns);
  if (!excerpt.trim()) {
    deps.log.debug("[harvest] No content to extract from — skipping");
    return result;
  }

  // Resolve model — use harvest-specific model if configured, otherwise session default
  const modelRef = config.harvestModel || undefined;
  const { provider, model } = deps.resolveModel(modelRef);
  const apiKey = await deps.getApiKey(provider, model);

  const completion = await deps.complete({
    provider,
    model,
    apiKey,
    system: HARVEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: excerpt }],
    maxTokens: 1024,
    temperature: 0.2,
  });

  const responseText = extractTextContent(completion.content);
  const extracted = parseHarvestResponse(responseText);
  result.extracted = extracted.length;

  if (extracted.length === 0) {
    deps.log.debug("[harvest] No durable facts extracted from conversation");
    return result;
  }

  // Store each extracted memory through the standard pipeline
  for (const mem of extracted) {
    try {
      const storeResult = storeMemory({
        config,
        content: mem.content,
        kind: mem.kind as MemoryKind,
        confidence: mem.confidence ?? 0.7,
        entities: mem.entities,
        source: "periodic_harvest",
        sourceSession: sessionId,
        dedupeMode: "global",
      });
      if (storeResult.stored) {
        result.stored++;
      } else {
        result.skipped++;
        deps.log.debug(`[harvest] Skipped: ${storeResult.reason} — ${mem.content.slice(0, 60)}`);
      }
    } catch (err) {
      result.errors++;
      deps.log.warn(`[harvest] Store error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  deps.log.info(
    `[harvest] Session ${sessionId}: extracted=${result.extracted} stored=${result.stored} skipped=${result.skipped} errors=${result.errors}`,
  );

  return result;
}

/**
 * Count user turns in a message array.
 */
export function countUserTurns(messages: HarvestMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}
