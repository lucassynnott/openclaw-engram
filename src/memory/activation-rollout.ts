import { createHash } from "node:crypto";
import type { LcmConfig } from "../db/config.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeSeed(seed: string): string {
  const normalized = String(seed || "").trim();
  return normalized || "global";
}

function rolloutBucket(seed: string): number {
  const digest = createHash("sha1").update(normalizeSeed(seed)).digest();
  const bucket = digest.readUInt32BE(0);
  return bucket / 0x1_0000_0000;
}

export function activationRolloutFraction(config?: Pick<LcmConfig, "activationModelRolloutFraction">): number {
  return clamp01(Number(config?.activationModelRolloutFraction ?? 0));
}

export function isActivationModelEnabledForSeed(
  config?: Pick<LcmConfig, "activationModelEnabled" | "activationModelRolloutFraction">,
  seed = "global",
): boolean {
  if (!config?.activationModelEnabled) {
    return false;
  }
  const fraction = activationRolloutFraction(config);
  if (fraction <= 0) {
    return false;
  }
  if (fraction >= 1) {
    return true;
  }
  return rolloutBucket(seed) < fraction;
}

export function resolveHygieneTieringMode(
  config?: Pick<LcmConfig, "hygieneTieringEnabled" | "hygieneTieringMode">,
): "off" | "observe" | "enforce" {
  if (!config?.hygieneTieringEnabled) {
    return "off";
  }
  const mode = String(config.hygieneTieringMode || "observe").trim().toLowerCase();
  if (mode === "enforce") return "enforce";
  if (mode === "observe") return "observe";
  return "off";
}
