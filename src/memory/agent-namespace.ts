import type { LcmDependencies } from "../types.js";

export const DEFAULT_MEMORY_NAMESPACE = "default";

export function normalizeMemoryNamespace(namespace?: string | null): string {
  const trimmed = typeof namespace === "string" ? namespace.trim() : "";
  if (!trimmed || trimmed === "main" || trimmed === DEFAULT_MEMORY_NAMESPACE) {
    return DEFAULT_MEMORY_NAMESPACE;
  }
  return trimmed;
}

export function resolveMemoryNamespaceFromSessionContext(input: {
  deps?: Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">;
  sessionKey?: string;
}): string {
  const sessionKey = input.sessionKey?.trim();
  if (!sessionKey || !input.deps) {
    return DEFAULT_MEMORY_NAMESPACE;
  }

  const parsed = input.deps.parseAgentSessionKey(sessionKey);
  if (!parsed?.agentId) {
    return DEFAULT_MEMORY_NAMESPACE;
  }

  return normalizeMemoryNamespace(input.deps.normalizeAgentId(parsed.agentId));
}

export function resolveSourceAgentIdFromSessionContext(input: {
  deps?: Pick<LcmDependencies, "parseAgentSessionKey" | "normalizeAgentId">;
  sessionKey?: string;
}): string {
  const sessionKey = input.sessionKey?.trim();
  if (!sessionKey || !input.deps) {
    return DEFAULT_MEMORY_NAMESPACE;
  }

  const parsed = input.deps.parseAgentSessionKey(sessionKey);
  if (!parsed?.agentId) {
    return DEFAULT_MEMORY_NAMESPACE;
  }

  const normalized = input.deps.normalizeAgentId(parsed.agentId)?.trim();
  return normalized || DEFAULT_MEMORY_NAMESPACE;
}
