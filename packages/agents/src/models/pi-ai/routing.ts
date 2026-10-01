/**
 * Where a pi-ai model's request goes on the AI Gateway universal endpoint.
 *
 * A pi `Model` carries the vendor's own `baseUrl` and an `api` marker. Those
 * two are all the routing information the universal request needs, but neither
 * alone is enough: the gateway's `endpoint` is the vendor's request URL minus
 * that provider's own base, and the base differs per provider (groq serves
 * chat completions at `/openai/v1/chat/completions`, deepseek at
 * `/chat/completions`). So the api names the path pi's own client appends to
 * `model.baseUrl`, the two are joined, and `core/gateway-providers.ts` — the
 * same resolver the AI SDK module's routed `fetch` uses — maps the result onto
 * a provider slug and an endpoint. Nothing here knows a vendor's wire format;
 * pi's own converters build the body.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type GatewayProviderName,
  gatewaySlugForBaseUrl,
  isGatewayShapedUrl,
  resolveGatewayProvider
} from "../core/gateway-providers";

/**
 * The path each pi api speaks, relative to the model's own `baseUrl` — exactly
 * what pi's SDK clients append to it.
 */
const API_PATHS: Record<string, string> = {
  "anthropic-messages": "v1/messages",
  "openai-completions": "chat/completions",
  "openai-responses": "responses"
};

/**
 * The universal request's `endpoint` for a gateway-shaped base URL, whose path
 * already ends at the provider slug, so what follows is the vendor's own path.
 */
const GATEWAY_ENDPOINTS: Record<string, string> = {
  "anthropic-messages": "v1/messages",
  "openai-completions": "v1/chat/completions",
  "openai-responses": "v1/responses"
};

/** Where one model's request goes on the universal gateway endpoint. */
export interface UniversalRoute {
  provider: GatewayProviderName;
  endpoint: string;
}

/**
 * The gateway provider slug that serves a model, from its own base URL.
 *
 * @throws TypeError when the model carries no base URL, or one AI Gateway has
 * no provider for.
 */
export function gatewaySlugForModel(model: Model<Api>): GatewayProviderName {
  if (model.baseUrl === "") {
    throw new TypeError(
      `The model "${model.id}" has no baseUrl, so AI Gateway cannot tell which provider serves it.`
    );
  }
  return gatewaySlugForBaseUrl(model.baseUrl);
}

/** `https://api.groq.com/openai/v1` → `https://api.groq.com/openai/v1/`. */
function asBase(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/**
 * The provider slug and endpoint one model's request travels on.
 *
 * @throws TypeError when the model has no base URL, when AI Gateway has no
 * provider for it, or when this module knows no path for the model's api.
 */
export function routeForModel(model: Model<Api>): UniversalRoute {
  const provider = gatewaySlugForModel(model);
  if (isGatewayShapedUrl(model.baseUrl)) {
    const endpoint = GATEWAY_ENDPOINTS[model.api];
    if (endpoint === undefined) throw noEndpoint(model.api);
    return { endpoint, provider };
  }
  const path = API_PATHS[model.api];
  if (path === undefined) throw noEndpoint(model.api);
  const resolved = resolveGatewayProvider(
    new URL(path, asBase(model.baseUrl)).toString()
  );
  // The base URL already resolved to a provider above, so the joined URL can
  // only fail to resolve if it left that provider's own host.
  if (resolved === undefined) {
    return { endpoint: GATEWAY_ENDPOINTS[model.api] ?? path, provider };
  }
  return { endpoint: resolved.endpoint, provider: resolved.provider };
}

function noEndpoint(api: string): TypeError {
  return new TypeError(`No AI Gateway endpoint is known for the "${api}" API.`);
}
