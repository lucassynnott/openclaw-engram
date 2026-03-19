import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { ExpansionOrchestrator, distillForSubagent } from "../context/expansion.js";
import type { LcmContextEngine } from "../context/engine.js";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "../context/expansion-auth.js";
import type { LcmDependencies } from "../types.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import {
  normalizeSummaryIds,
  resolveRequesterConversationScopeId,
} from "./lcm-expand-tool.delegation.js";
import {
  clearDelegatedExpansionContext,
  evaluateExpansionRecursionGuard,
  recordExpansionDelegationTelemetry,
  resolveExpansionRequestId,
  resolveNextExpansionDepth,
  stampDelegatedExpansionContext,
} from "./lcm-expansion-recursion-guard.js";

const DELEGATED_WAIT_TIMEOUT_MS = 120_000;
const GATEWAY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ANSWER_TOKENS = 2_000;
const DELEGATED_REPLY_POLL_ATTEMPTS = 5;
const DELEGATED_REPLY_POLL_DELAY_MS = 250;
const LOCAL_FALLBACK_MAX_DEPTH = 3;

const LcmExpandQuerySchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (sum_xxx). Required when query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Text query used to find summaries via grep before expansion. Required when summaryIds is not provided.",
    }),
  ),
  prompt: Type.String({
    description: "Question to answer using expanded context.",
  }),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope expansion to. If omitted, uses the current session conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly allow cross-conversation lookup. Ignored when conversationId is provided.",
    }),
  ),
  maxTokens: Type.Optional(
    Type.Number({
      description: `Maximum answer tokens to target (default: ${DEFAULT_MAX_ANSWER_TOKENS}).`,
      minimum: 1,
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description:
        "Expansion retrieval token budget across all delegated lcm_expand calls for this query.",
      minimum: 1,
    }),
  ),
});

type ExpandQueryReply = {
  answer: string;
  citedIds: string[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
};

type SummaryCandidate = {
  summaryId: string;
  conversationId: number;
  source: "explicit" | "query";
  rank?: number;
  createdAtMs?: number;
};

/**
 * Build the sub-agent task message for delegated expansion and prompt answering.
 */
function buildDelegatedExpandQueryTask(params: {
  summaryIds: string[];
  conversationId: number;
  query?: string;
  prompt: string;
  maxTokens: number;
  tokenCap: number;
  requestId: string;
  expansionDepth: number;
  originSessionKey: string;
}) {
  const seedSummaryIds = params.summaryIds.length > 0 ? params.summaryIds.join(", ") : "(none)";
  return [
    "You are an autonomous LCM retrieval navigator. Plan and execute retrieval before answering.",
    "",
    "Available tools: lcm_describe, lcm_expand, lcm_grep",
    `Conversation scope: ${params.conversationId}`,
    `Expansion token budget (total across this run): ${params.tokenCap}`,
    `Seed summary IDs: ${seedSummaryIds}`,
    params.query ? `Routing query: ${params.query}` : undefined,
    "",
    "Strategy:",
    "1. Start with `lcm_describe` on seed summaries to inspect subtree manifests and branch costs.",
    "2. If additional candidates are needed, use `lcm_grep` scoped to summaries.",
    "3. Select branches that fit remaining budget; prefer high-signal paths first.",
    "4. Call `lcm_expand` selectively (do not expand everything blindly).",
    "5. Keep includeMessages=false by default; use includeMessages=true only for specific leaf evidence.",
    `6. Stay within ${params.tokenCap} total expansion tokens across all lcm_expand calls.`,
    "",
    "User prompt to answer:",
    params.prompt,
    "",
    "Delegated expansion metadata (for tracing):",
    `- requestId: ${params.requestId}`,
    `- expansionDepth: ${params.expansionDepth}`,
    `- originSessionKey: ${params.originSessionKey}`,
    "",
    "Return ONLY JSON with this shape:",
    "{",
    '  "answer": "string",',
    '  "citedIds": ["sum_xxx"],',
    '  "expandedSummaryCount": 0,',
    '  "totalSourceTokens": 0,',
    '  "truncated": false',
    "}",
    "",
    "Rules:",
    "- In delegated context, call `lcm_expand` directly for source retrieval.",
    "- DO NOT call `lcm_expand_query` from this delegated session.",
    "- Synthesize the final answer from retrieved evidence, not assumptions.",
    `- Keep answer concise and focused (target <= ${params.maxTokens} tokens).`,
    "- citedIds must be unique summary IDs.",
    "- expandedSummaryCount should reflect how many summaries were expanded/used.",
    "- totalSourceTokens should estimate total tokens consumed from expansion calls.",
    "- truncated should indicate whether source expansion appears truncated.",
  ].join("\n");
}

/**
 * Parse the child reply; accepts plain JSON or fenced JSON.
 */
function parseDelegatedExpandQueryReply(
  rawReply: string | undefined,
  fallbackExpandedSummaryCount: number,
): ExpandQueryReply {
  const fallback: ExpandQueryReply = {
    answer: (rawReply ?? "").trim(),
    citedIds: [],
    expandedSummaryCount: fallbackExpandedSummaryCount,
    totalSourceTokens: 0,
    truncated: false,
  };

  const reply = rawReply?.trim();
  if (!reply) {
    return fallback;
  }

  const candidates: string[] = [reply];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown;
        citedIds?: unknown;
        expandedSummaryCount?: unknown;
        totalSourceTokens?: unknown;
        truncated?: unknown;
      };
      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
      const citedIds = normalizeSummaryIds(
        Array.isArray(parsed.citedIds)
          ? parsed.citedIds.filter((value): value is string => typeof value === "string")
          : undefined,
      );
      const expandedSummaryCount =
        typeof parsed.expandedSummaryCount === "number" &&
        Number.isFinite(parsed.expandedSummaryCount)
          ? Math.max(0, Math.floor(parsed.expandedSummaryCount))
          : fallbackExpandedSummaryCount;
      const totalSourceTokens =
        typeof parsed.totalSourceTokens === "number" && Number.isFinite(parsed.totalSourceTokens)
          ? Math.max(0, Math.floor(parsed.totalSourceTokens))
          : 0;
      const truncated = parsed.truncated === true;

      return {
        answer: answer || fallback.answer,
        citedIds,
        expandedSummaryCount,
        totalSourceTokens,
        truncated,
      };
    } catch {
      // Try next candidate.
    }
  }

  return fallback;
}

