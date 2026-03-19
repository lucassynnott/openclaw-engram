import { resolveLcmConfig, type LcmConfig } from "../src/db/config.js";

export function makeTestConfig(
  overrides: Partial<LcmConfig> & Record<string, unknown> = {},
): LcmConfig {
  return resolveLcmConfig({}, overrides);
}
