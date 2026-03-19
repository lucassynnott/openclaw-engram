# Live Rollout Checklist

Use this checklist before switching `plugins.slots.memory` or `plugins.slots.contextEngine` to `engram`.

## Preflight

1. Run `npm test` from the plugin repo and confirm the suite is green.
2. Run `openclaw doctor --non-interactive` and confirm `Plugins: Errors 0`.
3. Run `openclaw gateway status` and confirm `RPC probe: ok`.
4. Confirm the Engram plugin entry points at the intended checkout in `~/.openclaw/openclaw.json`.
5. Confirm the target database path is correct. New installs should prefer `ENGRAM_DATABASE_PATH`; existing installs may keep `~/.openclaw/lcm.db`.

## Recommended Config

Prefer the `ENGRAM_*` environment surface for new installs:

```bash
ENGRAM_COMPACTION_FRESH_TAIL_COUNT=32
ENGRAM_COMPACTION_INCREMENTAL_MAX_DEPTH=-1
ENGRAM_COMPACTION_CONTEXT_THRESHOLD=0.75
ENGRAM_VECTOR_BACKEND=sqlite_vec
ENGRAM_VECTOR_EMBEDDING_PROVIDER=openai
ENGRAM_VECTOR_EMBEDDING_MODEL=text-embedding-3-small
```

Optional FalkorDB mirror:

```bash
ENGRAM_FALKORDB_ENABLED=true
ENGRAM_FALKORDB_HOST=localhost
ENGRAM_FALKORDB_PORT=6379
ENGRAM_FALKORDB_KNOWLEDGE_GRAPH=engram_knowledge
```

## Smoke Tests

Run these against the target agent after rollout:

1. `memory_add` then `memory_search` for the same fact.
2. `memory_query` with a natural-language question.
3. `memory_get` and `entity_get` on stored records.
4. `lcm_grep`, `lcm_describe`, and `lcm_expand_query` in a session with compacted history.
5. `ops_status` and verify `status=healthy` with only optional-feature warnings.
6. If FalkorDB is enabled, confirm `ops_status.memory.vector_runtime.falkordb.enabled=true`.

## Rollback

If the rollout regresses, revert the slots:

```json
{"plugins":{"slots":{"contextEngine":"lossless-claw","memory":"gigabrain"}}}
```

Then restart the gateway and re-run:

```bash
openclaw doctor --non-interactive
openclaw gateway status
```

## Notes

- `vault_query` and FalkorDB are optional. Disabled optional subsystems should not mark Engram unhealthy.
- Legacy `LCM_*` env vars remain supported for compatibility, but new rollout docs and examples should use `ENGRAM_*`.
- The active slots do not need to be changed until the above checks are clean.
