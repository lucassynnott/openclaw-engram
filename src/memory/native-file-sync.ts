import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  classifyValue,
  detectJunk,
  hasTemporalContext,
  hashNormalized,
  inferKind,
  normalizeContent,
  type MemoryKind,
  VALID_KINDS,
} from "./memory-utils.js";
import { ensureMemoryTables } from "./memory-schema.js";

type SourceLayer = "registry" | "promoted_native" | "native";

type MemoryRow = {
  memory_id: string;
  type: string;
  content: string;
  normalized: string;
  normalized_hash: string;
  source: string;
  confidence: number;
  scope: string;
  status: string;
  value_score: number | null;
  value_label: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  tags: string;
  superseded_by: string | null;
  content_time: string | null;
  valid_until: string | null;
  source_layer: string;
  source_path: string | null;
  source_line: number | null;
};

type ParsedEntry = {
  memoryId: string | null;
  kind: MemoryKind;
  content: string;
  scope: string;
  status: string;
  contentTime: string | null;
  sourceLayer: SourceLayer;
  sourcePath: string;
  sourceLine: number;
  relatedEntities: string[];
  supersededBy: string | null;
};

export type NativeReindexResult = {
  rootDir: string;
  scannedFiles: number;
  imported: number;
  updated: number;
  skipped: number;
  conflicts: number;
};

export type NativeSyncResult = {
  rootDir: string;
  filesWritten: number;
  memoryFilePath: string;
  dailyNoteCount: number;
  paraFolderCount: number;
};

const MEMORY_SYNC_START = "<!-- engram:sync:start -->";
const MEMORY_SYNC_END = "<!-- engram:sync:end -->";
const MEMORY_ID_COMMENT_RE = /<!--\s*engram:id=([A-Za-z0-9_-]+)\s*-->/;
const DAILY_NOTE_RE = /^memory\/(\d{4}-\d{2}-\d{2})[^/]*\.md$/i;
const MEMORY_FILE_RE = /^MEMORY\.md$/i;
const PARA_ITEM_RE = /^life\/(projects|areas|resources|archives)\/([^/]+)\/items\.ya?ml$/i;

const SOURCE_PRIORITY: Record<SourceLayer, number> = {
  native: 1,
  promoted_native: 2,
  registry: 3,
};

function toPosix(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

function ensureDir(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    console.warn(`[native-file-sync] mkdirSync failed for ${dirPath}:`, err);
  }
}

function readUtf8IfExists(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(`[native-file-sync] readFileSync failed for ${filePath}:`, err);
    return "";
  }
}

function writeIfChanged(filePath: string, content: string): boolean {
  const next = content.endsWith("\n") ? content : `${content}\n`;
  const existing = readUtf8IfExists(filePath);
  if (existing === next) return false;
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, next, "utf8");
  } catch (err) {
    console.warn(`[native-file-sync] writeFileSync failed for ${filePath}:`, err);
    return false;
  }
  return true;
}

