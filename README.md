<p align="center">
  <img src="assets/engram-logo.jpg" alt="Engram" width="200" />
</p>

<h1 align="center">Engram</h1>

<p align="center">
  <strong>Cyberpunk-grade memory for your OpenClaw agent — never forget, always recall.</strong>
</p>

---

Unified memory and context engine plugin for [OpenClaw](https://github.com/openclaw/openclaw). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message, adds pre-compaction fact extraction, persistent cross-session memory, automatic background memory harvesting, an Obsidian vault surface, and entity-aware recall for all your agents.

One install, one config, one database. The default database path remains `~/.openclaw/lcm.db` for backward compatibility, but the preferred config surface now uses `ENGRAM_*` environment variables and the `engram` plugin entry.

## Table of contents

- [Recent updates](#recent-updates)
- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Agent tools](#agent-tools)
- [Memory quality](#memory-quality)
- [Obsidian vault](#obsidian-vault)
- [Export and import](#export-and-import)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## Recent updates

- **Activation-based memory lifecycle** — Engram now separates `truth_confidence` from `activation_strength`. Duplicate captures reinforce existing memories instead of only failing, and explicit recall/search/query surfaces reinforce only the memories actually returned.
- **First-class observations** — `OBSERVATION` is now a real durable memory kind alongside facts, preferences, decisions, entities, and episodes.
- **No archive-on-write for ordinary low-value memories** — low-value memories stay stored as active rows by default and rank low instead of disappearing immediately. If a caller wants strict rejection, `skipArchiveCandidates` still blocks them before insert.
- **Opt-in cold tiering** — ordinary memories are no longer forgotten just because they got old. Heartbeat/status spam still gets archived, and low-activation episode tiering is available behind rollout flags.
- **Lifecycle-aware native sync and ops** — `items.yaml` now round-trips lifecycle metadata, and `ops_status` reports activation rollout, reinforcement counters, duplicate-to-reinforce ratio, and cold-tier episode counts.
- **Vault session-note fix** — vault sync no longer emits empty session notes for conversations that have no summaries.

## What it does

When a conversation grows beyond the model's context window, OpenClaw normally truncates older messages. Engram instead:

1. **Persists every message** in a local SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** so agents can search and recall details from compacted history
6. **Extracts durable facts** right before compaction — decisions, preferences, entities, episodes — so they survive summarization intact
7. **Harvests memories** automatically every N turns by running a background LLM extraction pass over recent conversation
8. **Tracks reinforcement** so repeated capture and successful retrieval keep important memories easy to surface
9. **Ranks recall** by truth, activation, lexical/vector match, and memory type — preferences and decisions surface above stale noise
10. **Mirrors to Obsidian** with an auto-rebuilding vault surface (entity pages, memory index, knowledge graph views)

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't.**

### Pre-compaction fact extraction

Right before messages are compacted into summaries (a lossy operation), Engram scans them for durable signals: architectural decisions, stated preferences, named entities, key episodes. These are extracted with fast heuristics — no LLM call, no extra latency — and stored permanently with `source=pre_compaction`.

This is the critical difference from a simple summarization approach: durable facts survive even after the summaries containing them have been condensed or re-summarized. Your agent remembers things you said hours ago *specifically*, not vaguely.

### Periodic harvest

Every N user turns (default: 10), Engram runs a background LLM extraction pass over recent conversation to capture preferences, corrections, decisions, and facts the user reveals naturally. This is non-blocking — it fires after the assistant response and never delays the main reply.

Extracted memories are stored through the standard pipeline with full deduplication, quality filtering, and entity linking. Only PREFERENCE, DECISION, and USER_FACT kinds are extracted (never EPISODE or CONTEXT).

### Activation-based lifecycle

Engram now models durable memory with two separate axes:

- **Truth confidence** — how likely the memory is correct
- **Activation strength** — how retrievable the memory is right now

That split fixes an old design problem where age, confidence, and usefulness were all being mixed together.

- Duplicate captures reinforce the existing row instead of creating junk or hard-failing.
- `memory_search`, `memory_recall`, `memory_query`, and proactive surfacing reinforce only the memories actually returned to the caller.
- Old memories decay in visibility instead of being deleted by age.
- `memory_correct` and `memory_retract` explicitly change truth-state instead of only changing ranking.

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization and harvest)

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

The install command records the plugin, enables it, and wires it into the `contextEngine` slot automatically. On first activation, Engram:
- Creates the SQLite database
- Runs schema migrations
- Validates config and logs warnings for suspicious values
- Starts the vault-sync service (rebuilds the Obsidian vault every 24 hours)
- Begins periodic memory harvesting

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

Engram is configured through plugin config or environment variables. Environment variables take precedence. Prefer `ENGRAM_*` variables for new installs; legacy `LCM_*` aliases are still accepted.

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
          "incrementalMaxDepth": -1,
          "periodicHarvest": {
            "enabled": true,
            "everyNTurns": 10,
            "lookbackTurns": 20,
            "minCooldownSeconds": 60
          },
          "vaultEnabled": true,
          "vaultPath": "/path/to/obsidian-vault",
          "vaultSubdir": "Engram"
        }
      }
    }
  }
}
```

### Environment variables

#### Compaction

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_ENABLED` | `true` | Enable/disable the plugin |
| `ENGRAM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `ENGRAM_COMPACTION_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0-1.0) |
| `ENGRAM_COMPACTION_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `ENGRAM_COMPACTION_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `ENGRAM_COMPACTION_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `ENGRAM_COMPACTION_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `ENGRAM_COMPACTION_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only, -1 = unlimited) |
| `ENGRAM_COMPACTION_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `ENGRAM_COMPACTION_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `ENGRAM_COMPACTION_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `ENGRAM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `ENGRAM_COMPACTION_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction after turns |

