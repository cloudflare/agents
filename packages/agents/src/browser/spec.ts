/**
 * Chrome DevTools Protocol spec fetching + caching.
 *
 * The raw `/json/protocol` payload is normalized into a searchable shape and
 * cached per source: `cdpUrl` specs by endpoint + headers, Browser Rendering
 * specs by the binding itself (a WeakMap) so two different bindings in the
 * same isolate don't share an entry. The CDP protocol is identical across
 * bindings, but per-binding keys avoid surprising cross-binding cache reads.
 */

import type { BrowserBinding } from "./browser-run";

/** A parameter, return value, or type property in the raw protocol. */
interface RawCdpField {
  name: string;
  description?: string;
  optional?: boolean;
  experimental?: boolean;
  deprecated?: boolean;
  type?: string;
  $ref?: string;
  enum?: string[];
  items?: { type?: string; $ref?: string; enum?: string[] };
}

interface RawCdpCommand {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: RawCdpField[];
  returns?: RawCdpField[];
}

interface RawCdpEvent {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  parameters?: RawCdpField[];
}

interface RawCdpType {
  id: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  type?: string;
  enum?: string[];
  properties?: RawCdpField[];
  items?: { type?: string; $ref?: string; enum?: string[] };
}

/** Raw CDP protocol domain from `/json/protocol` */
interface RawCdpDomain {
  domain: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  commands?: RawCdpCommand[];
  events?: RawCdpEvent[];
  types?: RawCdpType[];
}

/**
 * The raw Chrome DevTools Protocol: the JSON Chrome serves at
 * `/json/protocol` and publishes as `browser_protocol.json` and
 * `js_protocol.json`. Other top-level fields, such as `version`, are allowed
 * and ignored. `normalizeCdpSpec` turns it into a `SearchableCdpSpec`.
 */
export interface RawCdpProtocol {
  domains?: RawCdpDomain[];
}

/**
 * The element type of an array field or type. `$ref` is always
 * domain-qualified (`"Network.Cookie"`), matching a type's `name`.
 */
export interface CdpItems {
  type?: string;
  $ref?: string;
  enum?: string[];
}

/**
 * A command parameter, return value, event parameter, or type property.
 * Either `type` (a JSON type such as `"string"` or `"array"`) or `$ref`
 * (a domain-qualified type name matching a type's `name`) is set.
 */
export interface CdpField {
  name: string;
  description?: string;
  optional?: boolean;
  experimental?: boolean;
  deprecated?: boolean;
  type?: string;
  $ref?: string;
  enum?: string[];
  items?: CdpItems;
}

export interface SearchableCdpSpec {
  domains: Array<{
    name: string;
    description?: string;
    experimental?: boolean;
    deprecated?: boolean;
    commands: Array<{
      name: string;
      method: string;
      description?: string;
      experimental?: boolean;
      deprecated?: boolean;
      parameters: CdpField[];
      returns: CdpField[];
    }>;
    events: Array<{
      name: string;
      event: string;
      description?: string;
      experimental?: boolean;
      deprecated?: boolean;
      parameters: CdpField[];
    }>;
    types: Array<{
      id: string;
      name: string;
      description?: string;
      experimental?: boolean;
      deprecated?: boolean;
      /** JSON type of the value, e.g. `"string"`, `"object"`, `"array"`. */
      type?: string;
      enum?: string[];
      properties: CdpField[];
      items?: CdpItems;
    }>;
  }>;
}

export interface CdpSpecSource {
  /** Browser Rendering binding (Fetcher) — used in production */
  browser?: BrowserBinding;
  /** CDP base URL override (e.g. http://localhost:9222) */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests */
  cdpHeaders?: Record<string, string>;
  /**
   * An existing Browser Run session to read the protocol from. Without it,
   * loading through the binding creates (and deletes) a throwaway session.
   */
  sessionId?: string;
}

const MISSING_BROWSER_CONFIG =
  "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided";

interface SpecCacheEntry {
  spec: SearchableCdpSpec;
  cachedAt: number;
}

const urlSpecCache = new Map<string, SpecCacheEntry>();
const bindingSpecCache = new WeakMap<BrowserBinding, SpecCacheEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Qualify a same-domain `$ref` (`"FrameId"` → `"Page.FrameId"`). */
function qualifyRef(domain: string, ref: string | undefined) {
  if (ref === undefined) return undefined;
  return ref.includes(".") ? ref : `${domain}.${ref}`;
}

function normalizeItems(
  domain: string,
  items: RawCdpType["items"]
): CdpItems | undefined {
  if (!items) return undefined;
  return {
    type: items.type,
    $ref: qualifyRef(domain, items.$ref),
    enum: items.enum
  };
}

function normalizeFields(
  domain: string,
  fields: RawCdpField[] | undefined
): CdpField[] {
  return (fields ?? []).map((field) => ({
    name: field.name,
    description: field.description,
    optional: field.optional,
    experimental: field.experimental,
    deprecated: field.deprecated,
    type: field.type,
    $ref: qualifyRef(domain, field.$ref),
    enum: field.enum,
    items: normalizeItems(domain, field.items)
  }));
}

