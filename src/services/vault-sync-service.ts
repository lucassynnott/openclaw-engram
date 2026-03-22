/**
 * vault-sync-service.ts — Periodic vault mirror rebuild service for Engram.
 *
 * Registered as an OpenClaw plugin service. When the gateway starts, this
 * service launches a `setInterval` timer that rebuilds the Obsidian vault
 * surface every `vaultSyncIntervalHours` hours (default 24). The timer is
 * cleared on service stop.
 *
 * Guards:
 *  - Skips if vault is not enabled (`vaultEnabled: false`)
 *  - Skips if interval is 0 (explicitly disabled)
 *  - Idempotent: calling start twice reuses the same timer
 *  - Resilient: build errors are caught and logged, never thrown
 */

import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { optimizeDatabase, archiveOldMemories } from "../db/optimize.js";
import { ensureMemoryTables } from "../memory/memory-schema.js";
import { buildVaultSurface } from "../surface/vault-mirror.js";

export type VaultSyncLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

export type VaultSyncServiceOptions = {
  config: LcmConfig;
  logger: VaultSyncLogger;
};

/**
 * Create the vault-sync plugin service definition.
 *
 * This returns an object compatible with `OpenClawPluginService` that can be
 * passed to `api.registerService()`.
 */
export function createVaultSyncService(options: VaultSyncServiceOptions) {
  const { config, logger } = options;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Run lightweight database optimization (PRAGMA optimize + incremental
   * vacuum + archive old candidates). All errors are caught and logged.
   */
  function runDbOptimize(): void {
    if (!config.dbOptimizeEnabled) {
      return;
    }

    try {
      const db = getLcmConnection(config.databasePath);
      ensureMemoryTables(db);

      const result = optimizeDatabase(db);
      const archived = archiveOldMemories(db);

      logger.info(
        `[engram:db-optimize] completed in ${result.durationMs}ms ` +
          `(freedBytes=${result.freedBytes}, archivedMemories=${archived})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[engram:db-optimize] failed: ${message}`);
    }
  }

  /**
   * Run a single vault-sync cycle. All errors are caught and logged.
   * Returns true if the build completed without error, false otherwise.
   */
  function runVaultSync(): boolean {
    const startedAt = Date.now();
    try {
      const summary = buildVaultSurface({ config, dryRun: false });
      const elapsed = Date.now() - startedAt;
      logger.info(
        `[engram:vault-sync] build completed in ${elapsed}ms ` +
          `(conversations=${summary.conversation_count}, ` +
          `copied=${summary.copied_files}, ` +
          `removed=${summary.removed_files}, ` +
          `skipped=${summary.skipped_unchanged})`,
      );
      return true;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[engram:vault-sync] build failed after ${elapsed}ms: ${message}`,
      );
      return false;
    }
  }

  return {
    id: "engram-vault-sync",

    start() {
      // Already running — idempotent guard
      if (timer !== null) {
        return;
      }

      // Vault must be enabled
      if (!config.vaultEnabled) {
        logger.info(
          "[engram:vault-sync] vault not enabled, skipping automatic sync",
        );
        return;
      }

      // Interval of 0 means explicitly disabled
      const intervalHours = config.vaultSyncIntervalHours;
      if (intervalHours <= 0) {
        logger.info(
          "[engram:vault-sync] automatic vault sync disabled (interval=0)",
        );
        return;
      }

      const intervalMs = intervalHours * 60 * 60 * 1000;

      logger.info(
        `[engram:vault-sync] starting automatic vault sync every ${intervalHours}h`,
      );

      // Run immediately on startup, then repeat on interval
      runVaultSync();
      runDbOptimize();

      timer = setInterval(() => {
        runVaultSync();
        runDbOptimize();
      }, intervalMs);

      // Allow the process to exit even if the timer is still active
      if (timer && typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        logger.info("[engram:vault-sync] stopped automatic vault sync");
      }
    },
  };
}
