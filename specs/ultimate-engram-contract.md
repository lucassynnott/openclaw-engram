# Ultimate Engram Contract

This document defines the local public contract for Engram as the unified OpenClaw memory and context plugin.

## Public Tool Surface

These tools are the canonical public names the plugin should expose:

- `lcm_grep`
- `lcm_describe`
- `lcm_expand_query`
- `memory_add`
- `memory_search`
- `memory_query`
- `memory_get`
- `entity_get`
- `vault_query`
- `gradient_score`
- `ops_status`
- `lcm_expand`

## Compatibility Aliases

The local plugin also preserves compatibility aliases and legacy names already in production:

- `context_grep`, `context_describe`, `context_expand`, `context_query`
- `memory_get_entity`, `memory_get_episode`
- `memory_namespace_status`, `memory_list_agents`, `memory_ingest_now`, `memory_job_status`
- `alignment_status`, `alignment_check`, `alignment_drift`
- `memory_recall`, `memory_world`

## Backing Layers

The local implementation should converge these layers into one runtime:

- Lossless-claw: LCM conversation DAG, compaction, grep, describe, expand.
- Gigabrain: durable memory capture, recall, world model, vault mirror.
- OpenStinger: episodic memory shape, namespace concepts, gradient naming, StingerVault import surface.
- StingerVault: curated, agent-facing vault query surface.
- PARA/native files: human-editable file memory and project structure.

## Storage Contract

The current local plugin already relies on these primary stores:

- SQLite LCM tables for conversations, summaries, files, and context DAG state.
- SQLite memory tables for durable memories, entities, episodes, and events.
- SQLite world-model tables for beliefs, entity syntheses, open loops, and contradictions.
- Vault mirror artifacts for read-only vault querying and freshness checks.
- Native file structures and migration tooling as the long-term human-editable layer.

## Compatibility Rules

- Add new canonical tools without breaking existing aliases.
- Prefer wrapping existing local implementations over forking toward the thinner `engram-v2` repo code.
- Keep runtime behavior graceful when optional subsystems are not active.
- Keep docs and tests aligned with the exact public tool names above.