/**
 * Choose the dominant conversation from query-derived matches.
 * Prefers the conversation with the most matches, then the best rank, then recency.
 */
function selectDominantQueryConversationId(candidates: SummaryCandidate[]): number | undefined {
  const stats = new Map<
    number,
    { count: number; bestRank: number; latestCreatedAtMs: number }
  >();
  for (const candidate of candidates) {
    if (candidate.source !== "query") {
      continue;
    }
    const existing = stats.get(candidate.conversationId) ?? {
      count: 0,
      bestRank: Number.POSITIVE_INFINITY,
      latestCreatedAtMs: 0,
    };
    existing.count += 1;
    if (typeof candidate.rank === "number" && Number.isFinite(candidate.rank)) {
      existing.bestRank = Math.min(existing.bestRank, candidate.rank);
    }
    if (typeof candidate.createdAtMs === "number" && Number.isFinite(candidate.createdAtMs)) {
      existing.latestCreatedAtMs = Math.max(existing.latestCreatedAtMs, candidate.createdAtMs);
    }
    stats.set(candidate.conversationId, existing);
  }

  const ranked = Array.from(stats.entries()).sort((a, b) => {
    const countDelta = b[1].count - a[1].count;
    if (countDelta !== 0) {
      return countDelta;
    }
    const rankDelta = a[1].bestRank - b[1].bestRank;
    if (rankDelta !== 0) {
      return rankDelta;
    }
    const recencyDelta = b[1].latestCreatedAtMs - a[1].latestCreatedAtMs;
    if (recencyDelta !== 0) {
      return recencyDelta;
    }
    return a[0] - b[0];
  });
  return ranked[0]?.[0];
}

/**
 * Resolve a single source conversation for delegated expansion.
 */
