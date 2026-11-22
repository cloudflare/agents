/**
 * Resolves a `ThinkModel` (a model id string or a `LanguageModel`) into a
 * `LanguageModel` through the bundled `workers-ai-provider`.
 */

import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic } from "workers-ai-provider/anthropic";
import { openai } from "workers-ai-provider/openai";
import type { ThinkModel } from "./turn-types";

const WORKERS_AI_MODEL_PREFIXES = ["@cf/", "@hf/"];

/** Whether `model` is a Workers AI id (`@cf/...` or `@hf/...`). */
export function isWorkersAIModelId(model: string): boolean {
  return WORKERS_AI_MODEL_PREFIXES.some(
    (prefix) => model.startsWith(prefix) && model.length > prefix.length
  );
}

/** What a {@link ThinkModelResolver} reads from its agent. */
export interface ThinkModelResolverOptions {
  /** The Workers AI binding. Read once, when the first string model resolves. */
  readonly binding: () => Ai;
  /** AI Gateway options for a string model. Must return synchronously. */
  readonly gateway: (model: string) => GatewayOptions | undefined;
  /** Session affinity for Workers AI ids. */
  readonly sessionAffinity: () => string;
}

/**
 * Builds models through one default provider per agent. The provider is
 * created on first use and cached, which assumes the binding is stable for
 * the lifetime of the agent.
 */
export class ThinkModelResolver {
  readonly #options: ThinkModelResolverOptions;
  #provider?: ReturnType<typeof createWorkersAI>;

  constructor(options: ThinkModelResolverOptions) {
    this.#options = options;
  }

  /**
   * Return `model` as a `LanguageModel`. A `LanguageModel` is returned as-is.
   * A string must be a Workers AI id or a `"<provider>/<model>"` AI Gateway
   * slug.
   */
  resolve(model: ThinkModel): LanguageModel {
    if (typeof model !== "string") return model;
    // The provider sends every `@...` id straight to `env.AI.run(model)`, so a
    // malformed one would only fail at inference time.
    const isWorkersAI = isWorkersAIModelId(model);
    const slash = model.indexOf("/");
    if (
      !isWorkersAI &&
      (model.startsWith("@") || slash <= 0 || slash === model.length - 1)
    ) {
      throw new Error(
        `Invalid model id ${JSON.stringify(model)}. Use a Workers AI id ` +
          '(e.g. "@cf/deepseek-ai/deepseek-v4.1-flash-1017") or a "<provider>/<model>" ' +
          'AI Gateway slug (e.g. "openai/gpt-5.5"), or return a LanguageModel.'
      );
    }
    const gateway = this.#options.gateway(model);
    if (
      gateway !== null &&
      typeof gateway === "object" &&
      typeof (gateway as { then?: unknown }).then === "function"
    ) {
      throw new Error(
        `getGateway() returned a Promise for model "${model}". It must return ` +
          "GatewayOptions (or undefined) synchronously; resolve any async " +
          "lookup in beforeTurn and return the model from there instead."
      );
    }
    // The bundled `openai` and `anthropic` wire formats let a
    // `"<provider>/<model>"` slug route through AI Gateway (OpenAI, Anthropic,
    // Google, xAI, Groq and the OpenAI-compatible long tail).
    this.#provider ??= createWorkersAI({
      binding: this.#options.binding(),
      providers: [openai, anthropic]
    });
    // Workers AI ids take Workers AI chat settings (sessionAffinity improves
    // prefix-cache hits). Any other slug is a catalog model routed through AI
    // Gateway; we pass no other per-call settings, which avoids forcing
    // options a given provider/transport would reject.
    return isWorkersAI
      ? this.#provider(model, {
          sessionAffinity: this.#options.sessionAffinity(),
          ...(gateway && { gateway })
        })
      : this.#provider(model, gateway && { gateway });
  }
}