/**
 * Normalize Chrome's raw protocol JSON into the spec a `BrowserSource`
 * connection's `spec()` returns (a `SearchableCdpSpec`): every `$ref`
 * domain-qualified (`"Page.FrameId"`), commands with `method`, events with
 * `event`, types with `name`, and empty arrays where the protocol omits them.
 *
 * Use it for a source that has no `/json/protocol` endpoint or Browser Run
 * binding for `loadCdpSpec`. Chrome publishes the protocol in two files,
 * `browser_protocol.json` and `js_protocol.json`; merge their `domains` into
 * one object before calling. Unlike `loadCdpSpec`, the spec is not cached, so
 * keep it yourself (for example in a module-level constant).
 */
export function normalizeCdpSpec(protocol: RawCdpProtocol): SearchableCdpSpec {
  return {
    domains: (protocol.domains ?? []).map(({ domain, ...raw }) => ({
      name: domain,
      description: raw.description,
      experimental: raw.experimental,
      deprecated: raw.deprecated,
      commands: (raw.commands ?? []).map((command) => ({
        name: command.name,
        method: `${domain}.${command.name}`,
        description: command.description,
        experimental: command.experimental,
        deprecated: command.deprecated,
        parameters: normalizeFields(domain, command.parameters),
        returns: normalizeFields(domain, command.returns)
      })),
      events: (raw.events ?? []).map((event) => ({
        name: event.name,
        event: `${domain}.${event.name}`,
        description: event.description,
        experimental: event.experimental,
        deprecated: event.deprecated,
        parameters: normalizeFields(domain, event.parameters)
      })),
      types: (raw.types ?? []).map((type) => ({
        id: type.id,
        name: `${domain}.${type.id}`,
        description: type.description,
        experimental: type.experimental,
        deprecated: type.deprecated,
        type: type.type,
        enum: type.enum,
        properties: normalizeFields(domain, type.properties),
        items: normalizeItems(domain, type.items)
      }))
    }))
  };
}

function getSpecCacheKey(
  source: string,
  headers?: Record<string, string>
): string {
  const headerEntries = Object.entries(headers ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `${source}:${JSON.stringify(headerEntries)}`;
}

async function getCachedSpec<K>(
  cache: {
    get(key: K): SpecCacheEntry | undefined;
    set(key: K, entry: SpecCacheEntry): void;
  },
  key: K,
  load: () => Promise<RawCdpProtocol>
): Promise<SearchableCdpSpec> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.spec;
  }

  const spec = normalizeCdpSpec(await load());
  cache.set(key, { spec, cachedAt: Date.now() });
  return spec;
}

async function fetchCdpSpecFromUrl(
  cdpBaseUrl: string,
  headers?: Record<string, string>
): Promise<SearchableCdpSpec> {
  const endpoint = new URL("/json/protocol", cdpBaseUrl).toString();

  return getCachedSpec(
    urlSpecCache,
    getSpecCacheKey(endpoint, headers),
    async () => {
      const response = await fetch(endpoint, { headers });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch CDP spec from ${endpoint}: ${response.status}`
        );
      }

      return (await response.json()) as RawCdpProtocol;
    }
  );
}

async function fetchCdpSpecFromSession(
  browser: BrowserBinding,
  sessionId: string
): Promise<SearchableCdpSpec> {
  return getCachedSpec(bindingSpecCache, browser, async () => {
    const response = await browser.fetch(
      `https://localhost/v1/devtools/browser/${sessionId}/json/protocol`
    );
    if (!response.ok) {
      throw new Error(
        `Failed to fetch CDP spec from Browser Rendering: ${response.status}`
      );
    }
    return (await response.json()) as RawCdpProtocol;
  });
}

async function fetchCdpSpecFromBrowser(
  browser: BrowserBinding
): Promise<SearchableCdpSpec> {
  return getCachedSpec(bindingSpecCache, browser, async () => {
    const createResponse = await browser.fetch(
      "https://localhost/v1/devtools/browser",
      {
        method: "POST"
      }
    );

    if (!createResponse.ok) {
      throw new Error(
        "Failed to create Browser Rendering session for protocol fetch: " +
          `${createResponse.status}`
      );
    }

    const payload = (await createResponse.json()) as { sessionId?: string };
    const sessionId = payload.sessionId;
    if (!sessionId) {
      throw new Error(
        "Browser Rendering session response did not include a sessionId"
      );
    }

    try {
      const response = await browser.fetch(
        `https://localhost/v1/devtools/browser/${sessionId}/json/protocol`
      );

      if (!response.ok) {
        throw new Error(
          "Failed to fetch CDP spec from Browser Rendering: " +
            `${response.status}`
        );
      }

      return (await response.json()) as RawCdpProtocol;
    } finally {
      try {
        await browser.fetch(
          `https://localhost/v1/devtools/browser/${sessionId}`,
          {
            method: "DELETE"
          }
        );
      } catch {
        // Cleanup failure should not mask the original result or error
      }
    }
  });
}

/** Load the (cached) searchable CDP spec for a browser source. */
export async function loadCdpSpec(
  source: CdpSpecSource
): Promise<SearchableCdpSpec> {
  if (source.cdpUrl) {
    return fetchCdpSpecFromUrl(source.cdpUrl, source.cdpHeaders);
  }
  if (source.browser && source.sessionId) {
    return fetchCdpSpecFromSession(source.browser, source.sessionId);
  }
  if (source.browser) {
    return fetchCdpSpecFromBrowser(source.browser);
  }
  throw new Error(MISSING_BROWSER_CONFIG);
}
