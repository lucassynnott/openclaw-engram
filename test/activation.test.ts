import { describe, expect, it } from "vitest";
import {
  applyActivationEvent,
  computeActivationStrength,
  computeDecayFactor,
  computeReinforcementWeight,
  initializeActivationState,
  type ActivationState,
} from "../src/memory/activation.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("computeDecayFactor", () => {
  it("returns 1 when elapsed time is zero or negative", () => {
    expect(computeDecayFactor(0, 0)).toBe(1);
    expect(computeDecayFactor(-100, 3)).toBe(1);
  });

  it("decays slower when reinforcement count is higher", () => {
    const elapsed = 3 * DAY_MS;
    const unreinforced = computeDecayFactor(elapsed, 0);
    const reinforced = computeDecayFactor(elapsed, 8);

    expect(reinforced).toBeGreaterThan(unreinforced);
    expect(unreinforced).toBeLessThan(1);
    expect(reinforced).toBeLessThan(1);
  });
});

describe("computeReinforcementWeight", () => {
  it("uses stronger defaults for capture than retrieval/review", () => {
    const capture = computeReinforcementWeight("capture", 0);
    const retrieval = computeReinforcementWeight("retrieval", 0);
    const review = computeReinforcementWeight("review", 0);

    expect(capture).toBeGreaterThan(retrieval);
    expect(retrieval).toBeGreaterThan(review);
  });

  it("applies diminishing returns as reinforcement count grows", () => {
    const early = computeReinforcementWeight("retrieval", 0);
    const late = computeReinforcementWeight("retrieval", 10);
    expect(late).toBeLessThan(early);
  });
});

describe("computeActivationStrength", () => {
  it("projects activation down over time", () => {
    const now = Date.UTC(2026, 0, 8);
    const last = now - 3 * DAY_MS;
    const strength = computeActivationStrength({
      activation: 0.8,
      reinforcementCount: 0,
      lastReinforcedAtMs: last,
      nowMs: now,
    });

    expect(strength).toBeGreaterThan(0);
    expect(strength).toBeLessThan(0.8);
  });

  it("retains more activation for reinforced memories", () => {
    const now = Date.UTC(2026, 0, 8);
    const last = now - 3 * DAY_MS;
    const weak = computeActivationStrength({
      activation: 0.8,
      reinforcementCount: 0,
      lastReinforcedAtMs: last,
      nowMs: now,
    });
    const reinforced = computeActivationStrength({
      activation: 0.8,
      reinforcementCount: 8,
      lastReinforcedAtMs: last,
      nowMs: now,
    });

    expect(reinforced).toBeGreaterThan(weak);
  });
});

describe("applyActivationEvent", () => {
  it("increments reinforcement count and increases projected activation", () => {
    const start = Date.UTC(2026, 0, 1);
    const initial = initializeActivationState(start);
    const decayedBeforeEvent = computeActivationStrength({
      ...initial,
      nowMs: start + DAY_MS,
    });

    const next = applyActivationEvent(initial, {
      type: "retrieval",
      atMs: start + DAY_MS,
    });

    expect(next.reinforcementCount).toBe(initial.reinforcementCount + 1);
    expect(next.activation).toBeGreaterThan(decayedBeforeEvent);
    expect(next.lastReinforcedAtMs).toBe(start + DAY_MS);
  });

  it("builds slower long-term decay after repeated reinforcement", () => {
    const start = Date.UTC(2026, 0, 1);
    const checkAt = start + 7 * DAY_MS;

    const single = applyActivationEvent(undefined, { type: "capture", atMs: start });

    let repeated: ActivationState = applyActivationEvent(undefined, { type: "capture", atMs: start });
    repeated = applyActivationEvent(repeated, { type: "retrieval", atMs: start + DAY_MS });
    repeated = applyActivationEvent(repeated, { type: "review", atMs: start + 2 * DAY_MS });
    repeated = applyActivationEvent(repeated, { type: "retrieval", atMs: start + 3 * DAY_MS });

    const singleStrength = computeActivationStrength({ ...single, nowMs: checkAt });
    const repeatedStrength = computeActivationStrength({ ...repeated, nowMs: checkAt });

    expect(repeated.reinforcementCount).toBeGreaterThan(single.reinforcementCount);
    expect(repeatedStrength).toBeGreaterThan(singleStrength);
  });

  it("keeps confidence separate from activation updates", () => {
    const memory = {
      confidence: 0.34,
      activation: initializeActivationState(Date.UTC(2026, 0, 1)),
    };

    const updatedActivation = applyActivationEvent(memory.activation, {
      type: "review",
      atMs: Date.UTC(2026, 0, 2),
    });
    const nextMemory = {
      ...memory,
      activation: updatedActivation,
    };

    expect(nextMemory.confidence).toBe(0.34);
    expect("confidence" in (updatedActivation as Record<string, unknown>)).toBe(false);
  });
});
