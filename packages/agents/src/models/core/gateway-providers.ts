/**
 * The AI Gateway provider table: which gateway provider slug a vendor's own
 * base URL belongs to, and what the universal request's `endpoint` is for a
 * given upstream URL.
 *
 * This is platform knowledge, not vendor knowledge — the gateway publishes the
 * list, and every entry here appears in `AIGatewayProviders` from
 * `@cloudflare/workers-types`. Nothing about a vendor's wire format, model ids
 * or capabilities lives here: the vendor's own provider package builds the
 * request, and this table only says where it goes.
 *
 * Adapted from `@cloudflare/ai-gateway-provider`'s `providers.ts`.
 *
 * @experimental This surface is experimental and may change.
 */

/**
 * The gateway provider slugs this table maps onto. A subset of the ambient
 * `AIGatewayProviders` union; {@link GatewayProviderNameCheck} keeps it one.
 *
 * @experimental This surface is experimental and may change.
 */
export const GATEWAY_PROVIDER_NAMES = [
  "workers-ai",
  "anthropic",
  "openai",
  "azure-openai",
  "google-ai-studio",
  "google-vertex-ai",
  "grok",
  "mistral",
  "perplexity-ai",
  "replicate",
  "groq",
  "deepseek",
  "openrouter",
  "cerebras",
  "cohere",
  "huggingface",
  "aws-bedrock",
  "elevenlabs",
  "cartesia"
] as const;

/**
 * A gateway provider slug.
 *
 * @experimental This surface is experimental and may change.
 */
export type GatewayProviderName = (typeof GATEWAY_PROVIDER_NAMES)[number];

/**
 * Compile-time guard: every slug in this table must exist in the platform's
 * own provider union, so a workers-types bump that renames one fails `tsc`
 * here rather than at runtime with a 404 from the gateway.
 *
 * @internal
 */
export type GatewayProviderNameCheck<
  T extends AIGatewayProviders = GatewayProviderName
> = T;

/**
 * One row of the provider table.
 *
 * @experimental This surface is experimental and may change.
 */
export interface GatewayProvider {
  /** The gateway provider slug. */
  readonly name: GatewayProviderName;
  /** Matches the upstream host (`URL.host`), not the whole URL. */
  readonly host: RegExp;
  /**
   * Request headers carrying the vendor's own credential. They are stripped
   * before the request is handed to the gateway, which holds the real key
   * (unified billing or BYOK). Lowercase.
   */
  readonly authHeaders: readonly string[];
  /**
   * The universal request's `endpoint` for an upstream URL: everything after
   * the host, query string included, with the provider's fixed prefix removed.
   * `undefined` when the URL does not belong to this provider.
   */
  endpoint(url: string): string | undefined;
}

/** The default credential header; providers add their own on top. */
const AUTHORIZATION = ["authorization"] as const;

interface ProviderSpec {
  name: GatewayProviderName;
  host: RegExp;
  authHeaders?: readonly string[];
  /** A fixed path prefix stripped from the endpoint. */
  pathPrefix?: RegExp;
  /** A full replacement for the default path mapping. */
  endpoint?: (url: URL) => string | undefined;
}

/** Path after the host, leading slash removed, query string kept. */
function pathOf(url: URL): string {
  return `${url.pathname.replace(/^\/+/, "")}${url.search}`;
}

