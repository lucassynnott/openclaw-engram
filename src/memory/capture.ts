import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import {
  storeMemory,
  type MemoryKind,
  type MemoryProvenance,
  type StoreMemoryResult,
} from "../surface/memory-add-tool.js";
import { reindexMemoryVectorById } from "./vector-search.js";

const MEMORY_NOTE_RE = /<memory_note\b(?=[^>]*=)([^>]*)>([\s\S]*?)<\/memory_note>/gi;
const MEMORY_NOTE_ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
const MEMORY_NOTE_BLOCK_RE = /\s*<memory_note\b(?=[^>]*=)[\s\S]*?<\/memory_note>\s*/gi;
const DEFAULT_CONFIDENCE = 0.65;
const PRE_COMPACTION_MIN_CONFIDENCE = 0.72;

const PREFERENCE_CAPTURE_RE =
  /\b(?:i|user|owner)\s+(?:really\s+|strongly\s+)?(?:like|likes|love|loves|prefer|prefers|hate|hates|dislike|dislikes)\b/i;
const DECISION_CAPTURE_RES: Array<{ rule: string; re: RegExp }> = [
  {
    rule: "decision_statement",
    re: /\b(?:we|i)\s+(?:decided|decide|agreed|agree|chose|choose)\b.*\b(?:use|build|store|keep|ship|switch|move|run)\b/i,
  },
  {
    rule: "implementation_commitment",
    re: /\b(?:we(?:'ll| will)?|i(?:'ll| will)?)\s+(?:use|build|store|keep|ship|switch|move|run)\b/i,
  },
];
const FACT_CAPTURE_RES: Array<{ rule: string; re: RegExp; confidence: number }> = [
  {
    rule: "identity_fact",
    re: /\b(?:my name is|i live in|i work at|my timezone is)\b/i,
    confidence: 0.76,
  },
  {
    rule: "relationship_fact",
    re: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)? is [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?'s (?:partner|wife|husband|girlfriend|boyfriend|mentor|sibling)\b/,
    confidence: 0.78,
  },
];

export type ParsedMemoryNote = {
  kind: MemoryKind;
  content: string;
  confidence: number;
  scope?: string;
  entities: string[];
};

export type CaptureSourceMessage = {
  role?: string;
  content: string;
  messageId?: number;
  seq?: number;
  createdAt?: Date | string;
};

export type MemoryCaptureTrigger = "agent_end" | "pre_compaction";

export type CaptureMemoryNotesResult = {
  processed: number;
  stored: number;
  skippedLowConfidence: number;
  rejected: number;
  memoryIds: string[];
};

export type SanitizeMemoryNoteMessageResult<T> =
  | { block: true }
  | { message: T };

type HeuristicCandidate = {
  kind: MemoryKind;
  content: string;
  confidence: number;
  rule: string;
};

