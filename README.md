<p align="center">
  <img src="assets/engram-logo.jpg" alt="Engram" width="200" />
</p>

<h1 align="center">Engram</h1>

<p align="center">
  <strong>Cyberpunk-grade memory for your OpenClaw agent — never forget, always recall.</strong>
</p>

---

Unified memory and context engine plugin for [OpenClaw](https://github.com/openclaw/openclaw). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message, adds pre-compaction fact extraction, and provides persistent cross-session memory for all your agents.

One install, one config, one database. The default database path remains `~/.openclaw/lcm.db` for backward compatibility, but the preferred config surface now uses `ENGRAM_*` environment variables and the `engram` plugin entry.

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Agent tools](#agent-tools)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## What it does

When a conversation grows beyond the model's context window, OpenClaw normally truncates older messages. engram instead:

1. **Persists every message** in a local SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can search and recall details from compacted history
6. **Extracts durable facts** right before compaction — decisions, preferences, entities, episodes — so they survive summarization intact
7. **Queries memory** via `memory_query` for semantic search across all captured knowledge

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't.**

### Pre-compaction fact extraction

Right before messages are compacted into summaries (a lossy operation), engram scans them for durable signals: architectural decisions, stated preferences, named entities, key episodes. These are extracted with fast heuristics — no LLM call, no extra latency — and stored permanently with `source=pre_compaction`.

This is the critical difference from a simple summarization approach: durable facts survive even after the summaries containing them have been condensed or re-summarized. Your agent remembers things you said hours ago *specifically*, not vaguely.

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### Install the plugin

```bash
openclaw plugins install engram
```

If you're running from a local OpenClaw checkout:

```bash
pnpm openclaw plugins install engram
```

For local plugin development, link your working copy:

```bash
openclaw plugins install --link /path/to/engram
```

The install command records the plugin, enables it, and wires it into the `contextEngine` slot automatically.

### Recommended starting configuration

Add these to your environment or OpenClaw config:

```bash
ENGRAM_COMPACTION_FRESH_TAIL_COUNT=32
ENGRAM_COMPACTION_INCREMENTAL_MAX_DEPTH=-1
ENGRAM_COMPACTION_CONTEXT_THRESHOLD=0.75
```

- `FRESH_TAIL_COUNT=32` — protects the last 32 messages from compaction (recent context stays raw)
- `INCREMENTAL_MAX_DEPTH=-1` — enables full cascade condensation after each compaction pass
- `CONTEXT_THRESHOLD=0.75` — triggers at 75% of the model's context window, leaving headroom

For long-lived sessions (7+ days of continuous agent operation):

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

This keeps sessions alive across idle gaps so memory accumulates over weeks, not hours.

## Configuration

engram is configured through plugin config or environment variables. Environment variables take precedence. Prefer `ENGRAM_*` variables for new installs; legacy `LCM_*` aliases are still accepted.

### Plugin config

Add an `engram` entry under `plugins.entries` in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "freshTailCount": 32,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": -1
        }
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_ENABLED` | `true` | Enable/disable the plugin |
| `ENGRAM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database (legacy default path retained for compatibility) |
| `ENGRAM_COMPACTION_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0–1.0) |
| `ENGRAM_COMPACTION_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `ENGRAM_COMPACTION_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `ENGRAM_COMPACTION_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `ENGRAM_COMPACTION_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `ENGRAM_COMPACTION_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only, -1 = unlimited) |
| `ENGRAM_COMPACTION_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `ENGRAM_COMPACTION_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `ENGRAM_COMPACTION_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `ENGRAM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `ENGRAM_LARGEFILES_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `ENGRAM_LARGEFILES_SUMMARY_PROVIDER` | `""` | Provider override for large-file summarization |
| `ENGRAM_LARGEFILES_SUMMARY_MODEL` | `""` | Model override for large-file summarization |
| `ENGRAM_SUMMARY_MODEL` | *(from OpenClaw)* | Model for summarization (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `ENGRAM_SUMMARY_PROVIDER` | *(from OpenClaw)* | Provider override for summarization |
| `ENGRAM_COMPACTION_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction after turns |
| `ENGRAM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles from Engram storage |
| `ENGRAM_VECTOR_BACKEND` | `sqlite_vec` | Vector backend: `sqlite_vec`, `falkordb`, or `none` |
| `ENGRAM_VECTOR_EMBEDDING_PROVIDER` | `openai` | Embedding provider name for OpenAI-compatible embedding APIs |
| `ENGRAM_VECTOR_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model used for provider-backed vector indexing |
| `ENGRAM_FALKORDB_ENABLED` | `false` | Enable FalkorDB vector mirroring / external nearest-neighbor search |

