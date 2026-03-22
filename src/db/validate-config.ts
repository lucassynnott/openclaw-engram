import type { LcmConfig } from "./config.js";

/**
 * Run a validation pass over the resolved LCM config and emit warnings for
 * suspicious or invalid values.  This function NEVER throws — it only logs
 * warnings so the plugin can still start with its hardcoded defaults.
 */
export function validateConfig(
  config: LcmConfig,
  log: { warn: (msg: string) => void },
): void {
  if (config.harvestEveryNTurns < 1) {
    log.warn(
      `[engram] config: harvestEveryNTurns (${config.harvestEveryNTurns}) must be >= 1, using default 10`,
    );
  }

  if (config.harvestLookbackTurns < 1) {
    log.warn(
      `[engram] config: harvestLookbackTurns (${config.harvestLookbackTurns}) must be >= 1, using default 20`,
    );
  }

  if ((config as Record<string, unknown>).harvestMinCooldownSeconds !== undefined) {
    const cooldown = (config as Record<string, unknown>).harvestMinCooldownSeconds;
    if (typeof cooldown === "number" && cooldown < 0) {
      log.warn(
        `[engram] config: harvestMinCooldownSeconds (${cooldown}) must be >= 0`,
      );
    }
  }

  if (config.episodeRetentionDays < 1) {
    log.warn(
      `[engram] config: episodeRetentionDays (${config.episodeRetentionDays}) must be >= 1, using default 7`,
    );
  }

  if (config.contextThreshold < 0 || config.contextThreshold > 1) {
    log.warn(
      `[engram] config: contextThreshold (${config.contextThreshold}) must be between 0 and 1, using default 0.75`,
    );
  }

  if (config.freshTailCount < 1) {
    log.warn(
      `[engram] config: freshTailCount (${config.freshTailCount}) must be >= 1, using default 32`,
    );
  }

  if (config.vaultSyncIntervalHours < 0) {
    log.warn(
      `[engram] config: vaultSyncIntervalHours (${config.vaultSyncIntervalHours}) must be >= 0, using default 24`,
    );
  }

  if (config.vectorDimensions < 1) {
    log.warn(
      `[engram] config: vectorDimensions (${config.vectorDimensions}) must be >= 1, using default 1536`,
    );
  }

  if (!config.databasePath) {
    log.warn("[engram] config: databasePath is empty, using default database path");
  }

  if (config.vaultEnabled && !config.vaultPath) {
    log.warn("[engram] config: vault enabled but no vaultPath set");
  }
}