type NormalizedCaptureMessage = CaptureSourceMessage & {
  role: string;
  content: string;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeKind(value: string): MemoryKind {
  const normalized = value.trim().toUpperCase();
  if (normalized === "FACT" || normalized === "USERFACT") {
    return "USER_FACT";
  }
  switch (normalized) {
    case "USER_FACT":
    case "PREFERENCE":
    case "DECISION":
    case "ENTITY":
    case "EPISODE":
    case "AGENT_IDENTITY":
    case "CONTEXT":
      return normalized;
    default:
      return "CONTEXT";
  }
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match = MEMORY_NOTE_ATTR_RE.exec(raw);
  while (match) {
    const key = String(match[1] || "").trim().toLowerCase();
    const value = String(match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (key) {
      attrs[key] = value;
    }
    match = MEMORY_NOTE_ATTR_RE.exec(raw);
  }
  MEMORY_NOTE_ATTR_RE.lastIndex = 0;
  return attrs;
}

function parseConfidence(value: string | undefined): number {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_CONFIDENCE;
  }
  if (normalized === "high") return 0.9;
  if (normalized === "medium") return 0.7;
  if (normalized === "low") return 0.4;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? clamp01(numeric) : DEFAULT_CONFIDENCE;
}

function parseEntities(raw: string | undefined): string[] {
  return String(raw || "")
    .split(/[;,|]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractMessageTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((entry): entry is { type?: unknown; text?: unknown } => {
      return !!entry && typeof entry === "object";
    })
    .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeCaptureMessages(messages: unknown[]): NormalizedCaptureMessage[] {
  const normalized: NormalizedCaptureMessage[] = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as {
      role?: unknown;
      content?: unknown;
      messageId?: unknown;
      seq?: unknown;
      createdAt?: unknown;
      created_at?: unknown;
    };
    const content = extractMessageTextContent(record.content);
    if (!content) {
      continue;
    }
    normalized.push({
      role: typeof record.role === "string" ? record.role : "assistant",
      content,
      messageId: typeof record.messageId === "number" ? record.messageId : undefined,
      seq: typeof record.seq === "number" ? record.seq : undefined,
      createdAt:
        record.createdAt instanceof Date || typeof record.createdAt === "string"
          ? record.createdAt
          : record.created_at instanceof Date || typeof record.created_at === "string"
            ? record.created_at
            : undefined,
    });
  }
  return normalized;
}

function extractLatestAssistantReply(
  messages: unknown[],
): { text: string; messageIndex: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { role?: unknown; content?: unknown };
    if (record.role !== "assistant") {
      continue;
    }
    const text = extractMessageTextContent(record.content);
    if (text) {
      return { text, messageIndex: index };
    }
  }
  return undefined;
}

function stripMemoryNoteBlocks(text: string): string {
  return text
    .replace(MEMORY_NOTE_BLOCK_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitCaptureUnits(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 12 && value.length <= 280);
}

function classifyHeuristicCandidate(content: string): HeuristicCandidate | undefined {
  if (PREFERENCE_CAPTURE_RE.test(content)) {
    return {
      kind: "PREFERENCE",
      content,
      confidence: 0.8,
      rule: "preference_statement",
    };
  }

  for (const candidate of DECISION_CAPTURE_RES) {
    if (candidate.re.test(content)) {
      return {
        kind: "DECISION",
        content,
        confidence: 0.82,
        rule: candidate.rule,
      };
    }
  }

  for (const candidate of FACT_CAPTURE_RES) {
    if (candidate.re.test(content)) {
      return {
        kind: "USER_FACT",
        content,
        confidence: candidate.confidence,
        rule: candidate.rule,
      };
    }
  }

  return undefined;
}

function buildProvenance(params: {
  trigger: MemoryCaptureTrigger;
  extractor: "memory_note" | "heuristic";
  conversationId?: number;
  sessionFile?: string;
  message?: CaptureSourceMessage;
  messageIndex?: number;
  rule?: string;
  note?: ParsedMemoryNote;
}): MemoryProvenance {
  const createdAt = params.message?.createdAt;
  const normalizedCreatedAt =
    createdAt instanceof Date
      ? createdAt.toISOString()
      : typeof createdAt === "string" && createdAt.trim()
        ? createdAt.trim()
        : undefined;

  return {
    trigger: params.trigger,
    extractor: params.extractor,
    conversationId: params.conversationId,
    sessionFile: params.sessionFile,
    sourceMessage: {
      role: params.message?.role,
      messageId: params.message?.messageId,
      seq: params.message?.seq,
      createdAt: normalizedCreatedAt,
      messageIndex: params.messageIndex,
    },
    rule: params.rule,
    note:
      params.note != null
        ? {
            kind: params.note.kind,
            confidence: params.note.confidence,
            scope: params.note.scope,
            entities: params.note.entities,
          }
        : undefined,
  };
}

function storeCapturedMemory(params: {
  config: LcmConfig;
  noteOrCandidate: ParsedMemoryNote | HeuristicCandidate;
  trigger: MemoryCaptureTrigger;
  source: string;
  agentId?: string;
  sessionKey?: string;
  component: string;
  minConfidence: number;
  provenance: MemoryProvenance;
  summary: CaptureMemoryNotesResult;
}): void {
  params.summary.processed += 1;

  if (params.noteOrCandidate.confidence < params.minConfidence) {
    params.summary.skippedLowConfidence += 1;
    return;
  }

  const result: StoreMemoryResult = storeMemory({
    config: params.config,
    content: params.noteOrCandidate.content,
    kind: params.noteOrCandidate.kind,
    scope: "scope" in params.noteOrCandidate ? params.noteOrCandidate.scope : undefined,
    entities: "entities" in params.noteOrCandidate ? params.noteOrCandidate.entities : undefined,
    source: params.source,
    sourceAgent: params.agentId,
    sourceSession: params.sessionKey,
    sourceTrigger: params.trigger,
    confidence: params.noteOrCandidate.confidence,
    component: params.component,
    provenance: params.provenance,
  });

  if (result.stored && result.memoryId) {
    params.summary.stored += 1;
    params.summary.memoryIds.push(result.memoryId);
    void reindexMemoryVectorById({
      db: getLcmConnection(params.config.databasePath),
      config: params.config,
      memoryId: result.memoryId,
    }).catch(() => false);
  } else {
    params.summary.rejected += 1;
  }
}

export function parseMemoryNotes(text: string): ParsedMemoryNote[] {
  const notes: ParsedMemoryNote[] = [];
  const dedupe = new Set<string>();

  let match = MEMORY_NOTE_RE.exec(text);
  while (match) {
    const attrs = parseAttributes(match[1] || "");
    if (String(attrs.action || "").trim()) {
      match = MEMORY_NOTE_RE.exec(text);
      continue;
    }

    const content = String(match[2] || "").replace(/\s+/g, " ").trim();
    const nestedTag = /<\/?memory_note\b/i.test(content);
    if (!content || nestedTag || content.length > 1200) {
      match = MEMORY_NOTE_RE.exec(text);
      continue;
    }

    const note: ParsedMemoryNote = {
      kind: normalizeKind(attrs.type || ""),
      content,
      confidence: parseConfidence(attrs.confidence),
      scope: attrs.scope?.trim() || undefined,
      entities: parseEntities(attrs.entities),
    };

    const key = `${note.kind}|${note.scope || ""}|${note.content.toLowerCase()}`;
    if (!dedupe.has(key)) {
      dedupe.add(key);
      notes.push(note);
    }

    match = MEMORY_NOTE_RE.exec(text);
  }

  return notes;
}

export function sanitizeMemoryNoteMessage<T extends { role?: unknown; content?: unknown }>(
  message: T,
): SanitizeMemoryNoteMessageResult<T> | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }

  if (typeof message.content === "string") {
    if (!/<memory_note\b/i.test(message.content)) {
      return undefined;
    }
    const stripped = stripMemoryNoteBlocks(message.content);
    return stripped
      ? { message: { ...message, content: stripped } }
      : { block: true };
  }

  if (!Array.isArray(message.content)) {
    return undefined;
  }

  let changed = false;
  const next = message.content.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [block];
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string" || !/<memory_note\b/i.test(record.text)) {
      return [block];
    }

    changed = true;
    const stripped = stripMemoryNoteBlocks(record.text);
    return stripped ? [{ ...block, text: stripped }] : [];
  });

  if (!changed) {
    return undefined;
  }

  return next.length > 0
    ? { message: { ...message, content: next } }
    : { block: true };
}