#### Memory and retrieval

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_VECTOR_BACKEND` | `sqlite_vec` | Vector backend: `sqlite_vec`, `falkordb`, or `none` |
| `ENGRAM_VECTOR_EMBEDDING_PROVIDER` | `openai` | Embedding provider for vector indexing |
| `ENGRAM_VECTOR_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model for vector indexing |
| `ENGRAM_ACTIVATION_MODEL_ENABLED` | `false` | Enable the activation-based lifecycle model (truth + activation + reinforcement) |
| `ENGRAM_ACTIVATION_MODEL_ROLLOUT_FRACTION` | `0` | Roll out activation behavior by deterministic fraction from `0.0` to `1.0` |
| `ENGRAM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles |

#### Periodic harvest

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_HARVEST_ENABLED` | `true` | Enable background memory extraction from conversation |
| `ENGRAM_HARVEST_EVERY_N_TURNS` | `10` | User turns between harvest passes |
| `ENGRAM_HARVEST_LOOKBACK_TURNS` | `20` | Recent turns sent to the extraction model |
| `ENGRAM_HARVEST_MODEL` | *(inherit)* | Model override for extraction (empty = use session model) |
| `ENGRAM_HARVEST_MIN_COOLDOWN_SECONDS` | `60` | Minimum seconds between harvest runs |

#### Memory hygiene

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_EPISODE_RETENTION_DAYS` | `7` | Legacy retention knob now used for heartbeat/status-spam EPISODE archival windows |
| `ENGRAM_HEARTBEAT_DEDUPE_THRESHOLD` | `0.7` | Lower similarity threshold for heartbeat dedup |
| `ENGRAM_FRAGMENT_MIN_CONTENT_CHARS` | `50` | Minimum chars for non-fragment memories |
| `ENGRAM_HYGIENE_TIERING_ENABLED` | `false` | Enable opt-in cold-tier episode hygiene |
| `ENGRAM_HYGIENE_TIERING_MODE` | `observe` | Cold-tier mode: `observe` or `enforce` |
| `ENGRAM_DB_OPTIMIZE_ENABLED` | `true` | Run periodic DB optimization (PRAGMA optimize + incremental vacuum) |

#### Vault and Obsidian

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_VAULT_ENABLED` | `false` | Enable Obsidian vault mirror |
| `ENGRAM_VAULT_PATH` | `""` | Root path to the Obsidian vault |
| `ENGRAM_VAULT_SUBDIR` | `Engram` | Subdirectory within the vault |
| `ENGRAM_VAULT_SYNC_INTERVAL_HOURS` | `24` | Auto-rebuild interval (0 to disable) |
| `ENGRAM_VAULT_CLEAN` | `true` | Remove stale managed files on rebuild |

