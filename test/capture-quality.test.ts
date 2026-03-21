/**
 * Capture quality tests.
 *
 * Validates that the junk detection in memory-utils correctly rejects
 * system prompt content, credentials, overly long content, and tool output
 * while passing normal user memories through.
 */

import { describe, expect, it } from "vitest";
import {
  CONTENT_LENGTH_HARD_MAX,
  detectJunk,
  detectSystemPromptArtifact,
} from "../src/memory/memory-utils.js";

// ---------------------------------------------------------------------------
// System prompt / wrapper detection
// ---------------------------------------------------------------------------

describe("detectJunk — system prompt content", () => {
  it("detects <composio> wrapper tags as junk", () => {
    const result = detectJunk("<composio>Some embedded system content</composio>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("system_prompt_tag");
  });

  it("detects <system> wrapper tags as junk", () => {
    const result = detectJunk("<system>You are a helpful AI assistant.</system>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });

  it("detects <context> wrapper tags as junk", () => {
    const result = detectJunk("<context>Current conversation context...</context>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });

  it("detects <tool_output> wrapper tags as junk", () => {
    const result = detectJunk("<tool_output>{ \"result\": 42 }</tool_output>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });

  it("detects <working_memory> wrapper tags as junk", () => {
    const result = detectJunk("<working_memory>Some state data here</working_memory>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });

  it("detects <recalled_memories> wrapper tags as junk", () => {
    const result = detectJunk("<recalled_memories>Previously stored facts...</recalled_memories>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });

  it("detects <agent_profile> wrapper tags as junk", () => {
    const result = detectJunk("<agent_profile>Agent identity data</agent_profile>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });

  it("detects <gigabrain-context> wrapper tags as junk", () => {
    const result = detectJunk("<gigabrain-context>Injected context</gigabrain-context>");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_wrapper");
  });
});

// ---------------------------------------------------------------------------
// Credential / secret detection
// ---------------------------------------------------------------------------

describe("detectJunk — credential patterns", () => {
  it("detects API_KEY= patterns as junk", () => {
    const result = detectJunk("The setting is API_KEY=sk-1234567890abcdef");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects _API_KEY= patterns as junk", () => {
    const result = detectJunk("Use OPENAI_API_KEY=sk-proj-abc123 in the config");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects SECRET= patterns as junk", () => {
    const result = detectJunk("Set the value SECRET=mysupersecretvalue42");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects PASSWORD= patterns as junk", () => {
    const result = detectJunk("The connection string has PASSWORD=hunter2 inside");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });
});

// ---------------------------------------------------------------------------
// Normal memories pass through
// ---------------------------------------------------------------------------

describe("detectJunk — normal memories", () => {
  it("passes normal user preference memories", () => {
    const result = detectJunk("Lucas prefers dark mode in all his editors");
    expect(result.junk).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("passes normal factual memories", () => {
    const result = detectJunk("The engram plugin stores durable memory in SQLite databases");
    expect(result.junk).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("passes decision memories", () => {
    const result = detectJunk("We decided to use Vitest for the test runner across all projects");
    expect(result.junk).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("passes entity memories", () => {
    const result = detectJunk("Jordan is Lucas's partner and they live together in Vienna");
    expect(result.junk).toBe(false);
    expect(result.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Content length checks
// ---------------------------------------------------------------------------

describe("detectJunk — content length", () => {
  it("rejects very short content (< 12 chars)", () => {
    const result = detectJunk("too short");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("too_short");
  });

  it("rejects empty content", () => {
    const result = detectJunk("");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("empty");
  });

  it("rejects whitespace-only content", () => {
    const result = detectJunk("     ");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// Tool output / ops noise detection
// ---------------------------------------------------------------------------

describe("detectJunk — tool output and ops noise", () => {
  it("detects Read HEARTBEAT pattern as junk", () => {
    const result = detectJunk("Read HEARTBEAT from session 42 at 2026-03-18T12:00:00Z");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects session start pattern as junk", () => {
    const result = detectJunk("A new session was started for agent main at 12:00");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects System: prefix as junk", () => {
    const result = detectJunk("System: initializing context engine for namespace default");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects smoke test pattern as junk", () => {
    const result = detectJunk("Running smoke test for the new deployment pipeline");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects Post-Compaction Audit as junk", () => {
    const result = detectJunk("Post-Compaction Audit: 42 memories processed, 3 archived");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects Subagent Context marker as junk", () => {
    const result = detectJunk("[Subagent Context] depth=2 agent=altcun namespace=default");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects Exec completed pattern as junk", () => {
    const result = detectJunk("Exec completed (exit_code=0, duration=1234ms, output=success)");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects compaction audit pattern as junk", () => {
    const result = detectJunk("Compaction audit results for session abc-123: all clear");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });

  it("detects template placeholder as junk", () => {
    const result = detectJunk("Template placeholder for section header goes here");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("junk_pattern");
  });
});

// ---------------------------------------------------------------------------
// Metadata noise detection
// ---------------------------------------------------------------------------

describe("detectJunk — metadata noise", () => {
  it("detects bracket-only content as metadata noise", () => {
    const result = detectJunk("[some_metadata_tag]");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("metadata_noise");
  });

  it("detects memory ID-only content as metadata noise", () => {
    const result = detectJunk("m:abcdef12-3456-7890-abcd-ef1234567890");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("metadata_noise");
  });

  it("detects bare key= content as metadata noise", () => {
    const result = detectJunk("SOME_CONFIG_KEY=");
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("metadata_noise");
  });

  it("detects todo/tbd/none as metadata noise", () => {
    expect(detectJunk("todo").junk).toBe(true);
    expect(detectJunk("TBD").junk).toBe(true);
    expect(detectJunk("n/a").junk).toBe(true);
    expect(detectJunk("none").junk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Very long content (> CONTENT_LENGTH_HARD_MAX = 2000 chars)
// ---------------------------------------------------------------------------

describe("detectJunk — very long content", () => {
  it("flags content over 2000 chars as too long", () => {
    const longContent = "This is a very long memory that should be rejected. ".repeat(50);
    expect(longContent.length).toBeGreaterThan(CONTENT_LENGTH_HARD_MAX);
    const result = detectJunk(longContent);
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("content_too_long");
  });

  it("passes content just under 2000 chars", () => {
    // Build a string that is close to but under the hard max
    const content = "A".repeat(1999);
    expect(content.length).toBeLessThanOrEqual(CONTENT_LENGTH_HARD_MAX);
    const result = detectJunk(content);
    // This will be metadata_noise (all same char) but we verify it's not content_too_long
    expect(result.reason).not.toBe("content_too_long");
  });
});

// ---------------------------------------------------------------------------
// Tool output JSON detection (via detectSystemPromptArtifact)
// ---------------------------------------------------------------------------

describe("detectJunk — tool output JSON", () => {
  it("detects tool_call_id JSON as junk", () => {
    const toolOutput = '{"tool_call_id": "call_abc123", "result": "success", "data": {"key": "value"}}';
    const result = detectJunk(toolOutput);
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("tool_output_json");
  });

  it("detects function/parameters JSON as junk", () => {
    const funcCall = '{"function": {"name": "search", "parameters": {"query": "test"}}}';
    const result = detectJunk(funcCall);
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("tool_output_json");
  });

  it("detects type=function JSON as junk", () => {
    const funcDef = '{"type": "function", "function": {"name": "memory_add"}}';
    const result = detectJunk(funcDef);
    expect(result.junk).toBe(true);
    expect(result.reason).toBe("tool_output_json");
  });
});

// ---------------------------------------------------------------------------
// detectSystemPromptArtifact direct tests
// ---------------------------------------------------------------------------

describe("detectSystemPromptArtifact", () => {
  it("returns system_prompt_tag for composio tags", () => {
    expect(detectSystemPromptArtifact("<composio>content</composio>")).toBe("system_prompt_tag");
  });

  it("returns system_prompt_tag for system-reminder tags", () => {
    expect(detectSystemPromptArtifact("<system-reminder>Do this</system-reminder>")).toBe("system_prompt_tag");
  });

  it("returns instruction_language for 'You are a ... assistant' pattern", () => {
    expect(detectSystemPromptArtifact("You are a helpful AI assistant designed to answer questions")).toBe("instruction_language");
  });

  it("returns instruction_language for IMPORTANT: Never pattern", () => {
    expect(detectSystemPromptArtifact("IMPORTANT: Never share user data with third parties")).toBe("instruction_language");
  });

  it("returns credential_block for API key patterns", () => {
    expect(detectSystemPromptArtifact("Use sk-1234567890abcdef1234567890abcdef for auth")).toBe("credential_block");
  });

  it("returns credential_block for Bearer tokens", () => {
    expect(detectSystemPromptArtifact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123")).toBe("credential_block");
  });

  it("returns tool_output_json for function call JSON", () => {
    expect(detectSystemPromptArtifact('{"tool_call_id": "call_abc"}')).toBe("tool_output_json");
  });

  it("returns null for normal content", () => {
    expect(detectSystemPromptArtifact("Lucas prefers dark mode in all his editors")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// All injection patterns are caught
// ---------------------------------------------------------------------------

describe("detectJunk — comprehensive injection pattern check", () => {
  it("catches all JUNK_PATTERNS against crafted inputs", () => {
    const injections = [
      "Read HEARTBEAT from the last session checkpoint",
      "A new session was started by the coordinator agent",
      "System: performing routine health check on the gateway",
      "Set the value API_KEY=leaked-credential-here-oh-no",
      "Add OPENAI_API_KEY=sk-proj-abcdefg to the environment",
      "Config has SECRET=super_secret_token for the backend",
      "Auth credential PASSWORD=p4ssw0rd! found in plaintext",
      "Template placeholder for the quarterly report section",
      "Running smoke test to verify the deployment is healthy",
      "Post-Compaction Audit: verifying memory integrity after GC",
      "[Subagent Context] entering nested agent delegation flow",
      "Exec completed (status=0) after running the pipeline step",
      "[System Message] [sessionId: abc-123] agent started at noon",
      "compaction audit completed for all active conversations now",
      "subagent alt depth 3/5 processing research delegation task",
    ];

    for (const input of injections) {
      const result = detectJunk(input);
      expect(result.junk, `Should detect junk: "${input.slice(0, 60)}..."`).toBe(true);
    }
  });
});
