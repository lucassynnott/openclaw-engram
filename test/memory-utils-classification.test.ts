import { describe, expect, it } from "vitest";
import {
  VALID_KINDS,
  classifyValue,
  inferKind,
} from "../src/memory/memory-utils.js";

describe("memory-utils OBSERVATION kind support", () => {
  it("includes OBSERVATION in valid kinds", () => {
    expect(VALID_KINDS).toContain("OBSERVATION");
  });

  it("infers OBSERVATION when content is explicitly observational", () => {
    expect(inferKind("I noticed the CI queue looks backed up this afternoon")).toBe("OBSERVATION");
    expect(inferKind("It seems the API latency is climbing for now")).toBe("OBSERVATION");
  });

  it("keeps stronger kind signals ahead of observational cues", () => {
    expect(inferKind("I noticed the user prefers dark mode in all editors")).toBe("PREFERENCE");
    expect(inferKind("We decided to keep this rollout paused for now")).toBe("DECISION");
  });

  it("still infers EPISODE for temporal events without observation markers", () => {
    expect(inferKind("Yesterday we shipped the migration to production")).toBe("EPISODE");
  });

  it("still infers USER_FACT for durable factual statements", () => {
    expect(inferKind("Lucas works at Applied Leverage as founder")).toBe("USER_FACT");
  });
});

describe("memory-utils OBSERVATION value classification", () => {
  it("keeps observation snapshots but scores them lower than equivalent user facts", () => {
    const content = "I noticed the deployment queue is longer than usual";
    const observation = classifyValue(content, "OBSERVATION", 0.75);
    const fact = classifyValue(content, "USER_FACT", 0.75);

    expect(observation.action).toBe("keep");
    expect(observation.value_label).toBe("situational");
    expect(observation.reason_codes).toContain("observational_signal");
    expect(observation.value_score).toBeLessThan(fact.value_score);
  });
});