#### Large files

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_LARGEFILES_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `ENGRAM_LARGEFILES_SUMMARY_PROVIDER` | `""` | Provider override for large-file summarization |
| `ENGRAM_LARGEFILES_SUMMARY_MODEL` | `""` | Model override for large-file summarization |
| `ENGRAM_SUMMARY_MODEL` | *(from OpenClaw)* | Model for conversation summarization |
| `ENGRAM_SUMMARY_PROVIDER` | *(from OpenClaw)* | Provider override for summarization |

### OpenClaw session reset settings

Engram preserves history through compaction, but it does **not** change OpenClaw's core session reset policy. If sessions are resetting sooner than you want, increase OpenClaw's `session.reset.idleMinutes` or use a channel/type-specific override.

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

### Memory tools (long-term storage)

| Tool | What it does |
|------|-------------|
| `memory_search` | Keyword and semantic search across stored memories. Returned hits reinforce activation when the rollout is enabled. |
| `memory_add` | Store durable facts, observations, decisions, preferences, and entities. Duplicate captures reinforce existing rows instead of only failing. |
| `memory_get` | Fetch a specific memory, episode, summary, file, or entity by ID |
| `memory_recall` | Load top-k memories by composite recall score with per-type budget allocation. Returned rows reinforce activation when enabled. |
| `memory_query` | Strategy-aware recall for timelines, entity briefs, and targeted questions. Only surfaced rows are reinforced. |
| `memory_retract` | Mark a memory as wrong/superseded and explicitly demote its truth/activation state |
| `memory_correct` | Replace an existing memory with a corrected version and strongly seed the replacement lifecycle |
| `memory_world` | Surface the entity model — people, projects, organizations |
| `entity_get` | Fetch a rich entity profile with beliefs, episodes, and syntheses |
| `entity_merge` | Merge duplicate entities into a canonical entity |
| `vault_query` | Query the Obsidian vault mirror by category and text |
| `ops_status` | Engram health dashboard across memory, LCM, vault, alignment, activation rollout, and cold-tier observability |

### Context tools (conversation history)

| Tool | What it does |
|------|-------------|
| `context_grep` / `lcm_grep` | Full-text search across stored conversation history |
| `context_describe` / `lcm_describe` | Inspect summaries and stored file references |
| `context_expand` / `lcm_expand` | Expand a summary subtree to recover compressed detail |
| `context_query` / `lcm_expand_query` | Ask focused questions against compacted history via bounded sub-agent |

No configuration changes to your agent prompts. No new workflows to learn. The memory just works.

## Memory quality

Engram includes multiple layers of memory quality control to keep the store clean and useful.

### Capture quality

- **System prompt detection** — rejects `<composio>`, `<system>`, `<system-reminder>` tags and instruction language
- **Credential filtering** — catches API keys (`sk-`, `ghp_`, `AKIA`), bearer tokens, PEM keys, connection strings
- **Content length caps** — hard reject at 2,000 chars, soft penalty above 500 chars
- **Junk detection** — filters tool outputs, metadata noise, template placeholders, heartbeat acks

### Entity extraction