### OpenClaw session reset settings

engram preserves history through compaction, but it does **not** change OpenClaw's core session reset policy. If sessions are resetting sooner than you want, increase OpenClaw's `session.reset.idleMinutes` or use a channel/type-specific override.

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

Useful values: `1440` (1 day), `10080` (7 days), `43200` (30 days), `525600` (365 days).

## Agent tools

Once installed, your agents automatically have access to:

| Tool | What it does |
|------|-------------|
| `context_grep` / `lcm_grep` | Full-text search across stored conversation history |
| `context_describe` / `lcm_describe` | Inspect summaries and stored file references |
| `context_query` / `lcm_expand_query` | Ask focused questions against compacted history |
| `memory_add` | Persist durable facts, decisions, preferences, and episodes |
| `memory_search` / `memory_query` | Search and strategy-query durable memory |
| `memory_get` / `entity_get` | Fetch memories and rich entity profiles directly by ID |
| `memory_ingest_now` / `memory_job_status` | Queue and inspect background episodic ingestion jobs |
| `memory_list_agents` | List discovered memory namespaces |
| `vault_query` / `ops_status` / `gradient_score` | Query the vault mirror, inspect system health, and evaluate responses against the local alignment guardrails |

No configuration changes to your agent prompts. No new workflows to learn. The memory just works.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration guide](docs/configuration.md)
- [Agent tools reference](docs/agent-tools.md)
- [Live rollout checklist](docs/live-rollout.md)
- [TUI Reference](docs/tui.md)
- [lcm-tui](tui/README.md)
- [Optional: enable FTS5 for fast full-text search](docs/fts5.md)

## Development

```bash
# Run tests
npm test

# Type check
npx tsc --noEmit

# Run a specific test file
npx vitest test/engine.test.ts
```

### Project structure

```
index.ts                    # Plugin entry point and registration
src/
  engine.ts                 # LcmContextEngine — implements ContextEngine interface
  assembler.ts              # Context assembly (summaries + messages → model context)
  compaction.ts             # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts              # Depth-aware prompt generation and LLM summarization
  retrieval.ts              # RetrievalEngine — grep, describe, expand operations
  expansion.ts              # DAG expansion logic for lcm_expand_query
  expansion-auth.ts         # Delegation grants for sub-agent expansion
  expansion-policy.ts       # Depth/token policy for expansion
  large-files.ts            # File interception, storage, and exploration summaries
  integrity.ts              # DAG integrity checks and repair utilities
  transcript-repair.ts      # Tool-use/result pairing sanitization
  types.ts                  # Core type definitions (dependency injection contracts)
  openclaw-bridge.ts        # Bridge utilities
  db/
    config.ts               # LcmConfig resolution from env vars
    connection.ts           # SQLite connection management
    migration.ts            # Schema migrations
  store/
    conversation-store.ts   # Message persistence and retrieval
    summary-store.ts        # Summary DAG persistence and context item management
    fts5-sanitize.ts        # FTS5 query sanitization
  tools/
    lcm-grep-tool.ts        # lcm_grep tool implementation
    lcm-describe-tool.ts    # lcm_describe tool implementation
    lcm-expand-tool.ts      # lcm_expand tool (sub-agent only)
    lcm-expand-query-tool.ts # lcm_expand_query tool (main agent wrapper)
    lcm-conversation-scope.ts # Conversation scoping utilities
    common.ts               # Shared tool utilities
test/                       # Vitest test suite
specs/                      # Design specifications
openclaw.plugin.json        # Plugin manifest with config schema and UI hints
tui/                        # Interactive terminal UI (Go)
  main.go                   # Entry point and bubbletea app
  data.go                   # Data loading and SQLite queries
  dissolve.go               # Summary dissolution
  repair.go                 # Corrupted summary repair
  rewrite.go                # Summary re-summarization
  transplant.go             # Cross-conversation DAG copy
  prompts/                  # Depth-aware prompt templates
.goreleaser.yml             # GoReleaser config for TUI binary releases
```

## License

MIT
