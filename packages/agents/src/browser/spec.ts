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

interface RawCdpCommand {
  name: string;
  description?: string;
}

interface RawCdpEvent {
  name: string;
  description?: string;
}

interface RawCdpType {
  id: string;
  description?: string;
}

/** Raw CDP protocol domain from `/json/protocol` */
interface RawCdpDomain {
  domain: string;
  description?: string;
  commands?: RawCdpCommand[];
  events?: RawCdpEvent[];
  types?: RawCdpType[];
}

export interface SearchableCdpSpec {
  domains: Array<{
    name: string;
    description?: string;
    commands: Array<{ name: string; method: string; description?: string }>;
    events: Array<{ name: string; event: string; description?: string }>;
    types: Array<{ id: string; name: string; description?: string }>;
  }>;
}

export interface CdpSpecSource {
  /** Browser Rendering binding (Fetcher) — used in production */
  browser?: BrowserBinding;
  /** CDP base URL override (e.g. http://localhost:9222) */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests */
  cdpHeaders?: Record<string, string>;
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

function normalizeCdpSpec(spec: {
  domains?: RawCdpDomain[];
}): SearchableCdpSpec {
  return {
    domains: (spec.domains ?? []).map((domain) => ({
      name: domain.domain,
      description: domain.description,
      commands: (domain.commands ?? []).map((command) => ({
        name: command.name,
        method: `${domain.domain}.${command.name}`,
        description: command.description
      })),
      events: (domain.events ?? []).map((event) => ({
        name: event.name,
        event: `${domain.domain}.${event.name}`,
        description: event.description
      })),
      types: (domain.types ?? []).map((type) => ({
        id: type.id,
        name: `${domain.domain}.${type.id}`,
        description: type.description
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
  load: () => Promise<{ domains?: RawCdpDomain[] }>
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

      return (await response.json()) as { domains?: RawCdpDomain[] };
    }
  );
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

      return (await response.json()) as { domains?: RawCdpDomain[] };
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
  if (source.browser) {
    return fetchCdpSpecFromBrowser(source.browser);
  }
  throw new Error(MISSING_BROWSER_CONFIG);
}
