import type { DatabaseSync } from "node:sqlite";

import { isCommonEnglishWord, isLikelyEntityName } from "./entity-quality-filter.js";

// ---------------------------------------------------------------------------
// Inline policy helpers (replaces policy.js imports)
// ---------------------------------------------------------------------------

const normalizeContent = (value: unknown): string => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\[m:[0-9a-f-]{8,}\]/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

const RELATIONSHIP_RE =
  /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|best friend|relationship|lebt zusammen|live together|dating|date|freund(?:in)?)\b/i;
const PUBLIC_PROFILE_RE =
  /\b(?:tedx|coach|coaching|speaker|life coaching|beratung|berater(?:in)?|sozialarbeiter(?:in)?|lebens(?:-|\s+und\s+)sozialberater(?:in)?)\b/i;
const OPS_NOISE_RE = /\b(?:script|pipeline|cron|review|migration|deploy|run|todo|worker)\b/i;
const PERSON_QUERY_HINT_RE =
  /\b(?:wer ist|who is|about|über|ueber|tell me about|was weißt du über|was weisst du über)\b/i;
const ENTITY_QUERY_HINT_TAIL_RE =
  /\b(?:wer ist|wer war|who is|who was|about|über|ueber|tell me about|was weißt du über|was weisst du über)\s+(.+)$/i;
const WELL_KNOWN_NAMES_RE = /(?!x)x/gi; // configurable — no hardcoded names
const PROPER_NAME_RE = /\b[A-ZÄÖÜ][a-zäöüß][A-Za-zÄÖÜäöüß0-9-]{1,}\b/g;
const COMMON_ENGLISH_CONTENT_WORDS = new Set([
  "again",
  "back",
  "batch",
  "before",
  "bridge",
  "build",
  "built",
  "call",
  "change",
  "changes",
  "check",
  "checks",
  "cleanup",
  "code",
  "command",
  "commands",
  "commit",
  "config",
  "configs",
  "context",
  "conversation",
  "copy",
  "current",
  "currently",
  "data",
  "default",
  "delete",
  "deploy",
  "deployment",
  "detail",
  "details",
  "diff",
  "docs",
  "done",
  "error",
  "errors",
  "expand",
  "file",
  "files",
  "filter",
  "fix",
  "fixed",
  "flow",
  "follow",
  "grant",
  "grants",
  "graph",
  "group",
  "hand",
  "health",
  "history",
  "index",
  "issue",
  "issues",
  "item",
  "items",
  "job",
  "jobs",
  "latest",
  "layer",
  "line",
  "lines",
  "link",
  "links",
  "load",
  "log",
  "logs",
  "memory",
  "merge",
  "message",
  "messages",
  "mode",
  "model",
  "models",
  "note",
  "notes",
  "ops",
  "output",
  "path",
  "paths",
  "pattern",
  "patterns",
  "phase",
  "plan",
  "plugin",
  "plugins",
  "query",
  "queries",
  "record",
  "records",
  "repo",
  "report",
  "result",
  "results",
  "review",
  "run",
  "scope",
  "search",
  "session",
  "setup",
  "sha",
  "slot",
  "slots",
  "state",
  "status",
  "step",
  "steps",
  "store",
  "stored",
  "stores",
  "summary",
  "sync",
  "system",
  "task",
  "tasks",
  "test",
  "tests",
  "timestamp",
  "tool",
  "tools",
  "topic",
  "trace",
  "update",
  "updates",
  "url",
  "urls",
  "user",
  "users",
  "value",
  "values",
  "vector",
  "vectors",
  "vault",
  "version",
  "working",
  "world",
]);
const COMMON_NON_PERSON_TOKENS = new Set([
  "active",
  "alignment",
  "always",
  "broken",
  "building",
  ...COMMON_ENGLISH_CONTENT_WORDS,
  "current",
  "currently",
  "default",
  "disabled",
  "don",
  "enabled",
  "error",
  "errors",
  "fixed",
  "healthy",
  "home",
  "inactive",
  "issue",
  "issues",
  "latest",
  "orchestrator",
  "out",
  "products",
  "recent",
  "search",
  "silverhand",
  "store",
  "stored",
  "stores",
  "sync",
  "tool",
  "tools",
  "working",
]);