function resolveSourceConversationId(params: {
  scopedConversationId?: number;
  allConversations: boolean;
  candidates: SummaryCandidate[];
}): number {
  if (typeof params.scopedConversationId === "number") {
    const mismatched = params.candidates
      .filter((candidate) => candidate.conversationId !== params.scopedConversationId)
      .map((candidate) => candidate.summaryId);
    if (mismatched.length > 0) {
      throw new Error(
        `Some summaryIds are outside conversation ${params.scopedConversationId}: ${mismatched.join(", ")}`,
      );
    }
    return params.scopedConversationId;
  }

  const explicitConversationIds = Array.from(
    new Set(
      params.candidates
        .filter((candidate) => candidate.source === "explicit")
        .map((candidate) => candidate.conversationId),
    ),
  );
  if (explicitConversationIds.length > 1) {
    throw new Error("Provided summaryIds span multiple conversations. Provide conversationId.");
  }
  if (explicitConversationIds.length === 1 && typeof explicitConversationIds[0] === "number") {
    return explicitConversationIds[0];
  }

  const conversationIds = Array.from(
    new Set(params.candidates.map((candidate) => candidate.conversationId)),
  );
  if (conversationIds.length === 1 && typeof conversationIds[0] === "number") {
    return conversationIds[0];
  }

  if (params.allConversations && conversationIds.length > 1) {
    const dominantConversationId = selectDominantQueryConversationId(params.candidates);
    if (typeof dominantConversationId === "number") {
      return dominantConversationId;
    }
    throw new Error(
      "Query matched summaries from multiple conversations. Provide conversationId or narrow the query.",
    );
  }

  throw new Error(
    "Unable to resolve a single conversation scope. Provide conversationId or set a narrower summary scope.",
  );
}

/**
 * Resolve summary candidates from explicit IDs and/or query matches.
 */
