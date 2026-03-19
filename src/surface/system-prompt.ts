/**
 * System prompt injection for the Engram unified memory plugin.
 *
 * This module generates the <engram-tools> block injected into agent system
 * prompts to instruct agents on when and how to use the unified tool surface.
 */

export interface SystemPromptOptions {
  /** Whether the LCM context engine is active. Default: true */
  lcmEnabled?: boolean;
  /** Whether long-term memory (Gigabrain layer) is active. Default: true */
  memoryEnabled?: boolean;
  /** Whether episodic/temporal tools are available. Default: true */
  episodicEnabled?: boolean;
  /** Whether alignment tools are available (P3 feature). Default: false */
  alignmentEnabled?: boolean;
  /** Custom agent namespace for multi-agent setups. Default: "default" */
  namespace?: string;
}

/**
 * Generate the Engram system prompt block.
 * Insert this into the agent's system prompt at session start.
 */
export function generateEngramSystemPrompt(opts: SystemPromptOptions = {}): string {
  const {
    lcmEnabled = true,
    memoryEnabled = true,
    episodicEnabled = true,
    alignmentEnabled = false,
  } = opts;

  const sections: string[] = [];

  sections.push(`<engram-tools>
You have access to Engram — a unified memory and context engine. Use these tools to persist knowledge, recall context, and navigate conversation history.`);

  if (lcmEnabled) {
    sections.push(`
## Context Tools (Conversation History Navigation)

These tools search and retrieve content that has been compacted out of active context.

**Escalation pattern:** grep → describe → expand → query

| Tool | When to use |
|------|-------------|
| \`context_grep\` | Find specific content by keyword/regex. Start here. |
| \`context_describe\` | Read a summary's full content (cheap, no sub-agent). |
| \`context_expand\` | Expand a summary subtree to recover compressed detail. |
| \`context_query\` | Expand context and answer a focused question. Use for exact values (error messages, config, commands). |

**Rule:** Start with \`context_grep\`. Escalate only when the snippet isn't enough. \`context_query\` spawns a bounded sub-agent (~120s) — don't ration it for detail-critical questions.

**Legacy names \`lcm_grep\`, \`lcm_describe\`, \`lcm_expand\`, \`lcm_expand_query\` are also available and work identically.**`);
  }

  if (memoryEnabled) {
    sections.push(`
## Memory Tools (Long-Term Storage)

These tools persist and recall knowledge across sessions.

| Tool | When to use |
|------|-------------|
| \`memory_add\` | Store a fact, preference, decision, or entity. Use kinds: USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT. |
| \`memory_correct\` | Replace an existing memory with a corrected version and supersede the old one. |
| \`memory_retract\` | Mark a memory as wrong/superseded so it stops surfacing in normal recall. |
| \`memory_recall\` | Load top-k memories by confidence at session start. Use to prime context with user background. |
| \`memory_search\` | Keyword/semantic search for what is known about a topic, person, or project. |
| \`memory_query\` | Strategy-aware recall for timelines, entity briefs, and targeted memory questions. |
| \`memory_world\` | Surface the entity model — people, projects, organizations known to the system. |
| \`memory_get\` | Fetch a memory, episode, summary, file, or entity by ID. |
| \`entity_get\` | Fetch a rich entity profile with beliefs, episodes, and syntheses. |
| \`entity_merge\` | Merge duplicate entities into a canonical entity when the world model has split the same person/project across aliases. |
| \`vault_query\` | Query imported StingerVault data or the vault mirror by category and text. |
| \`ops_status\` / \`engram_status\` | Single-call Engram health dashboard across memory, LCM, vault, and alignment. |

**Compatibility aliases:** \`memory_get_entity\`, \`memory_get_episode\`, and \`memory_namespace_status\` remain available for older prompts and tooling.

**Memory capture rules:**
- Always call \`memory_add\` when the user expresses a preference, makes a decision, or shares a personal fact.
- If the user says a memory is wrong or outdated, use \`memory_correct\` or \`memory_retract\` instead of leaving the stale memory active.
- Use \`memory_add\` with \`triggerPattern\` for standing orders or proactive reminders that should surface when future prompts match.
- Use \`memory_recall\` at the start of new sessions before responding to greetings or context-dependent questions.
- Do NOT capture: system noise, tool outputs, transient session state, credentials, or API keys.`);
  }

  if (episodicEnabled) {
    sections.push(`
## Episodic / System Tools

| Tool | When to use |
|------|-------------|
| \`memory_ingest_now\` | Trigger immediate background ingestion of session activity. |
| \`memory_job_status\` | Check background ingestion job status. |
| \`memory_list_agents\` | List registered agent namespaces. |`);
  }

  if (alignmentEnabled) {
    sections.push(`
## Alignment Tools (Gradient)

| Tool | When to use |
|------|-------------|
| \`gradient_score\` | Evaluate a response against the alignment profile. |
| \`alignment_status\` | Check alignment engine health and current mode. |
| \`alignment_check\` | Evaluate a text or action for alignment before executing. |
| \`alignment_drift\` | Check rolling alignment drift statistics. |`);
  }

  sections.push(`
</engram-tools>`);

  return sections.join("\n");
}

/**
 * Minimal injection for agents with limited context budgets.
 * Lists tool names only without usage guidance.
 */
export function generateEngramToolList(opts: SystemPromptOptions = {}): string {
  const {
    lcmEnabled = true,
    memoryEnabled = true,
    episodicEnabled = true,
    alignmentEnabled = false,
  } = opts;

  const tools: string[] = [];

  if (lcmEnabled) {
    tools.push(
      "context_grep",
      "context_describe",
      "context_expand",
      "context_query",
      // legacy names
      "lcm_grep",
      "lcm_describe",
      "lcm_expand",
      "lcm_expand_query",
    );
  }

  if (memoryEnabled) {
    tools.push(
      "memory_add",
      "memory_recall",
      "memory_search",
      "memory_query",
      "memory_world",
      "memory_get",
      "entity_get",
      "entity_merge",
      "vault_query",
      "ops_status",
      "memory_get_entity",
      "memory_get_episode",
      "memory_namespace_status",
    );
  }

  if (episodicEnabled) {
    tools.push("memory_ingest_now", "memory_job_status", "memory_list_agents");
  }

  if (alignmentEnabled) {
    tools.push("gradient_score", "alignment_status", "alignment_check", "alignment_drift");
  }

  return `<engram-tools>\nAvailable memory tools: ${tools.join(", ")}\n</engram-tools>`;
}