const QUERY_STOPWORDS = new Set([
  "wer", "ist", "war", "was", "wie", "wo", "wann", "warum", "wieso", "ueber",
  "über", "und", "oder", "der", "die", "das", "ein", "eine", "einer", "einem",
  "einen", "den", "dem", "des", "mit", "von", "zu", "im", "in", "am", "an",
  "auf", "about", "tell", "me", "who", "is", "was", "the", "a", "an", "and",
  "or", "to", "for", "please", "bitte",
  "after", "before", "also", "just", "here", "there", "then", "that",
  "these", "those", "with", "from", "have", "been", "will", "would",
  "should", "could", "each", "every", "some", "both", "other", "such",
  "keep", "make", "need", "want", "get", "set", "use", "run", "try",
  "let", "put", "new", "old", "all", "any", "not", "but", "yet",
  "now", "how", "can", "may", "did", "does", "done", "its", "our",
  "your", "his", "her", "their", "this", "which", "when", "where",
  "while", "since", "until", "into", "only", "very", "more", "most",
  "noch", "auch", "aber", "denn", "weil", "wenn", "dann", "hier",
  "dort", "schon", "jetzt", "immer", "alles", "mein", "dein", "sein",
  ...COMMON_NON_PERSON_TOKENS,
]);

const ENTITY_NOISE_STOPWORDS = new Set([
  "partner", "partnerin", "beziehung", "relationship", "friend", "boyfriend", "girlfriend",
  "wife", "husband", "coach", "life", "berater", "beraterin", "speaker", "community",
  "freundin", "freund", "sozialarbeiterin", "sozialarbeiter",
  "profile", "update", "memory", "context", "entity", "project", "company",
  "add", "are", "was", "ist", "als", "about", "with", "without", "follow",
  "access", "agent", "approval", "bridge", "brigittaplatz", "browser", "calorie", "calories",
  "chrome", "club", "code", "cookies", "disk", "detaillierte", "email", "first", "fort",
  "full", "gateway", "geburtstag", "identity", "kaffee", "lebt", "mac", "menschen",
  "neobank", "original", "poly", "prozess", "refresh", "restart", "send", "setup", "soft",
  "studio", "thoughtful", "token", "topic", "uhr", "user", "verify", "vienna", "wichtige",
  "wien", "wrong", "zumsteinplatz", "archive", "contact", "content", "date",
  "warm", ...COMMON_NON_PERSON_TOKENS,
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "jan", "feb", "mar", "apr",
  "jun", "jul", "aug", "sep", "oct", "nov", "dec", "today", "heute",
]);

const PLACEISH_TOKEN_RE = /(?:platz|strasse|straße|gasse|weg|allee|street|road)$/i;
const TECHISH_TOKEN_RE =
  /^(?:email|chrome|cookies|gateway|token|verify|refresh|restart|setup|plugin|vault|repo|project|company|organization|organisation|business|startup|browser|agent|user)$/i;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const clamp01 = (value: unknown): number =>
  Math.max(0, Math.min(1, Number(value) || 0));

const escapeRegex = (value: unknown): string =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const splitSentences = (value: unknown): string[] =>
  String(value || "")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

const findCandidateLocalContext = (content: unknown, candidate: unknown): string => {
  const text = String(content || "");
  const key = String(candidate || "").trim();
  if (!text || !key) return "";
  const relevant = splitSentences(text).filter((sentence) =>
    containsEntity(sentence, key, true),
  );
  return relevant.join(" ").trim() || text;
};