- **Multi-word proper names** — single capitalized words are not valid person name candidates (prevents "Building", "Products", "Home" as entities)
- **Stopword filter** — ~2,500 word list covering common English vocabulary, tech terms, business jargon, AI product names
- **Confidence thresholds** — person: 0.60, organization: 0.55, project: 0.55 minimum
- **Quality filter on all code paths** — extraction, `memory_add`, and world model rebuild all go through the same filter

### Memory hygiene (automatic)

- **No blanket age-pruning** — ordinary memories are not deleted or archived just because they got old
- **Heartbeat archival** — heartbeat-pattern episodes are identified and archived
- **Cold-tier episode hygiene** — low-value, unreviewed, inactive episodes can be observed or archived when tiering is enabled
- **Fragment cleanup** — entries under 50 chars with no meaningful content are archived
- **Heartbeat dedup** — lower similarity threshold (0.7 vs 0.8) catches near-duplicate status logs
- **Low-value storage stays recallable** — low-value memories remain stored and can resurface through targeted search
- **DB optimization** — `PRAGMA optimize` + incremental vacuum runs every 24 hours

### Search ranking

Recall scoring blends truth confidence, activation, value, lexical/vector match, temporal fit, and entity locks. Type-based score multipliers still bias high-signal memories above noise:

| Type | Multiplier |
|------|-----------|
| PREFERENCE | 1.3x |
| DECISION | 1.2x |
| USER_FACT | 1.0x |
| OBSERVATION | 1.0x |
| AGENT_IDENTITY | 1.0x |
| ENTITY | 0.9x |
| CONTEXT | 0.8x |
| EPISODE | 0.6x |

Heartbeat-pattern episodes get an additional 0.5x penalty (effective 0.3x).

### Harvest injection hardening

The periodic harvest includes 4-layer defense against adversarial content:
1. Existing `detectJunk()` filter
2. System prompt artifact detection
3. Credential pattern matching (7 regex patterns)
4. Prompt injection detection (10 regex patterns)

Plus explicit anti-injection rules in the extraction prompt itself.

## Obsidian vault

When `vaultEnabled` is true, Engram mirrors its memory database into a structured Obsidian vault that you can browse, search, and link from your notes.

```
Engram/
  00 Home/Home.md           — Landing page with counts and health
  10 Native/memory/          — Daily notes timeline
  20 Knowledge/              — Manually placed knowledge (ADRs, playbooks, etc.)
  30 Views/                  — Auto-generated views (people, projects, state)
  40 Reports/                — Build reports and health artifacts
  60 Entities/               — Entity pages with beliefs and linked memories
  vault-index.md             — Root index
```

The vault rebuilds automatically every 24 hours (configurable via `vaultSyncIntervalHours`). Set to `0` to disable auto-rebuild; run manually with `engram vault-sync`.

## Export and import

Engram supports portable JSON export for backup, migration, and seeding new agent workspaces.

```bash
# Export all active memories and entities
engram export --output backup.json

# Import into a fresh database (deduplicates automatically)
engram import backup.json
```

Export format:

```json
{
  "version": 1,
  "exported_at": "2026-03-22T03:00:00.000Z",
  "memories": [
    {
      "memory_id": "mem_abc123",
      "type": "PREFERENCE",
      "content": "User prefers TypeScript over JavaScript",
      "confidence": 0.85,
      "truth_confidence": 0.85,
      "activation_strength": 0.63,
      "reinforcement_count": 4,
      "retrieval_count": 7,
      "value_label": "core",
      ...
    }
  ],
  "entities": [
    {
      "entity_id": "person:lucas",
      "kind": "person",
      "display_name": "lucas",
      ...
    }
  ]
}
```

Import deduplicates by `normalized_hash` for memories and `entity_id` for entities. Importing the same file twice is safe. Native PARA sync also round-trips lifecycle metadata through managed `items.yaml` files.

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
# Install dependencies
pnpm install

# Run tests
npx vitest run

# Type check
npx tsc --noEmit

# Run a specific test file
npx vitest test/engine.test.ts

# Run the CLI
npx tsx src/cli/engram-cli.ts <command>

