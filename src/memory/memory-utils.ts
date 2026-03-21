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

// ---------------------------------------------------------------------------
// System-prompt / injection artifact detection
// ---------------------------------------------------------------------------

/** XML-style system prompt markers that should never become memories. */
const SYSTEM_PROMPT_TAG_RE =
  /<\/?(?:composio|system-reminder|system-instruction|tool_schema|tool_definition|function_call|function_result)\b/i;

/**
 * Instruction-language patterns common in system prompts and injected
 * instructions but extremely rare in legitimate user-facing memories.
 *
 * The "Do NOT use" pattern explicitly excludes benign preference contexts
 * (tabs, spaces, dark/light mode) to avoid false-positives on real
 * preference memories.
 */
const INSTRUCTION_LANGUAGE_PATTERNS: RegExp[] = [
  /\bIgnore pretrained\b/i,
  /\bUse only these instructions\b/i,
  /\bDo NOT use\b(?!.*\b(?:tabs|spaces|dark mode|light mode)\b)/i,
  /\bDo not use pretrained\b/i,
  /\bWhen to use .+ vs .+:/i,
  /\bYou are a .+ assistant\b/i,
  /\bYou must always\b/i,
  /\bIMPORTANT:\s*(?:Never|Always|Do not|You must)\b/i,
  /\bOverride any (?:previous|default)\b/i,
  /\bFollow these (?:instructions|rules|guidelines) exactly\b/i,
  /\bSystem:\s*\[/,
  /<!--\s*system\b/i,
];

/** Credential / secret patterns beyond the simple `API_KEY=` already caught. */
const CREDENTIAL_BLOCK_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|ghp|gho|glpat|xoxb|xoxp|AKIA|AIza)[A-Za-z0-9_-]{16,}/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9_\-/.+=]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bexport\s+[A-Z_]+=["'][^"']{8,}["']/,
];

/** Tool-output / function-call JSON structures. */
const TOOL_OUTPUT_PATTERNS: RegExp[] = [
  /"tool_call_id"\s*:/,
  /"function"\s*:\s*\{[\s\S]*?"parameters"\s*:/,
  /"type"\s*:\s*"function"\s*,\s*"function"\s*:/,
];

/**
 * Detect content that looks like a system prompt, injected instruction block,
 * credential dump, or tool schema. Returns a reason string or null.
 */
export function detectSystemPromptArtifact(text: string): string | null {
  if (SYSTEM_PROMPT_TAG_RE.test(text)) {
    return "system_prompt_tag";
  }
  for (const pattern of INSTRUCTION_LANGUAGE_PATTERNS) {
    if (pattern.test(text)) {
      return "instruction_language";
    }
  }
  for (const pattern of CREDENTIAL_BLOCK_PATTERNS) {
    if (pattern.test(text)) {
      return "credential_block";
    }
  }
  for (const pattern of TOOL_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      return "tool_output_json";
    }
  }
  return null;
}

/**
 * Content length thresholds. Real memories are concise; system prompts, tool
 * schemas, and heartbeat dumps are not.
 *
 * - SOFT_MAX: memories above this length require higher confidence or are
 *   penalised in value scoring (enforced in storeMemory / classifyValue).
 * - HARD_MAX: unconditionally rejected inside detectJunk.
 */
export const CONTENT_LENGTH_SOFT_MAX = 500;
export const CONTENT_LENGTH_HARD_MAX = 2000;

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

  // System prompt / injection artifact gate
  const artifactReason = detectSystemPromptArtifact(text);
  if (artifactReason) {
    return { junk: true, reason: artifactReason, matchedPattern: artifactReason };
  }

  // Hard content-length cap — real memories are concise
  if (text.length > CONTENT_LENGTH_HARD_MAX) {
    return { junk: true, reason: "content_too_long", matchedPattern: null };
  }

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

/**
 * Heartbeat patterns — near-identical status/health-check entries that
 * repeat across sessions and add zero recall value when duplicated.
 */
const HEARTBEAT_PATTERNS: RegExp[] = [
  /\bHeartbeat\b/i,
  /\bheartbeat recheck\b/i,
  /\bCore health remains clean\b/i,
  /\bHEARTBEAT_OK\b/i,
  /\bhealth check complete\b/i,
  /\bApproval queue is unchanged\b/i,
  /\bstatus check\b.*\b(?:clean|ok|pass|good|nominal|unchanged)\b/i,
  /\bno.*(?:blockers?|issues?|changes?)\b.*\bfound\b/i,
  /\bsame blockers?\b/i,
];

/**
 * Returns true if the content matches a known heartbeat / status-log pattern.
 */
export function isHeartbeatPattern(content: string): boolean {
  const text = content.trim();
  return HEARTBEAT_PATTERNS.some((re) => re.test(text));
}

/**
 * Returns true if the content is a fragment — too short to be meaningful,
 * with mostly label-like or search-query-like text.
 */
export function isFragmentContent(content: string, minChars = 50): boolean {
  const text = content.trim();
  if (text.length >= minChars) return false;
  if (!text) return true;

  // Patterns that indicate a fragment: bare labels, time durations, search queries
  const fragmentPatterns: RegExp[] = [
    /^Time:\s*\d+\s*(?:minutes?|hours?|seconds?|mins?|hrs?|secs?)/i,
    /^Duration:\s*/i,
    /^Status:\s*/i,
    /^(?:Level|Priority|Score|Count|Total|Result):\s*/i,
  ];
  if (fragmentPatterns.some((re) => re.test(text))) return true;

  // Check for meaningful word content — at least 4 distinct words of 3+ chars
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const distinctWords = new Set(words.map((w) => w.toLowerCase()));

  // Very short content with fewer than 3 distinct meaningful words is likely a fragment
  if (text.length < 30 && distinctWords.size < 3) return true;

  return false;
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

  // Penalise overly-long content — proportional to how far past the soft max
  const lengthPenalty =
    text.length > CONTENT_LENGTH_SOFT_MAX
      ? clamp01((text.length - CONTENT_LENGTH_SOFT_MAX) / (CONTENT_LENGTH_HARD_MAX - CONTENT_LENGTH_SOFT_MAX)) * 0.2
      : 0;

  const score = clamp01(
    (isPersonal ? 1 : 0) * 0.19 +
    (isRelationship ? 1 : 0) * 0.15 +
    (isIdentity ? 1 : 0) * 0.18 +
    clamp01(typeScore * 0.65 + confidence * 0.35) * 0.2 +
    0.8 * 0.08 +
    specificity * 0.08 -
    operationalNoise * 0.15 -
    lengthPenalty,
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