const countCandidateOccurrences = (content: unknown, candidate: unknown): number => {
  const text = normalizeContent(content);
  const key = normalizeContent(candidate);
  if (!text || !key) return 0;
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegex(key)}([^\\p{L}\\p{N}_]|$)`,
    "giu",
  );
  let matches = 0;
  while (re.exec(text)) matches += 1;
  return matches;
};

const hasHumanUsagePattern = (content: unknown, candidate: unknown): boolean => {
  const text = normalizeContent(content);
  const key = normalizeContent(candidate)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => escapeRegex(token))
    .join("\\s+");
  if (!text || !key) return false;
  const patterns = [
    new RegExp(
      `\\b(?:my|our|his|her|their)\\s+(?:partner(?:in)?|friend|wife|husband|girlfriend|boyfriend)\\s+${key}\\b`,
      "iu",
    ),
    new RegExp(
      `\\b(?:met|meet|with|about|from|ask|asked|page|paged|ping|pinged|message|messaged|email|emailed|call|called|contact|contacted|tell|told|tell me about|who is|wer ist|ueber|über)\\s+${key}\\b`,
      "iu",
    ),
    new RegExp(
      `\\b${key}\\s+(?:(?:will|would|can)\\s+)?(?:say|said|ask|asked|reply|replied|message|messaged|call|called|email|emailed|work|works|worked|live|lives|lived|prefer|prefers|like|likes|love|loves|hate|hates|date|dates|join|joined|help|helped|support|supports|manage|manages|lead|leads|want|wants|plan|plans|request|requested|approve|approved|review|reviewed|verify|verified|confirm|confirmed|coordinate|coordinated|handle|handled|page|paged|ping|pinged)\\b`,
      "iu",
    ),
    new RegExp(`\\b${key}\\s+(?:is|was)\\s+(?:a|an)\\b`, "iu"),
    new RegExp(
      `\\b${key}\\s+(?:is|was)\\s+(?:working|building|leading|coordinating|handling|reviewing|debugging|fixing|pushing)\\b`,
      "iu",
    ),
  ];
  return patterns.some((pattern) => pattern.test(text));
};

const classifyMentionRoleForEntity = (
  content: unknown,
  entityKey: unknown,
): "relationship" | "public_profile" | "ops_noise" | "general" =>
  classifyPersonRole(findCandidateLocalContext(content, entityKey));

const isSupportedSingleTokenNameCandidate = (
  content: unknown,
  original: string,
  normalized: string,
): boolean => {
  if (!isLikelyStandaloneNameCandidate(original, normalized)) return false;
  const localContext = findCandidateLocalContext(content, original);
  const localRole = classifyPersonRole(localContext);
  if (localRole === "relationship" || localRole === "public_profile") return true;
  if (countCandidateOccurrences(content, original) >= 2) return true;
  return hasHumanUsagePattern(localContext, original);
};

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export const containsEntity = (
  content: unknown,
  entityKey: unknown,
  requireWordBoundaryMatch = true,
): boolean => {
  const text = normalizeContent(content);
  const key = normalizeContent(entityKey);
  if (!text || !key) return false;
  if (!requireWordBoundaryMatch) return text.includes(key);
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegex(key)}([^\\p{L}\\p{N}_]|$)`,
    "iu",
  );
  return re.test(text);
};

export const classifyPersonRole = (
  content: unknown,
): "relationship" | "public_profile" | "ops_noise" | "general" => {
  const text = String(content || "");
  if (RELATIONSHIP_RE.test(text)) return "relationship";
  if (PUBLIC_PROFILE_RE.test(text)) return "public_profile";
  if (OPS_NOISE_RE.test(text)) return "ops_noise";
  return "general";
};

const isLikelyStandaloneNameCandidate = (
  original: string,
  normalized: string,
): boolean => {
  if (!normalized || ENTITY_NOISE_STOPWORDS.has(normalized)) return false;
  if (COMMON_NON_PERSON_TOKENS.has(normalized)) return false;
  if (PLACEISH_TOKEN_RE.test(original) || PLACEISH_TOKEN_RE.test(normalized)) return false;
  if (TECHISH_TOKEN_RE.test(normalized)) return false;
  if (!/^[a-zäöüß][a-zäöüß''.-]{2,47}$/i.test(original)) return false;
  // Comprehensive common-word filter: reject any single token that is a
  // common English word (the core fix for garbage entity extraction)
  if (!isLikelyEntityName(normalized)) return false;
  return true;
};

const MULTI_WORD_PROPER_NAME_RE = /\b[A-ZÄÖÜ][a-zäöüß]{1,}(?:\s+[A-ZÄÖÜ][a-zäöüß]{1,})+\b/g;

const EXPLICIT_ENTITY_CONTEXT_RE =
  /\b(?:person named|user named|named|called|known as|name is|meet|met)\s+([A-ZÄÖÜ][a-zäöüß]{2,})\b/gi;

