import { describe, expect, it } from "vitest";
import {
  activationRolloutFraction,
  isActivationModelEnabledForSeed,
  resolveHygieneTieringMode,
} from "../src/memory/activation-rollout.js";

describe("activation-rollout", () => {
  it("keeps rollout disabled by default", () => {
    expect(activationRolloutFraction({ activationModelRolloutFraction: 0 })).toBe(0);
    expect(isActivationModelEnabledForSeed({
      activationModelEnabled: false,
      activationModelRolloutFraction: 1,
    }, "seed")).toBe(false);
  });

  it("enables all seeds at rollout fraction 1", () => {
    expect(isActivationModelEnabledForSeed({
      activationModelEnabled: true,
      activationModelRolloutFraction: 1,
    }, "seed-a")).toBe(true);
    expect(isActivationModelEnabledForSeed({
      activationModelEnabled: true,
      activationModelRolloutFraction: 1,
    }, "seed-b")).toBe(true);
  });

  it("is deterministic for partial rollout", () => {
    const config = {
      activationModelEnabled: true,
      activationModelRolloutFraction: 0.35,
    };
    const first = isActivationModelEnabledForSeed(config, "memory-123");
    const second = isActivationModelEnabledForSeed(config, "memory-123");
    expect(first).toBe(second);
  });

  it("resolves hygiene tiering mode from config", () => {
    expect(resolveHygieneTieringMode({
      hygieneTieringEnabled: false,
      hygieneTieringMode: "enforce",
    })).toBe("off");
    expect(resolveHygieneTieringMode({
      hygieneTieringEnabled: true,
      hygieneTieringMode: "observe",
    })).toBe("observe");
    expect(resolveHygieneTieringMode({
      hygieneTieringEnabled: true,
      hygieneTieringMode: "enforce",
    })).toBe("enforce");
  });
});
