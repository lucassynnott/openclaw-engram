const DAY_MS = 24 * 60 * 60 * 1000;
const LN_2 = Math.log(2);

export type ActivationEventType = "capture" | "retrieval" | "review";

export type ActivationState = {
  /**
   * Activation strength anchored to `lastReinforcedAtMs` in [0, 1].
   * Use `computeActivationStrength` to project it forward in time.
   */
  activation: number;
  /** Number of reinforcement events applied so far. */
  reinforcementCount: number;
  /** Timestamp of the latest reinforcement event. */
  lastReinforcedAtMs: number;
};

export type ActivationEvent = {
  type: ActivationEventType;
  atMs: number;
  /**
   * Optional event intensity multiplier in [0, 1].
   * Useful for weighting weak vs strong retrieval/review hits.
   */
  intensity?: number;
};

export type ActivationModelOptions = {
  /**
   * Base forgetting half-life for unreinforced memories.
   */
  halfLifeMs: number;
  /**
   * How strongly reinforcements increase effective half-life.
   * Effective half-life uses: `halfLifeMs * (1 + reinforcementDecayBoost * ln(1 + count))`.
   */
  reinforcementDecayBoost: number;
  /**
   * Base reinforcement impact per event type before diminishing returns.
   */
  eventWeights: Readonly<Record<ActivationEventType, number>>;
  /**
   * Diminishing-returns slope for repeated reinforcement.
   */
  reinforcementDiminishingSlope: number;
  /**
   * Initial activation baseline for new memories.
   */
  initialActivation: number;
};

export type ActivationModelOverrides =
  Partial<Omit<ActivationModelOptions, "eventWeights">> & {
    eventWeights?: Partial<Record<ActivationEventType, number>>;
  };

export type ComputeActivationStrengthInput = {
  activation: number;
  reinforcementCount: number;
  lastReinforcedAtMs: number;
  nowMs: number;
};

export const DEFAULT_ACTIVATION_MODEL_OPTIONS: ActivationModelOptions = {
  halfLifeMs: 3 * DAY_MS,
  reinforcementDecayBoost: 0.45,
  eventWeights: {
    capture: 0.42,
    retrieval: 0.2,
    review: 0.12,
  },
  reinforcementDiminishingSlope: 0.16,
  initialActivation: 0.55,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sanitizePositive(value: number | undefined, fallback: number, min: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Number(value));
}

function sanitizeTimestampMs(value: number): number {
  if (!Number.isFinite(value)) {
    return Date.now();
  }
  return Math.trunc(value);
}

function resolveModelOptions(overrides?: ActivationModelOverrides): ActivationModelOptions {
  const mergedEventWeights: Record<ActivationEventType, number> = {
    capture: clamp01(overrides?.eventWeights?.capture ?? DEFAULT_ACTIVATION_MODEL_OPTIONS.eventWeights.capture),
    retrieval: clamp01(overrides?.eventWeights?.retrieval ?? DEFAULT_ACTIVATION_MODEL_OPTIONS.eventWeights.retrieval),
    review: clamp01(overrides?.eventWeights?.review ?? DEFAULT_ACTIVATION_MODEL_OPTIONS.eventWeights.review),
  };

  return {
    halfLifeMs: sanitizePositive(
      overrides?.halfLifeMs,
      DEFAULT_ACTIVATION_MODEL_OPTIONS.halfLifeMs,
      1,
    ),
    reinforcementDecayBoost: sanitizePositive(
      overrides?.reinforcementDecayBoost,
      DEFAULT_ACTIVATION_MODEL_OPTIONS.reinforcementDecayBoost,
      0,
    ),
    eventWeights: mergedEventWeights,
    reinforcementDiminishingSlope: sanitizePositive(
      overrides?.reinforcementDiminishingSlope,
      DEFAULT_ACTIVATION_MODEL_OPTIONS.reinforcementDiminishingSlope,
      0,
    ),
    initialActivation: clamp01(
      overrides?.initialActivation ?? DEFAULT_ACTIVATION_MODEL_OPTIONS.initialActivation,
    ),
  };
}

/**
 * Exponential decay multiplier in [0, 1], with slower decay as reinforcement grows.
 */
export function computeDecayFactor(
  elapsedMs: number,
  reinforcementCount: number,
  overrides?: ActivationModelOverrides,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;

  const options = resolveModelOptions(overrides);
  const safeReinforcementCount = Math.max(0, Math.floor(reinforcementCount));
  const effectiveHalfLife =
    options.halfLifeMs * (1 + options.reinforcementDecayBoost * Math.log1p(safeReinforcementCount));

  const decayExponent = -(LN_2 * elapsedMs) / Math.max(1, effectiveHalfLife);
  return clamp01(Math.exp(decayExponent));
}

/**
 * Diminishing reinforcement contribution for a new event.
 */
export function computeReinforcementWeight(
  eventType: ActivationEventType,
  reinforcementCount: number,
  overrides?: ActivationModelOverrides,
): number {
  const options = resolveModelOptions(overrides);
  const safeReinforcementCount = Math.max(0, Math.floor(reinforcementCount));
  const baseWeight = options.eventWeights[eventType];
  const diminishingMultiplier =
    1 / (1 + safeReinforcementCount * options.reinforcementDiminishingSlope);

  return clamp01(baseWeight * diminishingMultiplier);
}

/**
 * Project activation strength to `nowMs` without mutating state.
 */
export function computeActivationStrength(
  input: ComputeActivationStrengthInput,
  overrides?: ActivationModelOverrides,
): number {
  const nowMs = sanitizeTimestampMs(input.nowMs);
  const lastReinforcedAtMs = sanitizeTimestampMs(input.lastReinforcedAtMs);
  const elapsedMs = Math.max(0, nowMs - lastReinforcedAtMs);
  const decay = computeDecayFactor(elapsedMs, input.reinforcementCount, overrides);

  return clamp01(input.activation) * decay;
}

/**
 * Build a fresh activation state at capture time.
 */
export function initializeActivationState(
  capturedAtMs: number,
  overrides?: ActivationModelOverrides,
): ActivationState {
  const options = resolveModelOptions(overrides);
  return {
    activation: options.initialActivation,
    reinforcementCount: 0,
    lastReinforcedAtMs: sanitizeTimestampMs(capturedAtMs),
  };
}

/**
 * Apply one reinforcement event and return the next activation state.
 *
 * This function intentionally updates activation-only fields; confidence/truth
 * should be managed by separate evidence pipelines.
 */
export function applyActivationEvent(
  state: ActivationState | null | undefined,
  event: ActivationEvent,
  overrides?: ActivationModelOverrides,
): ActivationState {
  const options = resolveModelOptions(overrides);
  const prior = state ?? initializeActivationState(event.atMs, options);
  const eventAtMs = Math.max(
    sanitizeTimestampMs(event.atMs),
    sanitizeTimestampMs(prior.lastReinforcedAtMs),
  );

  const projected = computeActivationStrength(
    {
      activation: prior.activation,
      reinforcementCount: prior.reinforcementCount,
      lastReinforcedAtMs: prior.lastReinforcedAtMs,
      nowMs: eventAtMs,
    },
    options,
  );
  const eventWeight =
    computeReinforcementWeight(event.type, prior.reinforcementCount, options) *
    clamp01(event.intensity ?? 1);

  const nextActivation = clamp01(projected + (1 - projected) * eventWeight);

  return {
    activation: nextActivation,
    reinforcementCount: prior.reinforcementCount + 1,
    lastReinforcedAtMs: eventAtMs,
  };
}
