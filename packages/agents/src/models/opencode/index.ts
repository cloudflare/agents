import type { Plugin } from "@opencode/plugin";
import type { WorkersAIModelId } from "../core/catalog";
import { CloudflareAIError } from "../core/errors";
import { resolveOptions, type AISettings } from "../core/settings";
import { createTransport, type Transport } from "../core/transport";

export type { WorkersAIModelId } from "../core/catalog";
export type { AISettings, GatewayOptions } from "../core/settings";

export const CLOUDFLARE_PROVIDER_ID = "cloudflare-workers-ai";

const PROVIDER_PACKAGE = "@opencode/ai/providers/cloudflare-workers-ai";

const BINDING_HOST = "workers-ai.binding.invalid";

const DEFAULT_MAX_TOKENS = 4096;

export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
};

export type OpenCodeProvider = {
  readonly id: string;
  readonly config: Record<string, unknown>;
  readonly plugin: Plugin.Plugin;
};

export type OpenCodeAISettings = AISettings & {
  readonly maxTokens?: number;
};

export interface AI {
  (modelId: WorkersAIModelId | (string & {})): OpenCodeModel;

  model(modelId: WorkersAIModelId | (string & {})): OpenCodeModel;

  readonly provider: OpenCodeProvider;
}

type Route = {
  readonly transport: Transport;
  readonly settings: AISettings;
};

const routes = new Map<string, Route>();
let installed = false;

// OpenCode's HTTP client retains the first global fetch it sees. Install the
// binding route before any OpenCode host boots, not when a plugin starts.
installFetch();

export function createAI(settings: OpenCodeAISettings): AI {
  const transport = createTransport(settings);
  const routeId = crypto.randomUUID();
  const maxTokens = settings.maxTokens ?? DEFAULT_MAX_TOKENS;

  const plugin: Plugin.Plugin = {
    id: `agents.models.opencode.${routeId}`,
    setup() {
      routes.set(routeId, { transport, settings });
      return () => {
        routes.delete(routeId);
      };
    }
  };

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
          apiKey: "workers-ai-binding",
          baseURL: `https://${BINDING_HOST}/${routeId}/v1`
        },
        models: { ...models }
      };
    },
    plugin
  };

  return Object.assign(model, { model, provider }) as AI;
}

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
  const bindingRoute = routes.get(
    url.pathname.split("/").filter(Boolean)[0] ?? ""
  );
  if (!bindingRoute) {
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
    return await bindingRoute.transport.run({
      model,
      input,
      gateway: resolveOptions(bindingRoute.settings, undefined, undefined)
        .gateway,
      headers: {},
      signal: request.signal
    });
  } catch (error) {
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
