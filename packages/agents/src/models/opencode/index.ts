/**
 * `agents/models/opencode` — Workers AI as an OpenCode provider, over the AI
 * binding, with the same shape as `agents/models/pi-ai`.
 *
 * ```ts
 * import { createAI } from "agents/models/opencode";
 *
 * const ai = createAI({ binding: env.AI });
 *
 * new OpenCodeHarness({
 *   streams,
 *   providers: [ai.provider],
 *   defaults: { model: ai("@cf/moonshotai/kimi-k2.7-code") }
 * });
 * ```
 *
 * OpenCode ships a Cloudflare Workers AI provider of its own, with the
 * Workers AI catalog. It speaks Workers AI's OpenAI-compatible REST API, and
 * so wants an account id and an API token. This module keeps that provider
 * and its catalog and changes only where its requests go: to a base URL that
 * resolves to the binding, so the model runs on `env.AI.run` with no token
 * and no account id.
 *
 * OpenCode's embedded SDK has no per-provider `fetch` on that path, and its
 * HTTP client keeps the global `fetch` it first boots with. So the redirect
 * is a `fetch` wrapper, installed when this module loads, that answers only
 * for its own reserved host and passes every other request through
 * unchanged.
 *
 * @beta Everything exported here is in beta: the surface may change in a
 * minor release while the design settles.
 *
 * @module
 */

import type { Plugin } from "@opencode/plugin";
import type { WorkersAIModelId } from "../core/catalog";
import { CloudflareAIError } from "../core/errors";
import { resolveOptions, type AISettings } from "../core/settings";
import { createTransport, type Transport } from "../core/transport";

export type { WorkersAIModelId } from "../core/catalog";
export type { AISettings, GatewayOptions } from "../core/settings";

/** OpenCode's own id for its Workers AI provider, whose catalog this keeps. */
export const CLOUDFLARE_PROVIDER_ID = "cloudflare-workers-ai";

/** OpenCode's bundled Workers AI provider package. */
const PROVIDER_PACKAGE = "@opencode/ai/providers/cloudflare-workers-ai";

/** Reserved for the binding: `.invalid` never resolves on the network. */
const BINDING_HOST = "workers-ai.binding.invalid";

/** Output cap for the model entry this module writes. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * A model, as OpenCode refers to one: its provider and its id. `ai(id)`
 * returns one; the harness sets it as a session's model.
 *
 * @beta This surface is in beta and may change.
 */
export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
};

/**
 * An OpenCode provider: the `providers` config entry that declares it and
 * the plugin that serves it. Pass it to `OpenCodeHarness({ providers })`.
 *
 * @beta This surface is in beta and may change.
 */
export type OpenCodeProvider = {
  readonly id: string;
  /** The entry under OpenCode's `providers` config, keyed by `id`. */
  readonly config: Record<string, unknown>;
  readonly plugin: Plugin.Plugin;
};

/**
 * Per-provider options for {@link createAI}, beyond the gateway settings.
 *
 * @beta This surface is in beta and may change.
 */
export type OpenCodeAISettings = AISettings & {
  /** Output cap for models asked for through `ai(id)`. Default 4096. */
  readonly maxTokens?: number;
};

/**
 * The provider `createAI` returns. Call it with a Workers AI id to get a
 * model reference, and give `provider` to the harness.
 *
 * @beta This surface is in beta and may change.
 */
export interface AI {
  (modelId: WorkersAIModelId | (string & {})): OpenCodeModel;
  /** Same as calling the provider directly. */
  model(modelId: WorkersAIModelId | (string & {})): OpenCodeModel;
  /** The provider config and plugin, for `OpenCodeHarness({ providers })`. */
  readonly provider: OpenCodeProvider;
}

/** One provider's binding, by the route id in its base URL. */
type Route = {
  readonly transport: Transport;
  readonly settings: AISettings;
};

const routes = new Map<string, Route>();
let installed = false;

// On import, not on first use: OpenCode's HTTP client keeps the `fetch` it
// first boots with, for every OpenCode host in the isolate, so the wrapper
// has to be in place before any of them starts.
installFetch();

/**
 * Creates an OpenCode provider over Workers AI, through the AI binding.
 *
 * Gateway options may be given flat (`{ binding, id: "prod" }`) or nested
 * under `gateway`, as with `agents/models/ai-sdk` and `agents/models/pi-ai`.
 *
 * @beta This surface is in beta and may change.
 */
export function createAI(settings: OpenCodeAISettings): AI {
  installFetch();
  const transport = createTransport(settings);
  const route = crypto.randomUUID();
  const maxTokens = settings.maxTokens ?? DEFAULT_MAX_TOKENS;

  // The route lives as long as OpenCode has the plugin running.
  const plugin: Plugin.Plugin = {
    id: `agents.models.opencode.${route}`,
    setup() {
      routes.set(route, { transport, settings });
      return () => {
        routes.delete(route);
      };
    }
  };

  // Every model asked for by id gets an entry, so its output cap applies;
  // the rest of OpenCode's Workers AI catalog stays listed as it is.
  const models: Record<string, { limit: { output: number } }> = {};
  const model = (modelId: string): OpenCodeModel => {
    models[modelId] = { limit: { output: maxTokens } };
    return { providerID: CLOUDFLARE_PROVIDER_ID, id: modelId };
  };

  const provider: OpenCodeProvider = {
    id: CLOUDFLARE_PROVIDER_ID,
    get config() {
      return {
        name: "Cloudflare Workers AI",
        package: PROVIDER_PACKAGE,
        settings: {
          // OpenCode wants a key for this provider; the binding needs none.
          apiKey: "workers-ai-binding",
          baseURL: `https://${BINDING_HOST}/${route}/v1`
        },
        models: { ...models }
      };
    },
    plugin
  };

  return Object.assign(model, { model, provider }) as AI;
}

/**
 * Answers OpenCode's OpenAI-compatible requests for the binding's host from
 * the binding, and hands every other request to the `fetch` it replaced.
 */
function installFetch(): void {
  if (installed) return;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== BINDING_HOST) return original(input, init);
    return answer(new Request(input, init), url);
  };
  installed = true;
}

async function answer(request: Request, url: URL): Promise<Response> {
  const route = routes.get(url.pathname.split("/").filter(Boolean)[0] ?? "");
  if (!route) {
    return Response.json(
      { error: { message: "This Workers AI provider is not running" } },
      { status: 404 }
    );
  }
  const body = (await request.json()) as Record<string, unknown>;
  const { model, ...input } = body;
  if (typeof model !== "string") {
    return Response.json(
      { error: { message: "The request names no model" } },
      { status: 400 }
    );
  }
  try {
    return await route.transport.run({
      model,
      input,
      gateway: resolveOptions(route.settings, undefined, undefined).gateway,
      headers: {},
      signal: request.signal
    });
  } catch (error) {
    // The binding itself failed; an upstream error comes back as a Response.
    const status =
      error instanceof CloudflareAIError && error.status ? error.status : 502;
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      },
      { status }
    );
  }
}
