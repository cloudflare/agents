/**
 * `agents/models/opencode` — Cloudflare's models as an OpenCode provider, with
 * the same shape as `agents/models/ai-sdk` and `agents/models/pi-ai`.
 *
 * ```ts
 * import { createAI } from "agents/models/opencode";
 * import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
 *
 * const ai = createAI({ binding: env.AI });
 *
 * const model = ai("@cf/moonshotai/kimi-k2.7-code"); // { providerID, id }
 * ai("anthropic/claude-opus-4.8"); // an AI Gateway catalog model
 * await OpenCodeWorkerd.create({ storage, plugins: [ai.plugin] });
 * ```
 *
 * `ai.plugin` is an OpenCode plugin. It adds a `cloudflare` provider whose
 * models are the ids you have called `ai(id)` with — Workers AI ids, AI
 * Gateway catalog ids and dynamic routes — and answers OpenCode's AI SDK hook
 * with `agents/models/ai-sdk`'s models, so requests go through the `AI`
 * binding on `env.AI.run`: no account id, API token, or HTTP route in your
 * Worker, and nothing patched globally. Catalog streams resume after a
 * dropped connection, as they do in `agents/models/ai-sdk`.
 *
 * @experimental The surface may change in any release.
 *
 * @module
 */

import { Model, Provider, type Plugin } from "@opencode/plugin";
import type { AISettings } from "../core/settings";
import {
  createAI as createAISDK,
  type CloudflareLanguageModelId,
  type ModelOptions
} from "../ai-sdk";
import { asLanguageModelV3 } from "./language-v3";

export type {
  CatalogModelId,
  DynamicRouteId,
  WorkersAIModelId
} from "../core/catalog";
export type { AISettings, GatewayOptions } from "../core/settings";
export type { CloudflareLanguageModelId, ModelOptions } from "../ai-sdk";

/** The OpenCode provider id `createAI`'s plugin registers. */
export const CLOUDFLARE_PROVIDER_ID = "cloudflare";

/**
 * The AI SDK package OpenCode is told the provider uses. OpenCode builds an
 * AI SDK model in two hook steps: `sdk` (load the package) and `language`
 * (make the model). Its `sdk` step can only load packages it bundles; any
 * other is handed to an npm installer that cannot run in workerd, and an
 * external plugin's `sdk` hook runs after that installer. So the provider
 * names `@ai-sdk/vercel`, which OpenCode bundles and loads in-process, and
 * this plugin's `language` hook replaces the model it would make. The
 * Vercel client is built but never called: its base URL does not resolve.
 */
const CARRIER_PACKAGE = "aisdk:@ai-sdk/vercel";
const UNREACHABLE_BASE_URL = "https://workers-ai.binding.invalid/v1";

/**
 * A model as OpenCode references one: pass it to `OpenCodeHarness`'s
 * `defaults.model`, `session.setModel`, or OpenCode's `sessions.switchModel`.
 */
export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
};

/** How OpenCode budgets a model's context. */
export type OpenCodeModelLimit = {
  /** Context window, in tokens. Default 128_000. */
  readonly context: number;
  /** Most tokens OpenCode asks the model to generate. Default 8_192. */
  readonly output: number;
};

/** Options for one model: `agents/models/ai-sdk`'s, plus OpenCode's limit. */
export type OpenCodeModelOptions = ModelOptions & {
  readonly limit?: OpenCodeModelLimit;
};

const DEFAULT_LIMIT: OpenCodeModelLimit = { context: 128_000, output: 8_192 };

/**
 * The provider `createAI` returns. Call it with a model id — a Workers AI id,
 * an AI Gateway catalog id, or a dynamic route — to register the model with
 * the plugin and get OpenCode's reference to it.
 */
export interface AI {
  /** A model, registered with the plugin. */
  (
    modelId: CloudflareLanguageModelId,
    options?: OpenCodeModelOptions
  ): OpenCodeModel;
  /** Same as calling the provider directly. */
  model(
    modelId: CloudflareLanguageModelId,
    options?: OpenCodeModelOptions
  ): OpenCodeModel;
  /** The OpenCode plugin. Pass it in `OpenCodeWorkerd.create({ plugins })`. */
  readonly plugin: Plugin.Plugin;
}

/**
 * Create Cloudflare's model provider for OpenCode.
 *
 * @param settings - The `AI` binding and gateway defaults, as for
 *   `agents/models/ai-sdk`.
 * @returns The provider: call it with model ids; register `plugin`.
 */
export function createAI(settings: AISettings): AI {
  const aiSdk = createAISDK(settings);
  const models = new Map<string, OpenCodeModelOptions | undefined>();
  /** One reload per OpenCode instance the plugin is set up in. */
  const reloads = new Set<() => Promise<void>>();
  const providerID = Provider.ID.make(CLOUDFLARE_PROVIDER_ID);

  const info = (id: string, options: OpenCodeModelOptions | undefined) => {
    const defaults = Model.Info.default(providerID, Model.ID.make(id));
    return {
      ...defaults,
      package: CARRIER_PACKAGE,
      limit: options?.limit ?? DEFAULT_LIMIT
    };
  };

  const plugin: Plugin.Plugin = {
    id: "agents.models.opencode",
    async setup(ctx) {
      const transform = await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            id: providerID,
            name: "Cloudflare",
            activation: "enabled",
            package: CARRIER_PACKAGE,
            settings: { baseURL: UNREACHABLE_BASE_URL, apiKey: "binding" }
          },
          models: [...models].map(([id, options]) => info(id, options))
        });
      });
      const hook = await ctx.aisdk.hook(
        "language",
        (event) => {
          const id = event.model.modelID ?? event.model.id;
          event.language = asLanguageModelV3(
            aiSdk.languageModel(id, models.get(id))
          );
        },
        { providerID }
      );
      const reload = () => ctx.provider.reload();
      reloads.add(reload);
      return async () => {
        reloads.delete(reload);
        await hook.dispose();
        await transform.dispose();
      };
    }
  };

  const model = (
    modelId: CloudflareLanguageModelId,
    options?: OpenCodeModelOptions
  ): OpenCodeModel => {
    // The same gate `agents/models/ai-sdk` applies, at the line that named the
    // model rather than at OpenCode's first request.
    aiSdk.languageModel(modelId, options);
    const changed =
      !models.has(modelId) ||
      JSON.stringify(models.get(modelId)?.limit) !==
        JSON.stringify(options?.limit);
    models.set(modelId, options);
    // A model named, or its limit changed, after OpenCode started: rebuild
    // the provider's model list.
    if (changed) {
      for (const reload of reloads) {
        reload().catch((error: unknown) => {
          console.warn("agents/models/opencode: provider reload failed", error);
        });
      }
    }
    return { providerID: CLOUDFLARE_PROVIDER_ID, id: modelId };
  };

  return Object.assign(model, { model, plugin });
}
