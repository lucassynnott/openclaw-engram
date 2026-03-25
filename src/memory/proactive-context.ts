import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { applyActivationEvent } from "./activation.js";
import { isActivationModelEnabledForSeed } from "./activation-rollout.js";
import { listMatchingMemoryTriggers } from "./memory-triggers.js";
import { fetchMemoryCandidates } from "../surface/memory-recall-core.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toFiniteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseIsoDateMs(value: unknown, fallbackMs: number): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function reinforceSurfacedMemory(params: {
  db: DatabaseSync;
  memoryId: string;
  reason: "recall" | "trigger";
  now: string;
}): void {
  const row = params.db.prepare(`
    SELECT
      memory_id,
      confidence,
      truth_confidence,
      value_score,
      activation_strength,
      reinforcement_count,
      retrieval_count,
      last_reinforced_at,
      last_retrieved_at
    FROM memory_current
    WHERE memory_id = ?
    LIMIT 1
  `).get(params.memoryId) as Record<string, unknown> | undefined;
  if (!row) {
    return;
  }

  const nowMs = parseIsoDateMs(params.now, Date.now());
  const nextActivation = applyActivationEvent(
    {
      activation: clamp01(
        toFiniteNumber(row.activation_strength)
          ?? Math.max(
            toFiniteNumber(row.truth_confidence)
              ?? toFiniteNumber(row.confidence)
              ?? 0.5,
            toFiniteNumber(row.value_score) ?? 0.45,
          ),
      ),
      reinforcementCount: Math.max(0, Math.trunc(toFiniteNumber(row.reinforcement_count) ?? 0)),
      lastReinforcedAtMs: parseIsoDateMs(
        row.last_reinforced_at ?? row.last_retrieved_at,
        nowMs,
      ),
    },
    {
      type: "retrieval",
      atMs: nowMs,
      intensity: params.reason === "trigger" ? 0.8 : 1,
    },
  );

  params.db.prepare(`
    UPDATE memory_current
    SET activation_strength = ?,
        reinforcement_count = ?,
        retrieval_count = COALESCE(retrieval_count, 0) + 1,
        last_reinforced_at = ?,
        last_retrieved_at = ?
    WHERE memory_id = ?
  `).run(
    nextActivation.activation,
    nextActivation.reinforcementCount,
    new Date(nextActivation.lastReinforcedAtMs).toISOString(),
    params.now,
    params.memoryId,
  );

  params.db.prepare(`
    INSERT INTO memory_events (event_id, timestamp, component, action, memory_id, source, payload)
    VALUES (hex(randomblob(16)), ?, 'proactive_context', ?, ?, 'system', ?)
  `).run(
    params.now,
    params.reason === "trigger" ? "reinforce_trigger" : "reinforce_recall",
    params.memoryId,
    JSON.stringify({ surfaced_by: "proactive_context" }),
  );
}

export async function buildProactiveMemoryContext(params: {
  db: DatabaseSync;
  config: LcmConfig;
  prompt: string;
}): Promise<string | null> {
  const prompt = String(params.prompt || "").trim();
  if (!prompt) {
    return null;
  }

  const recall = await fetchMemoryCandidates(params.db, {
    config: params.config,
    query: prompt,
    topK: Math.max(3, Math.min(6, params.config.recallTopK || 6)),
    minScore: Math.max(0.38, params.config.recallMinScore || 0.45),
    maxTokens: Math.min(900, params.config.recallMaxTokens || 900),
    scope: "shared",
    allScopes: true,
    archiveFallback: params.config.recallArchiveFallback,
    entityLockEnabled: params.config.recallEntityLockEnabled,
  });
  const triggers = listMatchingMemoryTriggers({
    db: params.db,
    prompt,
    limit: 6,
  });

  if (recall.memories.length === 0 && triggers.length === 0) {
    return null;
  }

  const triggeredIds = new Set(triggers.map((trigger) => trigger.memoryId));
  const lines: string[] = ["<engram-relevant-memory>"];

  if (triggers.length > 0) {
    lines.push("Triggered memories:");
    for (const trigger of triggers) {
      const memory = recall.memories.find((candidate) => candidate.id === trigger.memoryId);
      if (memory) {
        lines.push(
          `- [trigger:${trigger.pattern}] ${memory.content} (id=${memory.id}, stored_by=${memory.sourceAgent || "unknown"})`,
        );
      } else {
        lines.push(`- [trigger:${trigger.pattern}] memory_id=${trigger.memoryId}`);
      }
    }
  }

  const relevantMemories = recall.memories.filter((memory) => !triggeredIds.has(memory.id));
  if (relevantMemories.length > 0) {
    lines.push("Relevant memories:");
    for (const memory of relevantMemories) {
      lines.push(
        `- ${memory.content} (id=${memory.id}, score=${memory.score.toFixed(3)}, confidence=${memory.effectiveConfidence.toFixed(3)}, stored_by=${memory.sourceAgent || "unknown"})`,
      );
    }
  }

  const surfacedReasons = new Map<string, "recall" | "trigger">();
  for (const memory of recall.memories) {
    surfacedReasons.set(memory.id, triggeredIds.has(memory.id) ? "trigger" : "recall");
  }
  for (const trigger of triggers) {
    surfacedReasons.set(trigger.memoryId, "trigger");
  }
  const now = new Date().toISOString();
  for (const [memoryId, reason] of surfacedReasons) {
    if (!isActivationModelEnabledForSeed(params.config, memoryId)) {
      continue;
    }
    try {
      reinforceSurfacedMemory({
        db: params.db,
        memoryId,
        reason,
        now,
      });
    } catch {
      // Surfacing reinforcement is best-effort.
    }
  }

  lines.push("</engram-relevant-memory>");
  return lines.join("\n");
}