function buildProvider(spec: ProviderSpec): GatewayProvider {
  const map =
    spec.endpoint ??
    ((url: URL) => {
      const path = pathOf(url);
      return spec.pathPrefix === undefined
        ? path
        : path.replace(spec.pathPrefix, "");
    });
  return {
    authHeaders: spec.authHeaders ?? AUTHORIZATION,
    endpoint(url) {
      const parsed = parseUrl(url);
      if (parsed === undefined || !spec.host.test(parsed.host)) {
        return undefined;
      }
      return map(parsed);
    },
    host: spec.host,
    name: spec.name
  };
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Azure names the deployment in the path; the gateway names it in the
 * endpoint as `<resource>/<deployment>/<rest>`.
 */
function azureEndpoint(url: URL): string | undefined {
  const resource = /^([^.]+)\.openai\.azure\.com$/.exec(url.host)?.[1];
  const rest = /^\/openai\/deployments\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (resource === undefined || rest === null) return undefined;
  return `${resource}/${rest[1]}/${rest[2]}${url.search}`;
}

/**
 * Bedrock's region and service live in the host; the gateway wants them as the
 * first two endpoint segments.
 */
function bedrockEndpoint(url: URL): string | undefined {
  const match = /^(bedrock[a-z0-9-]*)\.([a-z0-9-]+)\.amazonaws\.com$/.exec(
    url.host
  );
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}/${pathOf(url)}`;
}

const SPECS: ProviderSpec[] = [
  {
    // Workers AI's own API host. `env.AI.run` is this package's path for
    // `@cf/` models; this row exists because the gateway lists the provider,
    // so a model object pointed at that host still resolves.
    host: /^api\.cloudflare\.com$/,
    name: "workers-ai",
    pathPrefix: /^client\/v4\/accounts\/[^/]+\/ai\//
  },
  {
    authHeaders: ["authorization", "x-api-key"],
    host: /^api\.anthropic\.com$/,
    name: "anthropic"
  },
  { host: /^api\.openai\.com$/, name: "openai" },
  {
    authHeaders: ["authorization", "api-key"],
    endpoint: azureEndpoint,
    host: /^[^.]+\.openai\.azure\.com$/,
    name: "azure-openai"
  },
  {
    authHeaders: ["authorization", "x-goog-api-key"],
    host: /^generativelanguage\.googleapis\.com$/,
    name: "google-ai-studio"
  },
  {
    host: /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/,
    name: "google-vertex-ai"
  },
  { host: /^api\.x\.ai$/, name: "grok" },
  { host: /^api\.mistral\.ai$/, name: "mistral" },
  { host: /^api\.perplexity\.ai$/, name: "perplexity-ai" },
  { host: /^api\.replicate\.com$/, name: "replicate" },
  {
    host: /^api\.groq\.com$/,
    name: "groq",
    pathPrefix: /^openai\/v1\//
  },
  { host: /^api\.deepseek\.com$/, name: "deepseek" },
  {
    host: /^openrouter\.ai$/,
    name: "openrouter",
    pathPrefix: /^api\//
  },
  { host: /^api\.cerebras\.ai$/, name: "cerebras" },
  { host: /^api\.cohere\.(?:ai|com)$/, name: "cohere" },
  {
    host: /^(?:api-inference|router)\.huggingface\.co$/,
    name: "huggingface",
    pathPrefix: /^models\//
  },
  {
    endpoint: bedrockEndpoint,
    host: /^bedrock.*\.amazonaws\.com$/,
    name: "aws-bedrock"
  },
  { host: /^api\.elevenlabs\.io$/, name: "elevenlabs" },
  { host: /^api\.cartesia\.ai$/, name: "cartesia" }
];

/**
 * The provider table, in declaration order. Hosts do not overlap, so the order
 * only decides which row a future overlapping host would win.
 *
 * @experimental This surface is experimental and may change.
 */
export const GATEWAY_PROVIDERS: readonly GatewayProvider[] =
  SPECS.map(buildProvider);

/**
 * A vendor URL mapped onto the universal gateway request.
 *
 * @experimental This surface is experimental and may change.
 */
export interface ResolvedGatewayProvider {
  /** The gateway provider slug. */
  provider: GatewayProviderName;
  /** The universal request's `endpoint`. */
  endpoint: string;
  /** Request headers to strip before handing the request to the gateway. */
  authHeaders: readonly string[];
}

/**
 * The table row for a bare host (`api.anthropic.com`) or for anything a `URL`
 * can be built from. pi-ai models carry a `baseUrl` rather than a full request
 * URL, so both spellings resolve.
 *
 * @experimental This surface is experimental and may change.
 */
export function gatewayProviderForHost(
  hostOrUrl: string
): GatewayProvider | undefined {
  const host = parseUrl(hostOrUrl)?.host ?? hostOf(hostOrUrl);
  if (host === undefined) return undefined;
  return GATEWAY_PROVIDERS.find((provider) => provider.host.test(host));
}

/** Reads a host out of a bare host, `host/path` or `//host` spelling. */
function hostOf(value: string): string | undefined {
  const host = value.replace(/^\/\//, "").split("/")[0];
  return host === "" ? undefined : host;
}

/**
 * Maps a vendor request URL onto `{ provider, endpoint, authHeaders }` for the
 * universal gateway request, or `undefined` when the host is not a gateway
 * provider.
 *
 * @experimental This surface is experimental and may change.
 */
export function resolveGatewayProvider(
  url: string
): ResolvedGatewayProvider | undefined {
  const parsed = parseUrl(url);
  if (parsed === undefined) return undefined;
  for (const provider of GATEWAY_PROVIDERS) {
    if (!provider.host.test(parsed.host)) continue;
    const endpoint = provider.endpoint(url);
    if (endpoint === undefined) continue;
    return {
      authHeaders: provider.authHeaders,
      endpoint,
      provider: provider.name
    };
  }
  return undefined;
}

/**
 * {@link resolveGatewayProvider}, throwing a `TypeError` that names the host
 * and the provider list when the URL belongs to no gateway provider.
 *
 * @experimental This surface is experimental and may change.
 */
export function requireGatewayProvider(url: string): ResolvedGatewayProvider {
  const resolved = resolveGatewayProvider(url);
  if (resolved !== undefined) return resolved;
  const host = parseUrl(url)?.host ?? url;
  throw new TypeError(
    `AI Gateway has no provider for ${host}. Requests are routed by host; the supported providers are ${GATEWAY_PROVIDER_NAMES.join(", ")}.`
  );
}

/** The host a gateway-shaped base URL points at. */
const GATEWAY_HOST = "gateway.ai.cloudflare.com";

/**
 * The provider slug of a gateway-shaped base URL —
 * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{slug}`. Generated
 * registries write models that way (pi-ai's Cloudflare AI Gateway catalog
 * leaves the account and gateway as literal placeholders), so the slug is
 * already in the path rather than implied by a vendor host. The account and
 * gateway segments are ignored: the binding has already chosen both.
 */
function gatewayShapedSlug(url: URL): string | undefined {
  if (url.host !== GATEWAY_HOST) return undefined;
  const segments = url.pathname.split("/").filter((part) => part !== "");
  if (segments[0] !== "v1" || segments.length < 4) return undefined;
  return segments[3];
}

/**
 * Whether a base URL is written in the gateway's own shape
 * (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{slug}`) rather
 * than as a vendor's. A generated Cloudflare registry writes models that way,
 * and the path after the slug is then the vendor's own, so a caller that
 * derives an endpoint from a base URL has to tell the two apart.
 *
 * @experimental This surface is experimental and may change.
 */
export function isGatewayShapedUrl(url: string): boolean {
  return parseUrl(url)?.host === GATEWAY_HOST;
}

function isGatewayProviderName(slug: string): slug is GatewayProviderName {
  return (GATEWAY_PROVIDER_NAMES as readonly string[]).includes(slug);
}

/**
 * The gateway provider slug a model's base URL belongs to. Two spellings
 * resolve, because two kinds of registry write them:
 *
 * - a vendor's own base URL (`https://api.anthropic.com` → `anthropic`), which
 *   is what a provider package configured for the vendor carries;
 * - a gateway-shaped base URL
 *   (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` →
 *   `anthropic`), which is what a generated Cloudflare registry carries.
 *
 * A base URL neither shape resolves is a wiring mistake rather than a request
 * failure, so it throws a `TypeError` naming what was not recognised.
 *
 * @experimental This surface is experimental and may change.
 */
export function gatewaySlugForBaseUrl(baseUrl: string): GatewayProviderName {
  const url = parseUrl(baseUrl);
  const shaped = url === undefined ? undefined : gatewayShapedSlug(url);
  if (shaped !== undefined) {
    if (isGatewayProviderName(shaped)) return shaped;
    throw new TypeError(
      `AI Gateway has no provider "${shaped}" (from ${baseUrl}). The supported providers are ${GATEWAY_PROVIDER_NAMES.join(", ")}.`
    );
  }
  const provider = gatewayProviderForHost(baseUrl);
  if (provider !== undefined) return provider.name;
  throw new TypeError(
    `AI Gateway has no provider for ${url?.host ?? baseUrl}. Requests are routed by the model's base URL; the supported providers are ${GATEWAY_PROVIDER_NAMES.join(", ")}.`
  );
}
