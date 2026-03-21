/**
 * Tests for the vault-sync periodic service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultSyncService } from "../src/services/vault-sync-service.js";
import { makeTestConfig } from "./test-config.js";

// Mock buildVaultSurface so we don't need a real database
vi.mock("../src/surface/vault-mirror.js", () => ({
  buildVaultSurface: vi.fn(() => ({
    conversation_count: 3,
    copied_files: 5,
    removed_files: 1,
    skipped_unchanged: 2,
  })),
}));

import { buildVaultSurface } from "../src/surface/vault-mirror.js";

const mockedBuild = vi.mocked(buildVaultSurface);

function createTestLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("vault-sync-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedBuild.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs vault sync immediately on start when vault is enabled", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 24,
    });

    const service = createVaultSyncService({ config, logger });
    service.start();

    expect(mockedBuild).toHaveBeenCalledTimes(1);
    expect(mockedBuild).toHaveBeenCalledWith(
      expect.objectContaining({ config, dryRun: false }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("build completed"),
    );

    service.stop();
  });

  it("repeats vault sync after the configured interval", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 12,
    });

    const service = createVaultSyncService({ config, logger });
    service.start();

    // Initial run
    expect(mockedBuild).toHaveBeenCalledTimes(1);

    // Advance 12 hours
    vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    expect(mockedBuild).toHaveBeenCalledTimes(2);

    // Advance another 12 hours
    vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    expect(mockedBuild).toHaveBeenCalledTimes(3);

    service.stop();
  });

  it("skips when vault is not enabled", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: false,
      vaultSyncIntervalHours: 24,
    });

    const service = createVaultSyncService({ config, logger });
    service.start();

    expect(mockedBuild).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("vault not enabled"),
    );

    service.stop();
  });

  it("skips when interval is 0 (explicitly disabled)", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 0,
    });

    const service = createVaultSyncService({ config, logger });
    service.start();

    expect(mockedBuild).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("disabled (interval=0)"),
    );

    service.stop();
  });

  it("is idempotent — calling start twice does not create duplicate timers", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 1,
    });

    const service = createVaultSyncService({ config, logger });
    service.start();
    service.start(); // second call should be a no-op

    // Only one immediate build should have run
    expect(mockedBuild).toHaveBeenCalledTimes(1);

    // Advance 1 hour - only one timer should fire
    vi.advanceTimersByTime(1 * 60 * 60 * 1000);
    expect(mockedBuild).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("catches and logs build errors without crashing", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 24,
    });

    mockedBuild.mockImplementationOnce(() => {
      throw new Error("database locked");
    });

    const service = createVaultSyncService({ config, logger });

    // Should not throw
    expect(() => service.start()).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("build failed"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("database locked"),
    );

    service.stop();
  });

  it("stops the interval timer on stop()", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 1,
    });

    const service = createVaultSyncService({ config, logger });
    service.start();

    expect(mockedBuild).toHaveBeenCalledTimes(1);

    service.stop();

    // Advance time — no more builds should fire
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(mockedBuild).toHaveBeenCalledTimes(1);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("stopped automatic vault sync"),
    );
  });

  it("stop() is safe to call when not started", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
      vaultSyncIntervalHours: 24,
    });

    const service = createVaultSyncService({ config, logger });

    // Should not throw
    expect(() => service.stop()).not.toThrow();
  });

  it("has service id 'engram-vault-sync'", () => {
    const logger = createTestLogger();
    const config = makeTestConfig({ vaultEnabled: true });

    const service = createVaultSyncService({ config, logger });
    expect(service.id).toBe("engram-vault-sync");
  });

  it("uses the default 24-hour interval from config", () => {
    const logger = createTestLogger();
    // Don't override vaultSyncIntervalHours — should use default 24
    const config = makeTestConfig({
      vaultEnabled: true,
      vaultPath: "/tmp/test-vault",
    });

    expect(config.vaultSyncIntervalHours).toBe(24);

    const service = createVaultSyncService({ config, logger });
    service.start();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("every 24h"),
    );

    service.stop();
  });
});
