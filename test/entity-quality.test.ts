/**
 * Entity extraction quality tests.
 *
 * Validates that the entity-quality-filter correctly rejects common English
 * words from being classified as person entities, while still allowing
 * legitimate proper names and explicitly tagged entities.
 */

import { describe, expect, it } from "vitest";
import {
  isCommonEnglishWord,
  isLikelyEntityName,
} from "../src/entity/entity-quality-filter.js";

// ---------------------------------------------------------------------------
// isCommonEnglishWord
// ---------------------------------------------------------------------------

describe("isCommonEnglishWord", () => {
  it("returns true for common single English words", () => {
    // Words verified to be in COMMON_ENGLISH_WORDS
    const common = [
      "building", "products", "home", "sync", "update", "system",
      "config", "pipeline", "deploy", "review", "migration", "run",
      "data", "model", "search", "memory", "error", "working",
      "session", "context", "output", "query", "store",
      "test", "tool", "user", "value", "version",
    ];
    for (const word of common) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns true for verbs, adjectives, and adverbs", () => {
    const words = [
      "create", "remove", "achieve", "accept", "decide", "deliver",
      "active", "available", "complete", "complex", "current", "easy",
      "fast", "general", "important", "large", "simple", "strong",
    ];
    for (const word of words) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns true for tech and programming terms", () => {
    const tech = [
      "api", "backend", "cache", "docker", "endpoint", "git",
      "http", "json", "linux", "node", "postgres", "redis",
      "sql", "typescript", "webhook", "yaml",
    ];
    for (const word of tech) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns true for business/marketing jargon", () => {
    const biz = [
      "analytics", "benchmark", "brand", "churn", "funnel",
      "kpi", "margin", "pipeline", "roi", "strategy",
    ];
    for (const word of biz) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns true for calendar and time words", () => {
    const time = [
      "monday", "friday", "january", "december",
      "today", "yesterday", "morning", "evening",
      "hour", "week", "month", "year", "daily", "weekly",
    ];
    for (const word of time) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns true for AI product names that are not person names", () => {
    const products = [
      "claude", "gemini", "copilot", "chatgpt", "midjourney",
      "anthropic", "mistral", "llama", "cursor",
    ];
    for (const word of products) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns true for garbage words that appeared as false person entities", () => {
    const garbage = [
      "building", "products", "heartbeat", "engram", "openclaw",
      "episodic", "dashboard", "codex", "slack", "obsidian",
    ];
    for (const word of garbage) {
      expect(isCommonEnglishWord(word), `"${word}" should be common`).toBe(true);
    }
  });

  it("returns false for actual names not in the dictionary", () => {
    // These are plausible single-token proper names not in the common word list
    const names = [
      "synnott", "takemura", "vektor",
    ];
    for (const name of names) {
      expect(isCommonEnglishWord(name), `"${name}" should NOT be common`).toBe(false);
    }
  });

  it("normalizes input to lowercase before checking", () => {
    expect(isCommonEnglishWord("Building")).toBe(true);
    expect(isCommonEnglishWord("PRODUCTS")).toBe(true);
    expect(isCommonEnglishWord("Home")).toBe(true);
    expect(isCommonEnglishWord("SYNC")).toBe(true);
  });

  it("returns false for empty or whitespace-only input", () => {
    expect(isCommonEnglishWord("")).toBe(false);
    expect(isCommonEnglishWord("   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLikelyEntityName
// ---------------------------------------------------------------------------

describe("isLikelyEntityName", () => {
  it("rejects single common English words as entity names", () => {
    const rejectList = [
      "building", "products", "home", "sync", "system",
      "deploy", "config", "model", "search", "heartbeat",
      "pipeline", "update", "session", "memory", "dashboard",
    ];
    for (const word of rejectList) {
      expect(isLikelyEntityName(word), `"${word}" should be rejected`).toBe(false);
    }
  });

  it("accepts multi-word proper names where at least one token is not common", () => {
    expect(isLikelyEntityName("Lucas Synnott")).toBe(true);
    expect(isLikelyEntityName("Johnny Silverhand")).toBe(true);
    expect(isLikelyEntityName("Viktor Vektor")).toBe(true);
    expect(isLikelyEntityName("Takemura Goro")).toBe(true);
  });

  it("rejects multi-word strings where ALL tokens are common words", () => {
    expect(isLikelyEntityName("daily update")).toBe(false);
    expect(isLikelyEntityName("system config")).toBe(false);
    // Both "applied" and "leverage" are common English words
    expect(isLikelyEntityName("Applied Leverage")).toBe(false);
  });

  it("accepts multi-word strings where at least one token is not common", () => {
    // "viktor" is not a common English word, so this passes
    expect(isLikelyEntityName("Engram Viktor")).toBe(true);
    expect(isLikelyEntityName("Takemura Goro")).toBe(true);
  });

  it("accepts single-word entity names not in the common word list", () => {
    // These are plausible entity names not found in common English vocabulary
    expect(isLikelyEntityName("Synnott")).toBe(true);
    expect(isLikelyEntityName("Takemura")).toBe(true);
  });

  it("rejects very short tokens (< 3 chars)", () => {
    expect(isLikelyEntityName("ab")).toBe(false);
    expect(isLikelyEntityName("x")).toBe(false);
    expect(isLikelyEntityName("AI")).toBe(false);
  });

  it("rejects pure numeric tokens", () => {
    expect(isLikelyEntityName("12345")).toBe(false);
    expect(isLikelyEntityName("42")).toBe(false);
  });

  it("rejects empty or whitespace-only input", () => {
    expect(isLikelyEntityName("")).toBe(false);
    expect(isLikelyEntityName("   ")).toBe(false);
  });

  it("normalizes case for checking", () => {
    expect(isLikelyEntityName("BUILDING")).toBe(false);
    expect(isLikelyEntityName("Products")).toBe(false);
    expect(isLikelyEntityName("HOME")).toBe(false);
  });
});