export function captureMemoryNotesFromAgentEnd(params: {
  config: LcmConfig;
  messages: unknown[];
  agentId?: string;
  sessionKey?: string;
  minConfidence?: number;
}): CaptureMemoryNotesResult {
  const reply = extractLatestAssistantReply(params.messages);
  const notes = parseMemoryNotes(reply?.text ?? "");
  const minConfidence =
    typeof params.minConfidence === "number" && Number.isFinite(params.minConfidence)
      ? clamp01(params.minConfidence)
      : DEFAULT_CONFIDENCE;

  const summary: CaptureMemoryNotesResult = {
    processed: 0,
    stored: 0,
    skippedLowConfidence: 0,
    rejected: 0,
    memoryIds: [],
  };

  for (const note of notes) {
    storeCapturedMemory({
      config: params.config,
      noteOrCandidate: note,
      trigger: "agent_end",
      source: "capture",
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      component: "capture_hook",
      minConfidence,
      provenance: buildProvenance({
        trigger: "agent_end",
        extractor: "memory_note",
        message: { role: "assistant", content: reply?.text ?? "" },
        messageIndex: reply?.messageIndex,
        note,
      }),
      summary,
    });
  }

  return summary;
}

export function capturePreCompactionMemories(params: {
  config: LcmConfig;
  messages: CaptureSourceMessage[];
  agentId?: string;
  sessionKey?: string;
  conversationId?: number;
  sessionFile?: string;
  includeMemoryNotes?: boolean;
  minConfidence?: number;
}): CaptureMemoryNotesResult {
  const minConfidence =
    typeof params.minConfidence === "number" && Number.isFinite(params.minConfidence)
      ? clamp01(params.minConfidence)
      : PRE_COMPACTION_MIN_CONFIDENCE;
  const summary: CaptureMemoryNotesResult = {
    processed: 0,
    stored: 0,
    skippedLowConfidence: 0,
    rejected: 0,
    memoryIds: [],
  };
  const seen = new Set<string>();

  for (const message of normalizeCaptureMessages(params.messages)) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (params.includeMemoryNotes && message.role === "assistant" && /<memory_note\b/i.test(message.content)) {
      for (const note of parseMemoryNotes(message.content)) {
        const key = `memory_note|${note.kind}|${note.content.toLowerCase()}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        storeCapturedMemory({
          config: params.config,
          noteOrCandidate: note,
          trigger: "pre_compaction",
          source: "pre_compaction",
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          component: "compaction_capture",
          minConfidence,
          provenance: buildProvenance({
            trigger: "pre_compaction",
            extractor: "memory_note",
            conversationId: params.conversationId,
            sessionFile: params.sessionFile,
            message,
            note,
          }),
          summary,
        });
      }
    }

    for (const unit of splitCaptureUnits(stripMemoryNoteBlocks(message.content))) {
      const candidate = classifyHeuristicCandidate(unit);
      if (!candidate) {
        continue;
      }
      const key = `heuristic|${candidate.kind}|${candidate.content.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      storeCapturedMemory({
        config: params.config,
        noteOrCandidate: candidate,
        trigger: "pre_compaction",
        source: "pre_compaction",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        component: "compaction_capture",
        minConfidence,
        provenance: buildProvenance({
          trigger: "pre_compaction",
          extractor: "heuristic",
          conversationId: params.conversationId,
          sessionFile: params.sessionFile,
          message,
          rule: candidate.rule,
        }),
        summary,
      });
    }
  }

  return summary;
}
