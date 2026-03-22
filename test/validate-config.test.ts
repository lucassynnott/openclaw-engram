import { describe, it, expect, vi } from "vitest";
import { validateConfig } from "../src/db/validate-config.js";
import { resolveLcmConfig } from "../src/db/config.js";

function makeLog() {
  return { warn: vi.fn() };
}

describe("validateConfig", () => {
  it("is silent on good default values", () => {
    const config = resolveLcmConfig({}, {});
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns on harvestEveryNTurns < 1", () => {
    const config = resolveLcmConfig({}, { "periodicHarvest.everyNTurns": 0 } as Record<string, unknown>);
    // Force the value since config parsing may clamp it
    (config as Record<string, unknown>).harvestEveryNTurns = 0;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("harvestEveryNTurns"),
    );
  });

  it("warns on harvestLookbackTurns < 1", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).harvestLookbackTurns = 0;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("harvestLookbackTurns"),
    );
  });

  it("warns on episodeRetentionDays < 1", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).episodeRetentionDays = 0;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("episodeRetentionDays"),
    );
  });

  it("warns on contextThreshold out of range (< 0)", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).contextThreshold = -0.1;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("contextThreshold"),
    );
  });

  it("warns on contextThreshold out of range (> 1)", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).contextThreshold = 1.5;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("contextThreshold"),
    );
  });

  it("warns on freshTailCount < 1", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).freshTailCount = 0;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshTailCount"),
    );
  });

  it("warns on vaultSyncIntervalHours < 0", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).vaultSyncIntervalHours = -1;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("vaultSyncIntervalHours"),
    );
  });

  it("warns on vectorDimensions < 1", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).vectorDimensions = 0;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("vectorDimensions"),
    );
  });

  it("warns on empty databasePath", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).databasePath = "";
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("databasePath"),
    );
  });

  it("warns when vault enabled but no path set", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).vaultEnabled = true;
    (config as Record<string, unknown>).vaultPath = "";
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("vault enabled but no vaultPath set"),
    );
  });

  it("warns on negative harvestMinCooldownSeconds when present", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).harvestMinCooldownSeconds = -5;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("harvestMinCooldownSeconds"),
    );
  });

  it("does not warn when harvestMinCooldownSeconds is valid", () => {
    const config = resolveLcmConfig({}, {});
    (config as Record<string, unknown>).harvestMinCooldownSeconds = 10;
    const log = makeLog();
    validateConfig(config, log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("never throws", () => {
    const config = resolveLcmConfig({}, {});
    // Set all values to bad states
    (config as Record<string, unknown>).harvestEveryNTurns = -100;
    (config as Record<string, unknown>).harvestLookbackTurns = -100;
    (config as Record<string, unknown>).episodeRetentionDays = -100;
    (config as Record<string, unknown>).contextThreshold = -100;
    (config as Record<string, unknown>).freshTailCount = -100;
    (config as Record<string, unknown>).vaultSyncIntervalHours = -100;
    (config as Record<string, unknown>).vectorDimensions = -100;
    (config as Record<string, unknown>).databasePath = "";
    (config as Record<string, unknown>).vaultEnabled = true;
    (config as Record<string, unknown>).vaultPath = "";
    const log = makeLog();
    // Should not throw
    expect(() => validateConfig(config, log)).not.toThrow();
    // But should have warned many times
    expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(8);
  });
});