const splitNameCandidates = (value: unknown): string[] => {
  const text = String(value || "");
  const out = new Set<string>();

  // --- Multi-word capitalized sequences are strong name candidates ---
  // e.g. "Lucas Synnott", "Johnny Silverhand", "Applied Leverage"
  const multiWord = text.match(MULTI_WORD_PROPER_NAME_RE) || [];
  for (const item of multiWord) {
    const normalized = normalizeContent(item);
    if (!normalized || ENTITY_NOISE_STOPWORDS.has(normalized)) continue;
    if (!isLikelyEntityName(normalized)) continue;
    out.add(normalized);
  }

  // --- Single capitalized words are NOT valid person candidates ---
  // Exception: they appear in an explicit entity context pattern
  let match: RegExpExecArray | null;
  const contextRe = new RegExp(EXPLICIT_ENTITY_CONTEXT_RE.source, EXPLICIT_ENTITY_CONTEXT_RE.flags);
  while ((match = contextRe.exec(text)) !== null) {
    const name = match[1];
    if (!name) continue;
    const normalized = normalizeContent(name);
    if (!normalized || ENTITY_NOISE_STOPWORDS.has(normalized)) continue;
    if (!isLikelyEntityName(normalized)) continue;
    out.add(normalized);
  }

  // --- Relationship context patterns still extract single names ---
  // e.g. "my girlfriend Sarah", "partner Anna"
  const relation =
    text.match(
      /\b(?:partner(?:in)?|friend|wife|husband|girlfriend|boyfriend)\s+([A-Za-zÄÖÜäöüß-]{3,})\b/gi,
    ) || [];
  for (const matchStr of relation) {
    const name = matchStr.split(/\s+/).slice(-1).join(" ");
    if (!/^[A-ZÄÖÜ]/.test(name)) continue;
    const normalized = normalizeContent(name);
    if (!normalized || ENTITY_NOISE_STOPWORDS.has(normalized)) continue;
    out.add(normalized);
  }

  const known = text.match(WELL_KNOWN_NAMES_RE) || [];
  for (const item of known) {
    const normalized = normalizeContent(item);
    if (normalized) out.add(normalized);
  }
  return Array.from(out).filter(
    (item) =>
      item.length >= 3 &&
      item.length <= 48 &&
      !QUERY_STOPWORDS.has(item) &&
      !ENTITY_NOISE_STOPWORDS.has(item),
  );
};

const isLikelyEntityToken = (value: unknown): boolean => {
  const token = normalizeContent(value);
  if (!token) return false;
  if (token.length < 3 || token.length > 48) return false;
  if (/^\d+$/.test(token)) return false;
  if (COMMON_NON_PERSON_TOKENS.has(token)) return false;
  if (QUERY_STOPWORDS.has(token)) return false;
  if (ENTITY_NOISE_STOPWORDS.has(token)) return false;
  // Comprehensive common-word filter
  if (!isLikelyEntityName(token)) return false;
  return true;
};

const pushEntityCandidate = (set: Set<string>, value: unknown): void => {
  const normalized = normalizeContent(value);
  if (!isLikelyEntityToken(normalized)) return;
  set.add(normalized);
};

export interface ScorePersonContentOptions {
  content?: string;
  entityKeys?: string[];
  config?: {
    person?: {
      requireWordBoundaryMatch?: boolean;
      relationshipPriorityBoost?: number;
      keepPublicFacts?: boolean;
      publicProfileBoost?: number;
    };
  };
}

export interface PersonContentScore {
  score: number;
  role: "relationship" | "public_profile" | "ops_noise" | "general";
}