function slugify(value: string, fallback = "general"): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function titleFromSlug(value: string): string {
  const slug = String(value || "").trim();
  if (!slug) return "General";
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeInlineComment(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSourceLayer(value: string): SourceLayer {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "promoted_native") return "promoted_native";
  if (normalized === "native") return "native";
  return "registry";
}

function memorySourcePriority(value: string): number {
  return SOURCE_PRIORITY[normalizeSourceLayer(value)];
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function canonicalRelatedEntitiesFromTags(tags: string): string[] {
  return parseTags(tags)
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "shared/general")
    .sort();
}

function yamlScalar(value: string | number | null): string {
  if (value === null || value === "") return "null";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function parseYamlScalar(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!value || value === "null") return null;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      if (value.startsWith("\"")) return JSON.parse(value);
      return value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function deterministicNativeMemoryId(entry: ParsedEntry): string {
  return `mem_native_${hashNormalized(`${entry.sourceLayer}:${entry.sourcePath}:${entry.content}`)}`.slice(0, 27);
}

function inferCategory(kind: MemoryKind): string {
  switch (kind) {
    case "PREFERENCE": return "preference";
    case "EPISODE": return "milestone";
    case "ENTITY": return "relationship";
    case "DECISION": return "status";
    default: return "status";
  }
}

function categoryToKind(category: string, fallback: MemoryKind): MemoryKind {
  const normalized = String(category || "").trim().toLowerCase();
  if (normalized === "preference") return "PREFERENCE";
  if (normalized === "milestone") return "EPISODE";
  if (normalized === "relationship") return "ENTITY";
  return fallback;
}

function parseManagedMarkdown(filePath: string, rootDir: string): ParsedEntry[] {
  const relPath = toPosix(path.relative(rootDir, filePath));
  const lines = readUtf8IfExists(filePath).split(/\r?\n/);
  const entries: ParsedEntry[] = [];
  const dailyMatch = relPath.match(DAILY_NOTE_RE);
  const dayKeyValue = dailyMatch?.[1] ?? null;
  let insideManagedBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine.includes(MEMORY_SYNC_START)) {
      insideManagedBlock = true;
      continue;
    }
    if (rawLine.includes(MEMORY_SYNC_END)) {
      insideManagedBlock = false;
      continue;
    }
    if (insideManagedBlock) continue;

    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("- ")) continue;
    const idMatch = rawLine.match(MEMORY_ID_COMMENT_RE);
    const withoutComment = rawLine.replace(MEMORY_ID_COMMENT_RE, "").trim();
    const match = withoutComment.match(/^- (?:\[(\d{2}:\d{2})\]\s+)?(?:\[([A-Z_]+)\]\s+)?(.+?)$/);
    if (!match) continue;

    const explicitKind = String(match[2] || "").trim().toUpperCase();
    const content = escapeInlineComment(match[3]);
    if (!content) continue;
    const kind = VALID_KINDS.includes(explicitKind as MemoryKind)
      ? (explicitKind as MemoryKind)
      : inferKind(content);

    entries.push({
      memoryId: idMatch?.[1] ? String(idMatch[1]) : null,
      kind,
      content,
      scope: "shared",
      status: "active",
      contentTime: dayKeyValue,
      sourceLayer: "native",
      sourcePath: relPath,
      sourceLine: index + 1,
      relatedEntities: [],
      supersededBy: null,
    });
  }

  return entries;
}

