// ── New registerHttpRoute-based registration ──────────────────────────────────

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getLcmConnection, closeLcmConnection } from "../db/connection.js";
import { getLcmDbFeatures } from "../db/features.js";
import { ConversationStore } from "../memory/store/conversation-store.js";
import { SummaryStore } from "../memory/store/summary-store.js";
import type { LcmConfig } from "../db/config.js";

const parseJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 262144) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > 262144) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

const toNum = (v: string | null, fallback: number): number => {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export type RegisterLcmHttpRoutesOptions = {
  api: OpenClawPluginApi;
  config: LcmConfig;
  gatewayToken?: string;
};

type HttpRouteRegistration = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] & {
  auth?: string;
  match?: string;
};

/**
 * Register all LCM HTTP routes using the new registerHttpRoute API.
 * Replaces the deprecated registerHttpHandler approach.
 */
export const registerLcmHttpRoutes = (opts: RegisterLcmHttpRoutesOptions): void => {
  const { api, config, gatewayToken } = opts;
  const registerRoute = (params: HttpRouteRegistration): void => {
    (api.registerHttpRoute as (params: HttpRouteRegistration) => void)(params);
  };

  // Helper to check auth
  const requireToken = (req: IncomingMessage): boolean => {
    const expectedToken = String(gatewayToken ?? "").trim();
    if (!expectedToken) return true;
    const candidate = String(
      (req.headers as Record<string, string | string[] | undefined>)?.["x-memory-token"] ??
        (req.headers as Record<string, string | string[] | undefined>)?.["x-openclaw-token"] ??
        (req.headers as Record<string, string | string[] | undefined>)?.authorization?.toString().replace(/^Bearer\s+/i, "") ??
        "",
    ).trim();
    if (candidate.length !== expectedToken.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedToken));
  };

  // Service root (no auth required conceptually, but keeping simple)
  registerRoute({
    path: "/memory",
    auth: "plugin",
    handler: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "engram", version: "1.0" }));
    },
  });

  // Health check (no auth)
  registerRoute({
    path: "/memory/health",
    auth: "plugin",
    handler: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  // List conversations
  registerRoute({
    path: "/memory/conversations",
    auth: "plugin",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "method not allowed" }));
        return;
      }
      if (!requireToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "invalid token" }));
        return;
      }
      const url = new URL(req.url ?? "/memory/conversations", "http://localhost");
      const limit = Math.min(500, toNum(url.searchParams.get("limit"), 100));
      const offset = toNum(url.searchParams.get("offset"), 0);
      const db = getLcmConnection(config.databasePath);
      try {
        const rows = db
          .prepare(
            `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
             FROM conversations
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(limit, offset) as Array<{
          conversation_id: number;
          session_id: string;
          title: string | null;
          bootstrapped_at: string | null;
          created_at: string;
          updated_at: string;
        }>;
        const total = (db.prepare("SELECT COUNT(*) AS c FROM conversations").get() as { c: number }).c;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            items: rows.map((r) => ({
              conversationId: r.conversation_id,
              sessionId: r.session_id,
              title: r.title,
              bootstrappedAt: r.bootstrapped_at,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            })),
            count: rows.length,
            total,
            limit,
            offset,
          }),
        );
      } finally {
        closeLcmConnection(config.databasePath);
      }
    },
  });

  // Conversation detail
  registerRoute({
    path: "/memory/conversations",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      if (!requireToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "invalid token" }));
        return;
      }
      const url = new URL(req.url ?? "/memory/conversations/0", "http://localhost");
      const match = url.pathname.match(/^\/memory\/conversations\/([^/]+)$/);
      const rawId = match?.[1];
      const conversationId = rawId ? Number(decodeURIComponent(rawId)) : NaN;
      if (!Number.isFinite(conversationId) || conversationId <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "invalid conversation id" }));
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "method not allowed" }));
        return;
      }
      const db = getLcmConnection(config.databasePath);
      const { fts5Available } = getLcmDbFeatures(db);
      const convStore = new ConversationStore(db, { fts5Available });
      const sumStore = new SummaryStore(db, { fts5Available });
      try {
        const conv = await convStore.getConversation(conversationId);
        if (!conv) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "conversation not found" }));
          return;
        }
        const msgCount = await convStore.getMessageCount(conversationId);
        const tokenCount = await sumStore.getContextTokenCount(conversationId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            item: {
              conversationId: conv.conversationId,
              sessionId: conv.sessionId,
              title: conv.title,
              bootstrappedAt: conv.bootstrappedAt,
              createdAt: conv.createdAt,
              updatedAt: conv.updatedAt,
              messageCount: msgCount,
              contextTokenCount: tokenCount,
            },
          }),
        );
      } finally {
        closeLcmConnection(config.databasePath);
      }
    },
  });

  // Message search
  registerRoute({
    path: "/memory/search",
    auth: "plugin",
    handler: async (req, res) => {
      if (!requireToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "invalid token" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "method not allowed" }));
        return;
      }
      try {
        const body = await parseJsonBody(req);
        const query = String(body?.query ?? "").trim();
        if (!query) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "query required" }));
          return;
        }
        const mode = String(body?.mode ?? "full_text") as "full_text" | "regex";
        const limit = Math.min(200, Math.max(1, toNum(String(body?.limit ?? ""), 50)));
        const conversationIdRaw = body?.conversationId;
        const conversationId =
          conversationIdRaw != null && Number.isFinite(Number(conversationIdRaw))
            ? Number(conversationIdRaw)
            : undefined;
        const db = getLcmConnection(config.databasePath);
        const { fts5Available } = getLcmDbFeatures(db);
        const convStore = new ConversationStore(db, { fts5Available });
        try {
          const results = await convStore.searchMessages({
            query,
            mode: mode === "regex" ? "regex" : "full_text",
            conversationId,
            limit,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              query,
              mode,
              results: results.map((r) => ({
                messageId: r.messageId,
                conversationId: r.conversationId,
                role: r.role,
                snippet: r.snippet,
                createdAt: r.createdAt,
                rank: r.rank,
              })),
              count: results.length,
            }),
          );
        } finally {
          closeLcmConnection(config.databasePath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "internal error", message: msg }));
      }
    },
  });
};
