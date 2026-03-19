import { createHash } from "node:crypto";

export type MemoryKind =
  | "USER_FACT"
  | "PREFERENCE"
  | "DECISION"
  | "ENTITY"
  | "EPISODE"
  | "AGENT_IDENTITY"
  | "CONTEXT";

export const VALID_KINDS: MemoryKind[] = [
  "USER_FACT",
  "PREFERENCE",
  "DECISION",
  "ENTITY",
  "EPISODE",
  "AGENT_IDENTITY",
  "CONTEXT",
];

const WRAPPER_RE =
  /<\/?(?:memory_clusters|working_memory|recalled_memories|agent_profile|user_profile|gigabrain-context|context|system|tool_output)\b/i;

const JUNK_PATTERNS: RegExp[] = [
  /Read HEARTBEAT/i,
  /A new session was started/i,
  /^System:/i,
  /API_KEY=/,
  /_API_KEY=/,
  /SECRET=/,
  /PASSWORD=/,
  /Template placeholder/i,
  /\bsmoke test\b/i,
  /Post-Compaction Audit/i,
  /\[Subagent Context\]/,
  /Exec completed \(/,
  /\[System Message\] \[sessionId:/,
  /compaction audit/i,
  /subagent.*depth \d+\/\d+/i,
];

const TEMPORAL_RE =
  /\b(?:today|tonight|this morning|this afternoon|this evening|yesterday|last night|right now|currently|just now|an hour ago|\d+ (?:minutes?|hours?|days?) ago)\b/i;

const PREF_RE = /\b(?:user|owner|i)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i;
const DECISION_RE = /\b(?:decided|decision|we will|we should|always|agreed to|going with)\b/i;
const AGENT_RE = /\b(?:agent identity|agent profile|my personality|agent continuity|agent evolution)\b/i;

const OPS_NOISE_RE =
  /\b(?:run:|script|cron|pipeline|phase\s+\d+|openclaw\s+update|todo:|implement(?:ed|ation)?|api key|endpoint|webhook|token\b|ip address|192\.168\.)\b/i;
const PERSONAL_RE =
  /\b(?:user|owner)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i;
const RELATIONSHIP_RE =
  /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|best friend|mentor|sibling|proud of|grateful|cares? for|means a lot to)\b/i;
const IDENTITY_RE =
  /\b(?:agent identity|my personality|agent continuity|identity|evolution)\b/i;

export type ValueLabel = "core" | "situational" | "archive_candidate" | "low_value" | "junk";
export type ValueAction = "keep" | "archive" | "reject";

export type ClassifyResult = {
  action: ValueAction;
  value_label: ValueLabel;
  value_score: number;
  reason_codes: string[];
};

export type JunkResult = {
  junk: boolean;
  reason: string | null;
  matchedPattern: string | null;
};

export function normalizeContent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[m:[0-9a-f-]{8,}\]/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashNormalized(value: string): string {
  const normalized = normalizeContent(value);
  if (!normalized) return "";
  return createHash("sha1").update(normalized).digest("hex");
}

function detectMetadataNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^\[[^\]]+\]$/.test(trimmed)) return true;
  if (/^m:[0-9a-f-]{8,}$/i.test(trimmed)) return true;
  if (/^[A-Z_]+=$/.test(trimmed)) return true;
  const letters = (trimmed.match(/[a-z]/gi) ?? []).length;
  const digits = (trimmed.match(/[0-9]/g) ?? []).length;
  const punctuation = (trimmed.match(/[^a-z0-9\s]/gi) ?? []).length;
  if (letters <= 3 && digits + punctuation >= Math.max(6, trimmed.length * 0.6)) return true;
  if (/^(todo|tbd|n\/a|none)$/i.test(trimmed)) return true;
  return false;
}

export function detectJunk(content: string): JunkResult {
  const text = content.trim();
  const minChars = 12;

  if (!text) return { junk: true, reason: "empty", matchedPattern: null };
  if (WRAPPER_RE.test(text)) return { junk: true, reason: "junk_wrapper", matchedPattern: WRAPPER_RE.source };
  if (text.length < minChars) return { junk: true, reason: "too_short", matchedPattern: null };
  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(text)) return { junk: true, reason: "junk_pattern", matchedPattern: pattern.source };
  }
  if (detectMetadataNoise(text)) return { junk: true, reason: "metadata_noise", matchedPattern: null };
  return { junk: false, reason: null, matchedPattern: null };
}

export function inferKind(content: string): MemoryKind {
  if (AGENT_RE.test(content)) return "AGENT_IDENTITY";
  if (PREF_RE.test(content)) return "PREFERENCE";
  if (DECISION_RE.test(content)) return "DECISION";
  if (TEMPORAL_RE.test(content)) return "EPISODE";
  return "USER_FACT";
}

export function hasTemporalContext(content: string): boolean {
  return TEMPORAL_RE.test(content);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function baseTypeScore(type: MemoryKind): number {
  switch (type) {
    case "AGENT_IDENTITY": return 1.0;
    case "PREFERENCE": return 0.92;
    case "USER_FACT": return 0.9;
    case "ENTITY": return 0.85;
    case "DECISION": return 0.75;
    case "EPISODE": return 0.68;
    case "CONTEXT": return 0.5;
  }
}

export function classifyValue(content: string, type: MemoryKind, confidence: number): ClassifyResult {
  const text = content.trim();
  const isPersonal = PERSONAL_RE.test(text);
  const isRelationship = RELATIONSHIP_RE.test(text);
  const isIdentity = IDENTITY_RE.test(text) || type === "AGENT_IDENTITY";
  const operationalNoise = clamp01(OPS_NOISE_RE.test(text) ? 0.75 : 0);
  const distinctTokens = new Set(normalizeContent(text).split(/\s+/).filter(Boolean)).size;
  const specificity = clamp01(Math.min(distinctTokens, 24) / 24 + (/[0-9]/.test(text) ? 0.1 : 0));
  const typeScore = baseTypeScore(type);
  const score = clamp01(
    (isPersonal ? 1 : 0) * 0.19 +
    (isRelationship ? 1 : 0) * 0.15 +
    (isIdentity ? 1 : 0) * 0.18 +
    clamp01(typeScore * 0.65 + confidence * 0.35) * 0.2 +
    0.8 * 0.08 +
    specificity * 0.08 -
    operationalNoise * 0.15,
  );

  const adjustedScore = clamp01(score + 0.15);

  if (isIdentity) {
    return {
      action: "keep",
      value_label: "core",
      value_score: Math.max(adjustedScore, 0.9),
      reason_codes: ["agent_identity"],
    };
  }
  if (isPersonal || isRelationship) {
    return {
      action: "keep",
      value_label: "core",
      value_score: Math.max(adjustedScore, 0.82),
      reason_codes: ["durable_personal"],
    };
  }
  if (adjustedScore >= 0.78) {
    return {
      action: "keep",
      value_label: "core",
      value_score: adjustedScore,
      reason_codes: ["high_utility"],
    };
  }
  if (adjustedScore >= 0.3) {
    return {
      action: "keep",
      value_label: "situational",
      value_score: adjustedScore,
      reason_codes: ["manual_add_bias"],
    };
  }
  return {
    action: "archive",
    value_label: "archive_candidate",
    value_score: adjustedScore,
    reason_codes: ["low_value"],
  };
}