async function resolveSummaryCandidates(params: {
  lcm: LcmContextEngine;
  explicitSummaryIds: string[];
  query?: string;
  conversationId?: number;
}): Promise<SummaryCandidate[]> {
  const retrieval = params.lcm.getRetrieval();
  const candidates = new Map<string, SummaryCandidate>();

  for (const summaryId of params.explicitSummaryIds) {
    const described = await retrieval.describe(summaryId);
    if (!described || described.type !== "summary" || !described.summary) {
      throw new Error(`Summary not found: ${summaryId}`);
    }
    candidates.set(summaryId, {
      summaryId,
      conversationId: described.summary.conversationId,
      source: "explicit",
    });
  }

  if (params.query) {
    const grepResult = await retrieval.grep({
      query: params.query,
      mode: "full_text",
      scope: "summaries",
      conversationId: params.conversationId,
    });
    for (const summary of grepResult.summaries) {
      candidates.set(summary.summaryId, {
        summaryId: summary.summaryId,
        conversationId: summary.conversationId,
        source: "query",
        rank: typeof summary.rank === "number" ? summary.rank : undefined,
        createdAtMs:
          summary.createdAt instanceof Date ? summary.createdAt.getTime() : Date.now(),
      });
    }
  }

  return Array.from(candidates.values());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCompletionText(content: unknown): string {
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

async function readDelegatedAssistantReply(params: {
  deps: Pick<LcmDependencies, "callGateway" | "readLatestAssistantReply">;
  childSessionKey: string;
}): Promise<string | undefined> {
  for (let attempt = 0; attempt < DELEGATED_REPLY_POLL_ATTEMPTS; attempt += 1) {
    const replyPayload = (await params.deps.callGateway({
      method: "sessions.get",
      params: { key: params.childSessionKey, limit: 80 },
      timeoutMs: GATEWAY_TIMEOUT_MS,
    })) as { messages?: unknown[] };
    const reply = params.deps.readLatestAssistantReply(
      Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
    );
    if (reply?.trim()) {
      return reply.trim();
    }
    if (attempt < DELEGATED_REPLY_POLL_ATTEMPTS - 1) {
      await sleep(DELEGATED_REPLY_POLL_DELAY_MS * (attempt + 1));
    }
  }
  return undefined;
}

function buildLocalFallbackAnswer(params: {
  delegatedError?: string;
  distilledContext: string;
}): string {
  const context = params.distilledContext.trim();
  if (!context) {
    return params.delegatedError
      ? `Delegated expansion failed: ${params.delegatedError}`
      : "Delegated expansion failed and no local context could be expanded.";
  }
  if (!params.delegatedError) {
    return context;
  }
  return [`Delegated expansion failed: ${params.delegatedError}`, "", context].join("\n");
}

async function runLocalExpandQueryFallback(params: {
  deps: Pick<LcmDependencies, "complete" | "resolveModel" | "getApiKey" | "log">;
  lcm: LcmContextEngine;
  summaryIds: string[];
  sourceConversationId: number;
  prompt: string;
  maxTokens: number;
  expansionTokenCap: number;
  delegatedError?: string;
}): Promise<ExpandQueryReply> {
  const orchestrator = new ExpansionOrchestrator(params.lcm.getRetrieval());
  const expansionResult = await orchestrator.expand({
    summaryIds: params.summaryIds,
    conversationId: params.sourceConversationId,
    maxDepth: LOCAL_FALLBACK_MAX_DEPTH,
    tokenCap: params.expansionTokenCap,
    includeMessages: false,
  });

  const distilledContext = distillForSubagent(expansionResult);
  const fallback: ExpandQueryReply = {
    answer: buildLocalFallbackAnswer({
      delegatedError: params.delegatedError,
      distilledContext,
    }),
    citedIds: expansionResult.citedIds,
    expandedSummaryCount: expansionResult.expansions.length,
    totalSourceTokens: expansionResult.totalTokens,
    truncated: expansionResult.truncated,
  };

  if (!distilledContext.trim()) {
    return fallback;
  }

  try {
    const { provider, model } = params.deps.resolveModel();
    const apiKey = await params.deps.getApiKey(provider, model);
    const completion = await params.deps.complete({
      provider,
      model,
      apiKey,
      system: [
        "You answer questions using locally expanded LCM context.",
        "Use only the supplied evidence. If it is insufficient, say so briefly.",
        "Return ONLY JSON.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            "Question:",
            params.prompt,
            "",
            "Expanded context:",
            distilledContext,
            "",
            "Return ONLY JSON with this shape:",
            "{",
            '  "answer": "string",',
            '  "citedIds": ["sum_xxx"],',
            `  "expandedSummaryCount": ${expansionResult.expansions.length},`,
            `  "totalSourceTokens": ${expansionResult.totalTokens},`,
            `  "truncated": ${expansionResult.truncated ? "true" : "false"}`,
            "}",
          ].join("\n"),
        },
      ],
      maxTokens: params.maxTokens,
      temperature: 0.1,
      reasoning: "low",
    });
    const rawReply = extractCompletionText(completion?.content);
    if (!rawReply) {
      return fallback;
    }
    const parsed = parseDelegatedExpandQueryReply(rawReply, expansionResult.expansions.length);
    return {
      answer: parsed.answer || fallback.answer,
      citedIds: parsed.citedIds.length > 0 ? parsed.citedIds : fallback.citedIds,
      expandedSummaryCount: Math.max(parsed.expandedSummaryCount, fallback.expandedSummaryCount),
      totalSourceTokens:
        parsed.totalSourceTokens > 0 ? parsed.totalSourceTokens : fallback.totalSourceTokens,
      truncated: parsed.truncated || fallback.truncated,
    };
  } catch (error) {
    params.deps.log.warn(
      `[engram] lcm_expand_query local fallback completion failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fallback;
  }
}

export function createLcmExpandQueryTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  /** Session id used for LCM conversation scoping. */
  sessionId?: string;
  /** Requester agent session key used for delegated child session/auth scoping. */
  requesterSessionKey?: string;
  /** Session key for scope fallback when sessionId is unavailable. */
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Answer a focused question using delegated LCM expansion. " +
      "Find candidate summaries (by IDs or query), expand them in a delegated sub-agent, " +
      "and return a compact prompt-focused answer with cited summary IDs.",
    parameters: LcmExpandQuerySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const explicitSummaryIds = normalizeSummaryIds(p.summaryIds as string[] | undefined);
      const query = typeof p.query === "string" ? p.query.trim() : "";
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      const requestedMaxTokens =
        typeof p.maxTokens === "number" ? Math.trunc(p.maxTokens) : undefined;
      const maxTokens =
        typeof requestedMaxTokens === "number" && Number.isFinite(requestedMaxTokens)
          ? Math.max(1, requestedMaxTokens)
          : DEFAULT_MAX_ANSWER_TOKENS;
      const requestedTokenCap = typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
      const expansionTokenCap =
        typeof requestedTokenCap === "number" && Number.isFinite(requestedTokenCap)
          ? Math.max(1, requestedTokenCap)
          : Math.max(1, Math.trunc(input.deps.config.maxExpandTokens));

      if (!prompt) {
        return jsonResult({
          error: "prompt is required.",
        });
      }

      if (explicitSummaryIds.length === 0 && !query) {
        return jsonResult({
          error: "Either summaryIds or query must be provided.",
        });
      }

      const callerSessionKey =
        (typeof input.requesterSessionKey === "string"
          ? input.requesterSessionKey
          : input.sessionId
        )?.trim() ?? "";
      const requestId = resolveExpansionRequestId(callerSessionKey);
      const recursionCheck = evaluateExpansionRecursionGuard({
        sessionKey: callerSessionKey,
        requestId,
      });
      recordExpansionDelegationTelemetry({
        deps: input.deps,
        component: "lcm_expand_query",
        event: "start",
        requestId,
        sessionKey: callerSessionKey,
        expansionDepth: recursionCheck.expansionDepth,
        originSessionKey: recursionCheck.originSessionKey,
      });
      if (recursionCheck.blocked) {
        recordExpansionDelegationTelemetry({
          deps: input.deps,
          component: "lcm_expand_query",
          event: "block",
          requestId,
          sessionKey: callerSessionKey,
          expansionDepth: recursionCheck.expansionDepth,
          originSessionKey: recursionCheck.originSessionKey,
          reason: recursionCheck.reason,
        });
        return jsonResult({
          errorCode: recursionCheck.code,
          error: recursionCheck.message,
          requestId: recursionCheck.requestId,
          expansionDepth: recursionCheck.expansionDepth,
          originSessionKey: recursionCheck.originSessionKey,
          reason: recursionCheck.reason,
        });
      }

      const conversationScope = await resolveLcmConversationScope({
        lcm: input.lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      let scopedConversationId = conversationScope.conversationId;
      if (
        !conversationScope.allConversations &&
        scopedConversationId == null &&
        callerSessionKey
      ) {
        scopedConversationId = await resolveRequesterConversationScopeId({
          deps: input.deps,
          requesterSessionKey: callerSessionKey,
          lcm: input.lcm,
        });
      }

      if (!conversationScope.allConversations && scopedConversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      let childSessionKey = "";
      let grantCreated = false;

      try {
        const candidates = await resolveSummaryCandidates({
          lcm: input.lcm,
          explicitSummaryIds,
          query: query || undefined,
          conversationId: scopedConversationId,
        });

        if (candidates.length === 0) {
          if (typeof scopedConversationId !== "number") {
            return jsonResult({
              error: "No matching summaries found.",
            });
          }
          return jsonResult({
            answer: "No matching summaries found for this scope.",
            citedIds: [],
            sourceConversationId: scopedConversationId,
            expandedSummaryCount: 0,
            totalSourceTokens: 0,
            truncated: false,
          });
        }

        const sourceConversationId = resolveSourceConversationId({
          scopedConversationId,
          allConversations: conversationScope.allConversations,
          candidates,
        });
        const summaryIds = normalizeSummaryIds(
          candidates
            .filter((candidate) => candidate.conversationId === sourceConversationId)
            .map((candidate) => candidate.summaryId),
        );

        if (summaryIds.length === 0) {
          return jsonResult({
            error: "No summaryIds available after applying conversation scope.",
          });
        }

        const finishWithLocalFallback = async (delegatedError?: string) => {
          input.deps.log.warn(
            `[engram] lcm_expand_query delegated path failed; using local fallback: ${
              delegatedError || "unknown delegated error"
            }`,
          );
          const fallback = await runLocalExpandQueryFallback({
            deps: input.deps,
            lcm: input.lcm,
            summaryIds,
            sourceConversationId,
            prompt,
            maxTokens,
            expansionTokenCap,
            delegatedError,
          });
          return jsonResult({
            answer: fallback.answer,
            citedIds: fallback.citedIds,
            sourceConversationId,
            expandedSummaryCount: fallback.expandedSummaryCount,
            totalSourceTokens: fallback.totalSourceTokens,
            truncated: fallback.truncated,
            fallbackUsed: true,
            delegatedError,
          });
        };

        const requesterAgentId = input.deps.normalizeAgentId(
          input.deps.parseAgentSessionKey(callerSessionKey)?.agentId,
        );
        childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
        const childExpansionDepth = resolveNextExpansionDepth(callerSessionKey);
        const originSessionKey = recursionCheck.originSessionKey || callerSessionKey || "main";

        createDelegatedExpansionGrant({
          delegatedSessionKey: childSessionKey,
          issuerSessionId: callerSessionKey || "main",
          allowedConversationIds: [sourceConversationId],
          tokenCap: expansionTokenCap,
          ttlMs: DELEGATED_WAIT_TIMEOUT_MS + 30_000,
        });
        stampDelegatedExpansionContext({
          sessionKey: childSessionKey,
          requestId,
          expansionDepth: childExpansionDepth,
          originSessionKey,
          stampedBy: "lcm_expand_query",
        });
        grantCreated = true;

        const task = buildDelegatedExpandQueryTask({
          summaryIds,
          conversationId: sourceConversationId,
          query: query || undefined,
          prompt,
          maxTokens,
          tokenCap: expansionTokenCap,
          requestId,
          expansionDepth: childExpansionDepth,
          originSessionKey,
        });

        const childIdem = crypto.randomUUID();
        const response = (await input.deps.callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            deliver: false,
            lane: input.deps.agentLaneSubagent,
            idempotencyKey: childIdem,
            extraSystemPrompt: input.deps.buildSubagentSystemPrompt({
              depth: 1,
              maxDepth: 8,
              taskSummary: "Run lcm_expand and return prompt-focused JSON answer",
            }),
          },
          timeoutMs: GATEWAY_TIMEOUT_MS,
        })) as { runId?: string };

        const runId = typeof response?.runId === "string" ? response.runId.trim() : "";
        if (!runId) {
          return await finishWithLocalFallback("Delegated expansion did not return a runId.");
        }

        const wait = (await input.deps.callGateway({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs: DELEGATED_WAIT_TIMEOUT_MS,
          },
          timeoutMs: DELEGATED_WAIT_TIMEOUT_MS,
        })) as { status?: string; error?: string };
        const status = typeof wait?.status === "string" ? wait.status : "error";
        if (status === "timeout") {
          recordExpansionDelegationTelemetry({
            deps: input.deps,
            component: "lcm_expand_query",
            event: "timeout",
            requestId,
            sessionKey: callerSessionKey,
            expansionDepth: childExpansionDepth,
            originSessionKey,
            runId,
          });
          return await finishWithLocalFallback(
            "lcm_expand_query timed out waiting for delegated expansion (120s).",
          );
        }
        if (status !== "ok") {
          return await finishWithLocalFallback(
            typeof wait?.error === "string" && wait.error.trim()
              ? wait.error
              : "Delegated expansion query failed.",
          );
        }

        const reply = await readDelegatedAssistantReply({
          deps: input.deps,
          childSessionKey,
        });
        if (!reply) {
          return await finishWithLocalFallback(
            "Delegated expansion completed without a readable assistant reply.",
          );
        }
        const parsed = parseDelegatedExpandQueryReply(reply, summaryIds.length);
        if (!parsed.answer.trim()) {
          return await finishWithLocalFallback("Delegated expansion returned an empty answer.");
        }
        recordExpansionDelegationTelemetry({
          deps: input.deps,
          component: "lcm_expand_query",
          event: "success",
          requestId,
          sessionKey: callerSessionKey,
          expansionDepth: childExpansionDepth,
          originSessionKey,
          runId,
        });

        return jsonResult({
          answer: parsed.answer,
          citedIds: parsed.citedIds,
          sourceConversationId,
          expandedSummaryCount: parsed.expandedSummaryCount,
          totalSourceTokens: parsed.totalSourceTokens,
          truncated: parsed.truncated,
        });
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (childSessionKey) {
          try {
            await input.deps.callGateway({
              method: "sessions.delete",
              params: { key: childSessionKey, deleteTranscript: true },
              timeoutMs: GATEWAY_TIMEOUT_MS,
            });
          } catch {
            // Cleanup is best-effort.
          }
        }
        if (grantCreated && childSessionKey) {
          revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
        }
        if (childSessionKey) {
          clearDelegatedExpansionContext(childSessionKey);
        }
      }
    },
  };
}
