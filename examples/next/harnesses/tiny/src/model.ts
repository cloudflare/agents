/**
 * Model access through the AI Gateway binding.
 *
 * A naive version passes `"anthropic/claude-haiku-4-5"` as a string and relies on
 * `AI_GATEWAY_API_KEY` in the environment. Here the `AI` binding *is* the
 * credential: no key enters the isolate, and model-authored code in a Dynamic
 * Worker can never read one. The gateway gives per-agent spend tracking and
 * one bill across Workers AI and third-party catalog ids.
 */
import { createCloudflareText } from "@tanstack/ai-cloudflare";
// The *module* type, not the ambient global of the same name: the adapter's
// `binding` option is typed with this one, and TypeScript treats the two
// declarations as unrelated even at identical package versions.
import type { Ai } from "@cloudflare/workers-types";
import type { HarnessRole } from "./protocol";

/** Roles that need a model, including the compaction summarizer. */
export type ModelRole = HarnessRole | "compact";

/**
 * One model per role — a model picked per job, as catalog ids.
 *
 * A `@cf/...` id runs on Workers AI. A `provider/model` id runs the
 * third-party model billed through Cloudflare, so switching `lead` between
 * the two is a one-line change and both land in the same gateway logs.
 */
export const MODELS: Record<ModelRole, string> = {
  /**
   * Plans, delegates, and answers.
   *
   * A Workers AI id by default so the example runs on a fresh account with
   * nothing but the `AI` binding. A third-party catalog id like
   * `anthropic/claude-sonnet-4-5` also works and is the better choice for
   * hard tasks, but only once that provider's key is configured in the
   * gateway — otherwise every turn fails with a bare
   * "Model execution failed", which is a miserable first run. Override with
   * MODEL_LEAD once you have provider keys set up.
   */
  lead: "@cf/zai-org/glm-5.3",
  /** Read-only exploration. Cheap and fast; it only has to find things. */
  explorer: "@cf/zai-org/glm-5.3-flash",
  /** Summarizes compacted transcript spans. Never user-facing. */
  compact: "@cf/zai-org/glm-5.3-flash"
};

export type ModelEnv = {
  readonly AI: Ai;
  readonly GATEWAY_ID?: string;
  readonly MODEL_LEAD?: string;
};

/**
 * Build the per-role adapter map the harness takes as an option.
 *
 * Gateway response caching is disabled. Tasks already journals successful
 * model steps, while replaying a cached failure makes every retry identical.
 */
export function harnessModels(env: ModelEnv) {
  const gateway = {
    id: env.GATEWAY_ID ?? "default",
    skipCache: true,
    collectLog: true
  } as const;
  const adapter = (model: string) =>
    createCloudflareText(model, { binding: env.AI, gateway });

  return {
    // An override lets you point the lead at a different model without a
    // code change, which is how you A/B a harness.
    lead: adapter(env.MODEL_LEAD ?? MODELS.lead),
    explorer: adapter(MODELS.explorer),
    compact: adapter(MODELS.compact)
  };
}

export type HarnessModels = ReturnType<typeof harnessModels>;