export const scorePersonContent = ({
  content = "",
  entityKeys = [],
  config = {},
}: ScorePersonContentOptions = {}): PersonContentScore | null => {
  let keys = Array.isArray(entityKeys)
    ? entityKeys.map((item) => normalizeContent(item)).filter(Boolean)
    : [];
  // Auto-detect entity candidates from content if no keys provided
  if (keys.length === 0) {
    keys = splitNameCandidates(content);
  }

  // Even without extractable entity keys, classify content that has strong
  // person-role signals (relationship/public_profile cues) — this allows
  // scoring unnamed-person content like "She is a TEDx speaker".
  const role = classifyPersonRole(content);

  if (keys.length === 0) {
    // No entity keys found — only return a score if content has strong person cues
    if (role === "relationship" || role === "public_profile") {
      let score = 0.35;
      if (role === "relationship") score += Number(config?.person?.relationshipPriorityBoost ?? 0.35);
      if (role === "public_profile" && config?.person?.keepPublicFacts !== false) {
        score += Number(config?.person?.publicProfileBoost ?? 0.1);
      }
      return { score: clamp01(score), role };
    }
    return null;
  }
  let matched = false;
  for (const key of keys) {
    if (containsEntity(content, key, config?.person?.requireWordBoundaryMatch !== false)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  let score = 0.35;
  if (role === "relationship") score += Number(config?.person?.relationshipPriorityBoost ?? 0.35);
  if (role === "public_profile" && config?.person?.keepPublicFacts !== false) {
    score += Number(config?.person?.publicProfileBoost ?? 0.1);
  }
  if (role === "ops_noise") score -= 0.25;
  return {
    score: clamp01(score),
    role,
  };
};

export const ensurePersonStore = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_mentions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      entity_display TEXT NOT NULL,
      role TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_key, role);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_memory ON entity_mentions(memory_id, source);
  `);
};

interface SummaryRow {
  memory_id: string;
  content: string;
}

export const rebuildEntityMentions = (db: DatabaseSync): void => {
  ensurePersonStore(db);

  // Read from summaries table (LCM source) instead of memory_current / memory_native_chunks
  let summaryRows: SummaryRow[] = [];
  try {
    summaryRows = db
      .prepare(
        `SELECT summary_id AS memory_id, content
         FROM summaries
         WHERE content IS NOT NULL AND content != ''`,
      )
      .all() as unknown as SummaryRow[];
  } catch {
    // summaries table may not exist in isolated test contexts
    summaryRows = [];
  }

  const insert = db.prepare(`
    INSERT INTO entity_mentions (
      id, memory_id, entity_key, entity_display, role, confidence, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const clear = db.prepare("DELETE FROM entity_mentions");

  db.exec("BEGIN");
  try {
    clear.run();
    for (const row of summaryRows) {
      const memoryId = String(row.memory_id || "");
      const content = String(row.content || "");
      if (!memoryId || !content) continue;
      for (const entity of splitNameCandidates(content)) {
        const role = classifyMentionRoleForEntity(content, entity);
        const confidence =
          role === "relationship"
            ? 0.92
            : role === "public_profile"
              ? 0.84
              : role === "ops_noise"
                ? 0.4
                : 0.65;
        insert.run(
          `${memoryId}|${entity}|lcm_summary`,
          memoryId,
          entity,
          entity,
          role,
          confidence,
          "lcm_summary",
        );
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

interface EntityMentionRow {
  entity_key: string;
}

export const resolveEntityKeysForQuery = (
  db: DatabaseSync,
  query: unknown,
  options: { fallbackTokens?: boolean } = {},
): string[] => {
  ensurePersonStore(db);
  const raw = String(query || "").trim();
  if (!raw) return [];
  const queryNormalized = normalizeContent(raw);
  const tokens = queryNormalized.split(/\s+/).filter(Boolean);
  const out = new Set<string>();

  const rows = db
    .prepare(
      `SELECT entity_key
       FROM entity_mentions
       GROUP BY entity_key
       ORDER BY COUNT(*) DESC
       LIMIT 500`,
    )
    .all() as unknown as EntityMentionRow[];
  for (const row of rows) {
    const key = normalizeContent(row.entity_key);
    if (!key) continue;
    if (key.includes(" ")) {
      if (queryNormalized.includes(key)) out.add(key);
      continue;
    }
    if (tokens.includes(key)) out.add(key);
  }

  const explicitTail = raw.match(ENTITY_QUERY_HINT_TAIL_RE)?.[1] || "";
  if (explicitTail) {
    const cleaned = String(explicitTail).split(/[?.!,:;]/)[0].trim();
    pushEntityCandidate(out, cleaned);
    const explicitTokens = normalizeContent(cleaned).split(/\s+/).filter(Boolean);
    for (const token of explicitTokens) pushEntityCandidate(out, token);
  }

  const properNames = raw.match(PROPER_NAME_RE) || [];
  for (const item of properNames) pushEntityCandidate(out, item);

  if (PERSON_QUERY_HINT_RE.test(raw)) {
    const directKnown = raw.match(WELL_KNOWN_NAMES_RE) || [];
    for (const item of directKnown) pushEntityCandidate(out, item);
  }

  if (options?.fallbackTokens === true || out.size === 0) {
    for (const token of tokens) {
      if (token.length >= 3 && token.length <= 24) pushEntityCandidate(out, token);
    }
    if (tokens.length > 0) pushEntityCandidate(out, tokens[tokens.length - 1]);
  }

  return Array.from(out).filter(Boolean).slice(0, 8);
};
