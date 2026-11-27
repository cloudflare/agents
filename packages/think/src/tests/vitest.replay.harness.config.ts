/**
 * The recorded-webhook replay against the harness-backed Think: the replay
 * config with the harness config's swap of `../think` (see
 * `vitest.harness.config.ts`).
 */
import { mergeConfig } from "vitest/config";
import harness from "./vitest.harness.config";
import replay from "./vitest.replay.config";

export default mergeConfig(replay, {
  plugins: harness.plugins?.filter(
    (plugin: unknown) =>
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      plugin.name === "think-harness-compat"
  ),
  test: { name: "workers-replay-harness" }
});