function parseItemsYaml(filePath: string, rootDir: string): ParsedEntry[] {
  const relPath = toPosix(path.relative(rootDir, filePath));
  const lines = readUtf8IfExists(filePath).split(/\r?\n/);
  const entries: ParsedEntry[] = [];
  const match = relPath.match(PARA_ITEM_RE);
  if (!match) return entries;

  const bucket = match[1];
  const folder = match[2];
  const inferredScope = bucket === "projects" ? folder : "shared";
  let current: (ParsedEntry & { category: string | null }) | null = null;
  let readingRelated = false;

  const flush = (): void => {
    if (!current || !current.content.trim()) {
      current = null;
      readingRelated = false;
      return;
    }
    const resolvedKind =
      current.kind !== "USER_FACT"
        ? current.kind
        : categoryToKind(current.category || "", inferKind(current.content));
    entries.push({
      memoryId: current.memoryId,
      kind: resolvedKind,
      content: current.content,
      scope: current.scope,
      status: current.status,
      contentTime: current.contentTime,
      sourceLayer: "promoted_native",
      sourcePath: relPath,
      sourceLine: current.sourceLine,
      relatedEntities: current.relatedEntities,
      supersededBy: current.supersededBy,
    });
    current = null;
    readingRelated = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const itemStart = line.match(/^- id:\s*(.+)$/);
    if (itemStart) {
      flush();
      current = {
        memoryId: parseYamlScalar(itemStart[1]),
        kind: "USER_FACT",
        content: "",
        scope: inferredScope,
        status: "active",
        contentTime: null,
        sourceLayer: "promoted_native",
        sourcePath: relPath,
        sourceLine: index + 1,
        relatedEntities: [],
        supersededBy: null,
        category: null,
      };
      continue;
    }
    if (!current) continue;

    if (/^\s{2}related_entities:\s*$/.test(line)) {
      readingRelated = true;
      continue;
    }
    if (readingRelated) {
      const relatedMatch = line.match(/^\s{4}-\s*(.+)$/);
      if (relatedMatch) {
        const related = parseYamlScalar(relatedMatch[1]);
        if (related) current.relatedEntities.push(related);
        continue;
      }
      if (!/^\s+/.test(line) || /^\s{2}[A-Za-z_]+:/.test(line)) {
        readingRelated = false;
      } else {
        continue;
      }
    }

    const fieldMatch = line.match(/^\s{2}([A-Za-z_]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const key = fieldMatch[1];
    const value = parseYamlScalar(fieldMatch[2]);
    switch (key) {
      case "fact":
        current.content = String(value || "");
        break;
      case "kind":
        if (value) {
          const upper = value.toUpperCase();
          if (VALID_KINDS.includes(upper as MemoryKind)) current.kind = upper as MemoryKind;
        }
        break;
      case "category":
        current.category = String(value || "");
        break;
      case "timestamp":
        current.contentTime = value;
        break;
      case "status":
        current.status = String(value || "active");
        break;
      case "scope":
        current.scope = String(value || inferredScope || "shared");
        break;
      case "superseded_by":
        current.supersededBy = value;
        break;
      default:
        break;
    }
  }

  flush();
  return entries;
}

function listRelevantFiles(rootDir: string): string[] {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (currentDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[native-file-sync] readdirSync failed for ${currentDir}:`, err);
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const relPath = toPosix(path.relative(rootDir, fullPath));
      if (MEMORY_FILE_RE.test(relPath) || DAILY_NOTE_RE.test(relPath) || PARA_ITEM_RE.test(relPath)) {
        out.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

function getAllMemories(db: DatabaseSync): MemoryRow[] {
  return db.prepare(`
    SELECT
      memory_id, type, content, normalized, normalized_hash, source,
      confidence, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, tags, superseded_by,
      content_time, valid_until, source_layer, source_path, source_line
    FROM memory_current
    ORDER BY COALESCE(content_time, created_at) DESC, updated_at DESC, memory_id ASC
  `).all() as MemoryRow[];
}

function sameMemoryProjection(row: MemoryRow, next: {
  kind: MemoryKind;
  content: string;
  normalized: string;
  normalizedHash: string;
  confidence: number;
  scope: string;
  status: string;
  valueScore: number;
  valueLabel: string;
  archivedAt: string | null;
  tags: string;
  supersededBy: string | null;
  contentTime: string | null;
  sourceLayer: SourceLayer;
  sourcePath: string;
  sourceLine: number;
}): boolean {
  return (
    row.type === next.kind &&
    row.content === next.content &&
    row.normalized === next.normalized &&
    row.normalized_hash === next.normalizedHash &&
    Number(row.confidence || 0) === next.confidence &&
    row.scope === next.scope &&
    row.status === next.status &&
    Number(row.value_score || 0) === next.valueScore &&
    String(row.value_label || "") === next.valueLabel &&
    String(row.archived_at || "") === String(next.archivedAt || "") &&
    String(row.tags || "[]") === next.tags &&
    String(row.superseded_by || "") === String(next.supersededBy || "") &&
    String(row.content_time || "") === String(next.contentTime || "") &&
    normalizeSourceLayer(row.source_layer) === next.sourceLayer &&
    String(row.source_path || "") === next.sourcePath &&
    Number(row.source_line || 0) === next.sourceLine
  );
}

function dayKey(row: MemoryRow): string {
  const raw = String(row.content_time || row.created_at || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match?.[1]) return match[1];
  return new Date(row.created_at).toISOString().slice(0, 10);
}

function sameSemanticPayload(row: MemoryRow, next: {
  kind: MemoryKind;
  content: string;
  normalized: string;
  normalizedHash: string;
  scope: string;
  status: string;
  tags: string;
  supersededBy: string | null;
  contentTime: string | null;
}): boolean {
  const rowContentTime = String(row.content_time || "").trim();
  const nextContentTime = String(next.contentTime || "").trim();
  return (
    row.type === next.kind &&
    row.content === next.content &&
    row.normalized === next.normalized &&
    row.normalized_hash === next.normalizedHash &&
    row.scope === next.scope &&
    row.status === next.status &&
    JSON.stringify(canonicalRelatedEntitiesFromTags(row.tags || "[]")) ===
      JSON.stringify(canonicalRelatedEntitiesFromTags(next.tags)) &&
    String(row.superseded_by || "") === String(next.supersededBy || "") &&
    (
      rowContentTime === nextContentTime ||
      (!rowContentTime && nextContentTime === dayKey(row)) ||
      (!nextContentTime && rowContentTime === dayKey(row))
    )
  );
}

function relativeFromRoot(rootDir: string, filePath: string): string {
  return toPosix(path.relative(rootDir, filePath));
}

function upsertEpisodeFromMemory(db: DatabaseSync, row: {
  memoryId: string;
  kind: MemoryKind;
  content: string;
  contentTime: string | null;
  status: string;
}): void {
  if (row.kind !== "EPISODE" && !hasTemporalContext(row.content)) return;
  const episodeId = `ep_${row.memoryId}`;
  const title = row.content.length > 80 ? `${row.content.slice(0, 77)}...` : row.content;
  db.prepare(`
    INSERT INTO memory_episodes (
      episode_id, title, summary, status, source_memory_ids, payload
    ) VALUES (?, ?, ?, ?, ?, '{}')
    ON CONFLICT(episode_id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      status = excluded.status,
      source_memory_ids = excluded.source_memory_ids
  `).run(
    episodeId,
    title,
    row.content,
    row.status === "active" ? "completed" : row.status,
    JSON.stringify([row.memoryId]),
  );
}

export function reindexNativeMemoryLayer(input: {
  db: DatabaseSync;
  rootDir: string;
  now?: string;
}): NativeReindexResult {
  const rootDir = String(input.rootDir || "").trim();
  ensureMemoryTables(input.db);

  if (!rootDir) {
    return { rootDir, scannedFiles: 0, imported: 0, updated: 0, skipped: 0, conflicts: 0 };
  }

  const now = input.now || new Date().toISOString();
  ensureDir(rootDir);

  const files = listRelevantFiles(rootDir);
  const entries = files.flatMap((filePath) => {
    const relPath = relativeFromRoot(rootDir, filePath);
    if (MEMORY_FILE_RE.test(relPath) || DAILY_NOTE_RE.test(relPath)) {
      return parseManagedMarkdown(filePath, rootDir);
    }
    return parseItemsYaml(filePath, rootDir);
  });

  const existingRows = getAllMemories(input.db);
  const rowById = new Map(existingRows.map((row) => [row.memory_id, row]));
  const bestByHashScope = new Map<string, MemoryRow>();

  const setBestRow = (row: MemoryRow): void => {
    const key = `${row.normalized_hash}|${row.scope}`;
    const current = bestByHashScope.get(key);
    if (!current || memorySourcePriority(row.source_layer) > memorySourcePriority(current.source_layer)) {
      bestByHashScope.set(key, row);
    }
  };

  for (const row of existingRows) {
    if (!row.normalized_hash) continue;
    setBestRow(row);
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  const insertStmt = input.db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash,
      source, confidence, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, tags, superseded_by,
      content_time, source_layer, source_path, source_line
    ) VALUES (?, ?, ?, ?, ?, 'native_file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = input.db.prepare(`
    UPDATE memory_current
    SET
      type = ?,
      content = ?,
      normalized = ?,
      normalized_hash = ?,
      source = 'native_file',
      confidence = ?,
      scope = ?,
      status = ?,
      value_score = ?,
      value_label = ?,
      updated_at = ?,
      archived_at = ?,
      tags = ?,
      superseded_by = ?,
      content_time = ?,
      source_layer = ?,
      source_path = ?,
      source_line = ?
    WHERE memory_id = ?
  `);

  for (const entry of entries) {
    const junk = detectJunk(entry.content);
    if (junk.junk) {
      skipped += 1;
      continue;
    }

    const normalized = normalizeContent(entry.content);
    const normalizedHash = hashNormalized(entry.content);
    if (!normalized || !normalizedHash) {
      skipped += 1;
      continue;
    }

    const confidence = entry.sourceLayer === "promoted_native" ? 0.82 : 0.72;
    const classification = classifyValue(entry.content, entry.kind, confidence);
    const archivedAt = entry.status === "active" ? null : (entry.contentTime || now);
    const tagsJson = JSON.stringify(entry.relatedEntities);
    const existingById = entry.memoryId ? rowById.get(entry.memoryId) : null;
    const duplicateKey = `${normalizedHash}|${entry.scope}`;
    const duplicate = bestByHashScope.get(duplicateKey);
    const sameSemanticRow = existingById
      ? sameSemanticPayload(existingById, {
          kind: entry.kind,
          content: entry.content,
          normalized,
          normalizedHash,
          scope: entry.scope,
          status: entry.status,
          tags: tagsJson,
          supersededBy: entry.supersededBy,
          contentTime: entry.contentTime,
        })
      : false;

    if (existingById) {
      const existingLayer = normalizeSourceLayer(existingById.source_layer);
      if (sameSemanticRow) {
        skipped += 1;
        continue;
      }
      if (existingLayer === "registry" && entry.sourceLayer !== "registry") {
        conflicts += 1;
        continue;
      }

      const shouldKeepExisting =
        SOURCE_PRIORITY[existingLayer] > SOURCE_PRIORITY[entry.sourceLayer] &&
        existingLayer === "promoted_native";
      if (shouldKeepExisting) {
        skipped += 1;
        continue;
      }

      const nextLayer =
        SOURCE_PRIORITY[entry.sourceLayer] >= SOURCE_PRIORITY[existingLayer]
          ? entry.sourceLayer
          : existingLayer;
      if (sameMemoryProjection(existingById, {
        kind: entry.kind,
        content: entry.content,
        normalized,
        normalizedHash,
        confidence,
        scope: entry.scope,
        status: entry.status,
        valueScore: classification.value_score,
        valueLabel: classification.value_label,
        archivedAt,
        tags: tagsJson,
        supersededBy: entry.supersededBy,
        contentTime: entry.contentTime,
        sourceLayer: nextLayer,
        sourcePath: entry.sourcePath,
        sourceLine: entry.sourceLine,
      })) {
        skipped += 1;
        continue;
      }

      updateStmt.run(
        entry.kind,
        entry.content,
        normalized,
        normalizedHash,
        confidence,
        entry.scope,
        entry.status,
        classification.value_score,
        classification.value_label,
        now,
        archivedAt,
        tagsJson,
        entry.supersededBy,
        entry.contentTime,
        nextLayer,
        entry.sourcePath,
        entry.sourceLine,
        existingById.memory_id,
      );

      const nextRow: MemoryRow = {
        ...existingById,
        type: entry.kind,
        content: entry.content,
        normalized,
        normalized_hash: normalizedHash,
        source: "native_file",
        confidence,
        scope: entry.scope,
        status: entry.status,
        value_score: classification.value_score,
        value_label: classification.value_label,
        updated_at: now,
        archived_at: archivedAt,
        tags: tagsJson,
        superseded_by: entry.supersededBy,
        content_time: entry.contentTime,
        source_layer: nextLayer,
        source_path: entry.sourcePath,
        source_line: entry.sourceLine,
      };
      rowById.set(nextRow.memory_id, nextRow);
      setBestRow(nextRow);
      if (entry.kind === "EPISODE" || hasTemporalContext(entry.content)) {
        upsertEpisodeFromMemory(input.db, {
          memoryId: nextRow.memory_id,
          kind: entry.kind,
          content: nextRow.content,
          contentTime: nextRow.content_time,
          status: nextRow.status,
        });
      }
      updated += 1;
      continue;
    }

    if (duplicate) {
      const duplicateLayer = normalizeSourceLayer(duplicate.source_layer);
      if (SOURCE_PRIORITY[duplicateLayer] >= SOURCE_PRIORITY[entry.sourceLayer]) {
        if (duplicateLayer === "registry") conflicts += 1;
        else skipped += 1;
        continue;
      }

      if (sameMemoryProjection(duplicate, {
        kind: entry.kind,
        content: entry.content,
        normalized,
        normalizedHash,
        confidence,
        scope: entry.scope,
        status: entry.status,
        valueScore: classification.value_score,
        valueLabel: classification.value_label,
        archivedAt,
        tags: tagsJson,
        supersededBy: entry.supersededBy,
        contentTime: entry.contentTime,
        sourceLayer: entry.sourceLayer,
        sourcePath: entry.sourcePath,
        sourceLine: entry.sourceLine,
      })) {
        skipped += 1;
        continue;
      }

      updateStmt.run(
        entry.kind,
        entry.content,
        normalized,
        normalizedHash,
        confidence,
        entry.scope,
        entry.status,
        classification.value_score,
        classification.value_label,
        now,
        archivedAt,
        tagsJson,
        entry.supersededBy,
        entry.contentTime,
        entry.sourceLayer,
        entry.sourcePath,
        entry.sourceLine,
        duplicate.memory_id,
      );

      const promotedRow: MemoryRow = {
        ...duplicate,
        type: entry.kind,
        content: entry.content,
        normalized,
        normalized_hash: normalizedHash,
        source: "native_file",
        confidence,
        scope: entry.scope,
        status: entry.status,
        value_score: classification.value_score,
        value_label: classification.value_label,
        updated_at: now,
        archived_at: archivedAt,
        tags: tagsJson,
        superseded_by: entry.supersededBy,
        content_time: entry.contentTime,
        source_layer: entry.sourceLayer,
        source_path: entry.sourcePath,
        source_line: entry.sourceLine,
      };
      rowById.set(promotedRow.memory_id, promotedRow);
      setBestRow(promotedRow);
      if (entry.kind === "EPISODE" || hasTemporalContext(entry.content)) {
        upsertEpisodeFromMemory(input.db, {
          memoryId: promotedRow.memory_id,
          kind: entry.kind,
          content: promotedRow.content,
          contentTime: promotedRow.content_time,
          status: promotedRow.status,
        });
      }
      updated += 1;
      continue;
    }

    const memoryId = entry.memoryId || deterministicNativeMemoryId(entry);
    insertStmt.run(
      memoryId,
      entry.kind,
      entry.content,
      normalized,
      normalizedHash,
      confidence,
      entry.scope,
      entry.status,
      classification.value_score,
      classification.value_label,
      now,
      now,
      archivedAt,
      tagsJson,
      entry.supersededBy,
      entry.contentTime,
      entry.sourceLayer,
      entry.sourcePath,
      entry.sourceLine,
    );

    const row: MemoryRow = {
      memory_id: memoryId,
      type: entry.kind,
      content: entry.content,
      normalized,
      normalized_hash: normalizedHash,
      source: "native_file",
      confidence,
      scope: entry.scope,
      status: entry.status,
      value_score: classification.value_score,
      value_label: classification.value_label,
      created_at: now,
      updated_at: now,
      archived_at: archivedAt,
      tags: tagsJson,
      superseded_by: entry.supersededBy,
      content_time: entry.contentTime,
      valid_until: null,
      source_layer: entry.sourceLayer,
      source_path: entry.sourcePath,
      source_line: entry.sourceLine,
    };
      rowById.set(memoryId, row);
      setBestRow(row);
      if (entry.kind === "EPISODE" || hasTemporalContext(entry.content)) {
        upsertEpisodeFromMemory(input.db, {
          memoryId,
          kind: entry.kind,
          content: entry.content,
          contentTime: entry.contentTime,
          status: entry.status,
        });
      }
      imported += 1;
  }

  return {
    rootDir,
    scannedFiles: files.length,
    imported,
    updated,
    skipped,
    conflicts,
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = out.get(key) || [];
    list.push(item);
    out.set(key, list);
  }
  return out;
}

function chooseParaFolder(row: MemoryRow): { bucket: string; folder: string } {
  const tags = parseTags(row.tags);
  const firstTag = tags[0] ? slugify(tags[0]) : "";
  const scopeSlug = slugify(row.scope || "", "");
  const type = String(row.type || "").trim().toUpperCase();
  const status = String(row.status || "").trim().toLowerCase();

  if (status !== "active") {
    return { bucket: "archives", folder: scopeSlug || firstTag || slugify(type.toLowerCase()) };
  }
  if (scopeSlug && scopeSlug !== "shared") {
    return { bucket: "projects", folder: scopeSlug };
  }
  if (type === "DECISION") {
    return { bucket: "projects", folder: scopeSlug || firstTag || "general" };
  }
  if (["USER_FACT", "PREFERENCE", "ENTITY", "AGENT_IDENTITY"].includes(type)) {
    return { bucket: "areas", folder: firstTag || scopeSlug || "general" };
  }
  return { bucket: "resources", folder: firstTag || scopeSlug || "general" };
}

// --- MEMORY.md sync quality filters ---
// These prevent bootstrap bloat by keeping the sync block small and durable.
// EPISODEs (heartbeats, status logs) stay in engram DB for runtime query.
// Long DECISIONs are status dumps, not real decisions.
const SYNC_EXCLUDED_TYPES = new Set(["EPISODE"]);
const SYNC_DECISION_MAX_CHARS = 200;
const SYNC_TOTAL_MAX_CHARS = 6000;

function renderMemoryMd(memories: MemoryRow[]): string {
  const filtered = memories
    .filter((row) => String(row.status || "").trim().toLowerCase() === "active")
    .filter((row) => !SYNC_EXCLUDED_TYPES.has(String(row.type || "").toUpperCase()))
    .filter((row) => {
      if (String(row.type || "").toUpperCase() === "DECISION" && row.content.length > SYNC_DECISION_MAX_CHARS) {
        return false;
      }
      return true;
    });

  // Sort newest-first so the char cap keeps recent items and drops old ones.
  filtered.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  const groups = groupBy(filtered, (row) => String(row.type || "CONTEXT"));
  const orderedKinds = Array.from(groups.keys()).sort();
  const lines: string[] = [];
  lines.push("## Synced Memories");
  lines.push("");

  if (orderedKinds.length === 0) {
    lines.push("- none");
    lines.push("");
  }

  let totalChars = 0;
  for (const kind of orderedKinds) {
    const rows = (groups.get(kind) || []).slice(0, 50);
    const kindHeader = `### ${kind}\n\n`;
    if (totalChars + kindHeader.length >= SYNC_TOTAL_MAX_CHARS) break;
    totalChars += kindHeader.length;
    lines.push(`### ${kind}`);
    lines.push("");
    for (const row of rows) {
      const line = `- [${kind}] ${escapeInlineComment(row.content)} <!-- engram:id=${row.memory_id} -->`;
      if (totalChars + line.length + 1 > SYNC_TOTAL_MAX_CHARS) break;
      totalChars += line.length + 1;
      lines.push(line);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderDailyNote(date: string, memories: MemoryRow[]): string {
  const lines: string[] = [];
  lines.push("## Engram Sync");
  lines.push("");
  for (const row of memories) {
    const timeMatch = String(row.content_time || "").match(/T(\d{2}:\d{2})/);
    const timePrefix = timeMatch?.[1] ? `[${timeMatch[1]}] ` : "";
    lines.push(`- ${timePrefix}[${row.type}] ${escapeInlineComment(row.content)} <!-- engram:id=${row.memory_id} -->`);
  }
  if (memories.length === 0) lines.push("- none");
  lines.push("");
  return lines.join("\n");
}

function wrapManagedMarkdown(existing: string, title: string, body: string): string {
  const block = `${MEMORY_SYNC_START}\n${body.trim()}\n${MEMORY_SYNC_END}`;
  if (!existing.trim()) {
    return `# ${title}\n\n${block}\n`;
  }

  if (existing.includes(MEMORY_SYNC_START) && existing.includes(MEMORY_SYNC_END)) {
    return `${existing.replace(new RegExp(`${MEMORY_SYNC_START}[\\s\\S]*?${MEMORY_SYNC_END}`), block).trimEnd()}\n`;
  }

  return `${existing.trimEnd()}\n\n${block}\n`;
}

function renderParaSummary(bucket: string, folder: string, rows: MemoryRow[]): string {
  const title = titleFromSlug(folder);
  const activeRows = rows.filter((row) => String(row.status || "").trim().toLowerCase() === "active");
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- bucket: ${bucket}`);
  lines.push(`- folder: ${folder}`);
  lines.push(`- total_items: ${rows.length}`);
  lines.push(`- active_items: ${activeRows.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  for (const row of activeRows.slice(0, 20)) {
    lines.push(`- [${row.type}] ${escapeInlineComment(row.content)}`);
  }
  if (activeRows.length === 0) lines.push("- none");
  lines.push("");
  return lines.join("\n");
}

function renderItemsYaml(rows: MemoryRow[]): { content: string; lineByMemoryId: Map<string, number> } {
  const lines: string[] = [];
  const lineByMemoryId = new Map<string, number>();

  for (const row of rows) {
    lineByMemoryId.set(row.memory_id, lines.length + 1);
    const relatedEntities = parseTags(row.tags);
    lines.push(`- id: ${yamlScalar(row.memory_id)}`);
    lines.push(`  fact: ${yamlScalar(row.content)}`);
    lines.push(`  kind: ${yamlScalar(row.type)}`);
    lines.push(`  category: ${yamlScalar(inferCategory(row.type as MemoryKind))}`);
    lines.push(`  timestamp: ${yamlScalar(dayKey(row))}`);
    lines.push(`  source: ${yamlScalar(normalizeSourceLayer(row.source_layer))}`);
    lines.push(`  status: ${yamlScalar(row.status || "active")}`);
    lines.push(`  superseded_by: ${yamlScalar(row.superseded_by || null)}`);
    lines.push(`  scope: ${yamlScalar(row.scope || "shared")}`);
    lines.push("  related_entities:");
    if (relatedEntities.length === 0) {
      lines.push("    - shared/general");
    } else {
      for (const related of relatedEntities) {
        lines.push(`    - ${yamlScalar(related)}`);
      }
    }
    lines.push(`  last_accessed: ${yamlScalar(dayKey(row))}`);
    lines.push("  access_count: 0");
  }

  return {
    content: lines.join("\n"),
    lineByMemoryId,
  };
}

export function syncNativeMemoryLayer(input: {
  db: DatabaseSync;
  rootDir: string;
}): NativeSyncResult {
  const rootDir = String(input.rootDir || "").trim();
  ensureMemoryTables(input.db);

  if (!rootDir) {
    return {
      rootDir,
      filesWritten: 0,
      memoryFilePath: "",
      dailyNoteCount: 0,
      paraFolderCount: 0,
    };
  }

  ensureDir(rootDir);
  const memories = getAllMemories(input.db).filter(
    (row) => String(row.status || "").trim().toLowerCase() !== "superseded",
  );

  let filesWritten = 0;
  const memoryFilePath = path.join(rootDir, "MEMORY.md");
  const memoryMd = wrapManagedMarkdown(readUtf8IfExists(memoryFilePath), "MEMORY", renderMemoryMd(memories));
  if (writeIfChanged(memoryFilePath, memoryMd)) filesWritten += 1;

  const updateRegistrySource = input.db.prepare(`
    UPDATE memory_current
    SET source_path = ?, source_line = ?
    WHERE memory_id = ? AND lower(coalesce(source_layer, 'registry')) = 'registry'
  `);

  const dailyGroups = groupBy(memories, (row) => dayKey(row));
  const dailyDates = Array.from(dailyGroups.keys()).sort();
  for (const date of dailyDates) {
    const notePath = path.join(rootDir, "memory", `${date}.md`);
    const existing = readUtf8IfExists(notePath);
    const content = wrapManagedMarkdown(
      existing,
      `Daily Note - ${date}`,
      renderDailyNote(date, dailyGroups.get(date) || []),
    );
    if (writeIfChanged(notePath, content)) filesWritten += 1;
  }

  const paraGroups = groupBy(memories, (row) => {
    const placement = chooseParaFolder(row);
    return `${placement.bucket}/${placement.folder}`;
  });
  const paraKeys = Array.from(paraGroups.keys()).sort();
  for (const key of paraKeys) {
    const rows = paraGroups.get(key) || [];
    const [bucket, folder] = key.split("/");
    const folderRoot = path.join(rootDir, "life", bucket, folder);
    const summaryPath = path.join(folderRoot, "summary.md");
    const itemsPath = path.join(folderRoot, "items.yaml");
    const summary = renderParaSummary(bucket, folder, rows);
    const items = renderItemsYaml(rows);
    if (writeIfChanged(summaryPath, summary)) filesWritten += 1;
    if (writeIfChanged(itemsPath, items.content)) filesWritten += 1;
    const relItemsPath = relativeFromRoot(rootDir, itemsPath);
    for (const [memoryId, line] of items.lineByMemoryId.entries()) {
      updateRegistrySource.run(relItemsPath, line, memoryId);
    }
  }

  return {
    rootDir,
    filesWritten,
    memoryFilePath: relativeFromRoot(rootDir, memoryFilePath),
    dailyNoteCount: dailyDates.length,
    paraFolderCount: paraKeys.length,
  };
}