# Available CLI commands
engram status           # Show health and rollout readiness
engram db-stats         # Show database table counts
engram vault-sync       # Force a vault mirror rebuild
engram export           # Export active memories to JSON
engram import <path>    # Import memories from JSON
engram migrate          # Run database migrations
```

### Project structure

```
index.ts                        # Plugin entry point, registration, config validation
openclaw.plugin.json            # Plugin manifest with config schema and UI hints
src/
  context/
    engine.ts                   # LcmContextEngine — implements ContextEngine interface
    assembler.ts                # Context assembly (summaries + messages -> model context)
    expansion-auth.ts           # Delegation grants for sub-agent expansion
  memory/
    compaction.ts               # CompactionEngine — leaf passes, condensation, sweeps
    summarize.ts                # Depth-aware prompt generation and LLM summarization
    retrieval.ts                # RetrievalEngine — grep, describe, expand operations
    capture.ts                  # Pre-compaction memory extraction from messages
    periodic-harvest.ts         # Background LLM memory extraction every N turns
    activation.ts               # Activation decay and reinforcement math
    activation-rollout.ts       # Deterministic rollout helpers for activation + hygiene tiering
    memory-utils.ts             # Junk detection, value classification, content scoring
    memory-hygiene.ts           # Heartbeat cleanup, fragment removal, opt-in cold-tier episode hygiene
    memory-schema.ts            # SQLite table definitions + lifecycle backfill
    native-file-sync.ts         # Bidirectional sync with MEMORY.md/daily notes + lifecycle round-trip
    vector-search.ts            # Vector similarity search and embedding management
    store/
      conversation-store.ts     # Message persistence and retrieval
      summary-store.ts          # Summary DAG persistence
  entity/
    entity-quality-filter.ts    # Stopword list and name validation (~2,500 words)
    person-service.ts           # Person entity extraction with multi-word name patterns
    world-model.ts              # Entity candidate evaluation and world model management
  surface/
    memory-add-tool.ts          # memory_add with quality filtering, lifecycle seeding, and duplicate reinforcement
    memory-search-tool.ts       # memory_search with returned-result reinforcement
    memory-recall-tool.ts       # memory_recall with per-type budgeting and reinforcement
    memory-recall-core.ts       # Composite scoring engine (truth, activation, vector, lexical, type)
    memory-mutation-tools.ts    # memory_retract and memory_correct with truth/activation invalidation
    memory-query-tool.ts        # memory_query strategy-aware recall with returned-result reinforcement
    memory-world-tool.ts        # memory_world entity surface
    engram-v2-compat-tools.ts   # ops_status, activation observability, vault_query, entity tools
    alignment-tools.ts          # Alignment check, drift, and status tools
    vault-mirror.ts             # Obsidian vault build engine
    lcm-grep-tool.ts            # context_grep implementation
    lcm-describe-tool.ts        # context_describe implementation
    lcm-expand-tool.ts          # context_expand implementation
    lcm-expand-query-tool.ts    # context_query implementation
  services/
    vault-sync-service.ts       # Automated 24h vault rebuild + DB optimization
  db/
    config.ts                   # LcmConfig resolution (env vars + plugin config)
    connection.ts               # SQLite connection with WAL mode + busy_timeout
    migration.ts                # Schema migrations
    optimize.ts                 # PRAGMA optimize + incremental vacuum + memory archival
    validate-config.ts          # Startup config validation with warnings
    health.ts                   # Quick health check probe
  cli/
    engram-cli.ts               # CLI entry point (status, vault-sync, export, import)
    export-import.ts            # Portable JSON export/import
  integration/
    openclaw-bridge.ts          # ContextEngine interface and bridge types
    large-files.ts              # File interception, storage, and exploration
  types.ts                      # Core type definitions (dependency injection contracts)
test/                           # Vitest test suite (8,400+ tests)
tui/                            # Interactive terminal UI (Go)
```

## License

MIT
