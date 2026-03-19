import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "../db/config.js";
import { listMatchingMemoryTriggers } from "./memory-triggers.js";
import { fetchMemoryCandidates } from "../surface/memory-recall-core.js";

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

  lines.push("</engram-relevant-memory>");
  return lines.join("\n");
}
