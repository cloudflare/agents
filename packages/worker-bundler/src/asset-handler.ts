/**
 * Asset request handler for serving static assets.
 *
 * Key design: the manifest (routing metadata) is separated from the
 * storage (content retrieval). This lets you plug in any backend —
 * in-memory, KV, R2, Workspace, etc.
 *
 * Inspired by Cloudflare's Workers Static Assets behavior and
 * cloudflare-asset-worker by Timo Wilhelm.
 */

import { inferContentType } from "./mime";

// ── Storage interface ───────────────────────────────────────────────

/**
 * Pluggable storage backend for asset content.
 * Implement this to serve assets from KV, R2, Workspace, or any other source.
 */
export interface AssetStorage {
  get(pathname: string): Promise<ReadableStream | ArrayBuffer | string | null>;
}

/**
 * Metadata for a single asset (no content — that comes from storage).
 */
export interface AssetMetadata {
  contentType: string | undefined;
  etag: string;
}

/**
 * The manifest maps pathnames to metadata. Used for routing decisions,
 * ETag checks, and content-type headers — all without touching storage.
 */
export type AssetManifest = Map<string, AssetMetadata>;

/**
 * Create an in-memory storage backend from a pathname->content map.
 * This is the zero-config default for small asset sets.
 */
export function createMemoryStorage(
  assets: Record<string, string | ArrayBuffer>
): AssetStorage {
  const map = new Map(Object.entries(assets));
  return {
    get(pathname) {
      return Promise.resolve(map.get(pathname) ?? null);
    }
  };
}

// ── Configuration ───────────────────────────────────────────────────

/**
 * Configuration for asset serving behavior.
 */
export interface AssetConfig {
  /**
   * How to handle HTML file resolution and trailing slashes.
   * @default 'auto-trailing-slash'
   */
  html_handling?:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";

  /**
   * How to handle requests that don't match any asset.
   * - 'single-page-application': Serve /index.html for 404s
   * - '404-page': Serve nearest 404.html walking up the directory tree
   * - 'none': Return null (fall through)
   * @default 'none'
   */
  not_found_handling?: "single-page-application" | "404-page" | "none";

  /**
   * Static redirect rules. Keys are URL pathnames (or https://host/path for cross-host).
   * Supports * glob and :placeholder tokens.
   */
  redirects?: {
    static?: Record<string, { status: number; to: string }>;
    dynamic?: Record<string, { status: number; to: string }>;
  };

  /**
   * Custom response headers per pathname pattern (glob syntax).
   */
  headers?: Record<string, { set?: Record<string, string>; unset?: string[] }>;
}

/**
 * Normalized configuration with all fields required.
 */
interface NormalizedConfig {
  html_handling:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  not_found_handling: "single-page-application" | "404-page" | "none";
  redirects: {
    static: Record<string, { status: number; to: string; lineNumber: number }>;
    dynamic: Record<string, { status: number; to: string }>;
  };
  headers: Record<string, { set?: Record<string, string>; unset?: string[] }>;
}

/**
 * Normalize user config with defaults.
 */
export function normalizeConfig(config?: AssetConfig): NormalizedConfig {
  const staticRedirects: Record<
    string,
    { status: number; to: string; lineNumber: number }
  > = {};
  if (config?.redirects?.static) {
    let lineNumber = 1;
    for (const [path, rule] of Object.entries(config.redirects.static)) {
      staticRedirects[path] = { ...rule, lineNumber: lineNumber++ };
    }
  }

  return {
    html_handling: config?.html_handling ?? "auto-trailing-slash",
    not_found_handling: config?.not_found_handling ?? "none",
    redirects: {
      static: staticRedirects,
      dynamic: config?.redirects?.dynamic ?? {}
    },
    headers: config?.headers ?? {}
  };
}

// ── ETag / manifest building ────────────────────────────────────────

/**
 * Compute a simple hash for ETag generation.
 * Uses a fast string hash (FNV-1a) for text, or SHA-256 for binary.
 */
export async function computeETag(
  content: string | ArrayBuffer
): Promise<string> {
  if (typeof content === "string") {
    // FNV-1a hash for fast text hashing
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  // SHA-256 for binary
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const hashArray = new Uint8Array(hashBuffer);
  return [...hashArray.slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build an AssetManifest from a pathname->content mapping.
 * Only computes metadata (content types, ETags) — doesn't store content.
 */
export async function buildAssetManifest(
  assets: Record<string, string | ArrayBuffer>
): Promise<AssetManifest> {
  const manifest: AssetManifest = new Map();
  const entries = Object.entries(assets);
  await Promise.all(
    entries.map(async ([pathname, content]) => {
      const contentType = inferContentType(pathname);
      const etag = await computeETag(content);
      manifest.set(pathname, { contentType, etag });
    })
  );
  return manifest;
}

/**
 * Convenience: build both a manifest and an in-memory storage from assets.
 */
export async function buildAssets(
  assets: Record<string, string | ArrayBuffer>
): Promise<{ manifest: AssetManifest; storage: AssetStorage }> {
  const manifest = await buildAssetManifest(assets);
  const storage = createMemoryStorage(assets);
  return { manifest, storage };
}

/**
 * Check if a pathname exists in the manifest.
 */
function exists(
  manifest: AssetManifest,
  pathname: string
): AssetMetadata | undefined {
  return manifest.get(pathname);
}

// ── Redirect handling ───────────────────────────────────────────────

const ESCAPE_REGEX_CHARACTERS = /[-/\\^$*+?.()|[\]{}]/g;
const escapeRegex = (s: string) =>
  s.replaceAll(ESCAPE_REGEX_CHARACTERS, String.raw`\$&`);

const PLACEHOLDER_REGEX = /:([A-Za-z]\w*)/g;

type Replacements = Record<string, string>;

function replacer(str: string, replacements: Replacements): string {
  for (const [key, value] of Object.entries(replacements)) {
    str = str.replaceAll(`:${key}`, value);
  }
  return str;
}

function generateRuleRegExp(rule: string): RegExp {
  rule = rule
    .split("*")
    .map((s) => escapeRegex(s))
    .join("(?<splat>.*)");

  const matches = rule.matchAll(PLACEHOLDER_REGEX);
  for (const match of matches) {
    rule = rule.split(match[0]).join(`(?<${match[1]}>[^/]+)`);
  }

  return new RegExp("^" + rule + "$");
}

function matchStaticRedirects(
  config: NormalizedConfig,
  host: string,
  pathname: string
): { status: number; to: string; lineNumber: number } | undefined {
  const withHost = config.redirects.static[`https://${host}${pathname}`];
  const withoutHost = config.redirects.static[pathname];
  if (withHost && withoutHost) {
    return withHost.lineNumber < withoutHost.lineNumber
      ? withHost
      : withoutHost;
  }
  return withHost || withoutHost;
}

function matchDynamicRedirects(
  config: NormalizedConfig,
  request: Request
): { status: number; to: string } | undefined {
  const { pathname } = new URL(request.url);
  for (const [pattern, rule] of Object.entries(config.redirects.dynamic)) {
    try {
      const re = generateRuleRegExp(pattern);
      const result = re.exec(pathname);
      if (result) {
        const target = replacer(rule.to, result.groups || {}).trim();
        return { status: rule.status, to: target };
      }
    } catch {
      // Skip invalid patterns
    }
  }
  return undefined;
}

function handleRedirects(
  request: Request,
  config: NormalizedConfig
): Response | { proxied: boolean; pathname: string } {
  const url = new URL(request.url);
  const { search, host } = url;
  let { pathname } = url;

  const staticMatch = matchStaticRedirects(config, host, pathname);
  const dynamicMatch = staticMatch
    ? undefined
    : matchDynamicRedirects(config, request);
  const match = staticMatch ?? dynamicMatch;

  let proxied = false;
  if (match) {
    if (match.status === 200) {
      pathname = new URL(match.to, request.url).pathname;
      proxied = true;
    } else {
      const destination = new URL(match.to, request.url);
      const location =
        destination.origin === url.origin
          ? `${destination.pathname}${destination.search || search}${destination.hash}`
          : `${destination.href}`;
      return new Response(null, {
        status: match.status,
        headers: { Location: location }
      });
    }
  }

  return { proxied, pathname };
}

// ── Custom headers ──────────────────────────────────────────────────

function generateGlobRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((s) => escapeRegex(s))
    .join(".*");
  return new RegExp("^" + escaped + "$");
}

function attachCustomHeaders(
  request: Request,
  response: Response,
  config: NormalizedConfig
): Response {
  if (Object.keys(config.headers).length === 0) {
    return response;
  }

  const { pathname } = new URL(request.url);
  const setMap = new Set<string>();

  for (const [pattern, rules] of Object.entries(config.headers)) {
    try {
      const re = generateGlobRegExp(pattern);
      if (!re.test(pathname)) continue;
    } catch {
      continue;
    }

    if (rules.unset) {
      for (const key of rules.unset) {
        response.headers.delete(key);
      }
    }
    if (rules.set) {
      for (const [key, value] of Object.entries(rules.set)) {
        if (setMap.has(key.toLowerCase())) {
          response.headers.append(key, value);
        } else {
          response.headers.set(key, value);
          setMap.add(key.toLowerCase());
        }
      }
    }
  }

  return response;
}

// ── Path decoding / encoding ────────────────────────────────────────

function decodePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/")
    .replaceAll(/\/+/g, "/");
}

function encodePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

// ── HTML handling modes ─────────────────────────────────────────────

type Intent =
  | { type: "asset"; pathname: string; meta: AssetMetadata; status: number }
  | { type: "redirect"; to: string }
  | undefined;

function getIntent(
  pathname: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  skipRedirects = false,
  acceptsHtml = true
): Intent {
  switch (config.html_handling) {
    case "auto-trailing-slash":
      return htmlAutoTrailingSlash(
        pathname,
        manifest,
        config,
        skipRedirects,
        acceptsHtml
      );
    case "force-trailing-slash":
      return htmlForceTrailingSlash(
        pathname,
        manifest,
        config,
        skipRedirects,
        acceptsHtml
      );
    case "drop-trailing-slash":
      return htmlDropTrailingSlash(
        pathname,
        manifest,
        config,
        skipRedirects,
        acceptsHtml
      );
    case "none":
      return htmlNone(pathname, manifest, config, acceptsHtml);
  }
}

function assetIntent(
  pathname: string,
  meta: AssetMetadata,
  status = 200
): Intent {
  return { type: "asset", pathname, meta, status };
}

function redirectIntent(to: string): Intent {
  return { type: "redirect", to };
}

/**
 * Safe redirect: only redirect if the file exists and the destination
 * itself resolves to the same asset (avoids redirect loops).
 */
function safeRedirect(
  file: string,
  destination: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  skip: boolean
): Intent {
  if (skip) return undefined;
  if (!exists(manifest, destination)) {
    const intent = getIntent(destination, manifest, config, true);
    if (
      intent?.type === "asset" &&
      intent.meta.etag === exists(manifest, file)?.etag
    ) {
      return redirectIntent(destination);
    }
  }
  return undefined;
}

function htmlAutoTrailingSlash(
  pathname: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  skipRedirects: boolean,
  acceptsHtml: boolean
): Intent {
  let meta: AssetMetadata | undefined;
  let redirect: Intent;
  const exactMeta = exists(manifest, pathname);

  if (pathname.endsWith("/index")) {
    if (exactMeta) {
      return assetIntent(pathname, exactMeta);
    }
    if (
      (redirect = safeRedirect(
        `${pathname}.html`,
        pathname.slice(0, -"index".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -"/index".length)}.html`,
        pathname.slice(0, -"/index".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  } else if (pathname.endsWith("/index.html")) {
    if (
      (redirect = safeRedirect(
        pathname,
        pathname.slice(0, -"index.html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -"/index.html".length)}.html`,
        pathname.slice(0, -"/index.html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  } else if (pathname.endsWith("/")) {
    const indexPath = `${pathname}index.html`;
    if ((meta = exists(manifest, indexPath))) {
      return assetIntent(indexPath, meta);
    }
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -"/".length)}.html`,
        pathname.slice(0, -"/".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  } else if (pathname.endsWith(".html")) {
    if (
      (redirect = safeRedirect(
        pathname,
        pathname.slice(0, -".html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        `${pathname.slice(0, -".html".length)}/`,
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  }

  // Exact match
  if (exactMeta) {
    return assetIntent(pathname, exactMeta);
  }
  // Try .html extension
  const htmlPath = `${pathname}.html`;
  if ((meta = exists(manifest, htmlPath))) {
    return assetIntent(htmlPath, meta);
  }
  // Try /index.html
  if (
    (redirect = safeRedirect(
      `${pathname}/index.html`,
      `${pathname}/`,
      manifest,
      config,
      skipRedirects
    ))
  )
    return redirect;

  return notFound(pathname, manifest, config, acceptsHtml);
}

function htmlForceTrailingSlash(
  pathname: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  skipRedirects: boolean,
  acceptsHtml: boolean
): Intent {
  let meta: AssetMetadata | undefined;
  let redirect: Intent;
  const exactMeta = exists(manifest, pathname);

  if (pathname.endsWith("/index")) {
    if (exactMeta) return assetIntent(pathname, exactMeta);
    if (
      (redirect = safeRedirect(
        `${pathname}.html`,
        pathname.slice(0, -"index".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -"/index".length)}.html`,
        pathname.slice(0, -"index".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  } else if (pathname.endsWith("/index.html")) {
    if (
      (redirect = safeRedirect(
        pathname,
        pathname.slice(0, -"index.html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -"/index.html".length)}.html`,
        pathname.slice(0, -"index.html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  } else if (pathname.endsWith("/")) {
    let p = `${pathname}index.html`;
    if ((meta = exists(manifest, p))) {
      return assetIntent(p, meta);
    }
    p = `${pathname.slice(0, -"/".length)}.html`;
    if ((meta = exists(manifest, p))) {
      return assetIntent(p, meta);
    }
  } else if (pathname.endsWith(".html")) {
    if (
      (redirect = safeRedirect(
        pathname,
        `${pathname.slice(0, -".html".length)}/`,
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (exactMeta) return assetIntent(pathname, exactMeta);
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        `${pathname.slice(0, -".html".length)}/`,
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  }

  if (exactMeta) return assetIntent(pathname, exactMeta);
  if (
    (redirect = safeRedirect(
      `${pathname}.html`,
      `${pathname}/`,
      manifest,
      config,
      skipRedirects
    ))
  )
    return redirect;
  if (
    (redirect = safeRedirect(
      `${pathname}/index.html`,
      `${pathname}/`,
      manifest,
      config,
      skipRedirects
    ))
  )
    return redirect;

  return notFound(pathname, manifest, config, acceptsHtml);
}

function htmlDropTrailingSlash(
  pathname: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  skipRedirects: boolean,
  acceptsHtml: boolean
): Intent {
  let meta: AssetMetadata | undefined;
  let redirect: Intent;
  const exactMeta = exists(manifest, pathname);

  if (pathname.endsWith("/index")) {
    if (exactMeta) return assetIntent(pathname, exactMeta);
    if (pathname === "/index") {
      if (
        (redirect = safeRedirect(
          "/index.html",
          "/",
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
    } else {
      if (
        (redirect = safeRedirect(
          `${pathname.slice(0, -"/index".length)}.html`,
          pathname.slice(0, -"/index".length),
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
      if (
        (redirect = safeRedirect(
          `${pathname}.html`,
          pathname.slice(0, -"/index".length),
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
    }
  } else if (pathname.endsWith("/index.html")) {
    if (pathname === "/index.html") {
      if (
        (redirect = safeRedirect(
          "/index.html",
          "/",
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
    } else {
      if (
        (redirect = safeRedirect(
          pathname,
          pathname.slice(0, -"/index.html".length),
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
      if (exactMeta) return assetIntent(pathname, exactMeta);
      if (
        (redirect = safeRedirect(
          `${pathname.slice(0, -"/index.html".length)}.html`,
          pathname.slice(0, -"/index.html".length),
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
    }
  } else if (pathname.endsWith("/")) {
    if (pathname === "/") {
      if ((meta = exists(manifest, "/index.html"))) {
        return assetIntent("/index.html", meta);
      }
    } else {
      if (
        (redirect = safeRedirect(
          `${pathname.slice(0, -"/".length)}.html`,
          pathname.slice(0, -"/".length),
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
      if (
        (redirect = safeRedirect(
          `${pathname.slice(0, -"/".length)}/index.html`,
          pathname.slice(0, -"/".length),
          manifest,
          config,
          skipRedirects
        ))
      )
        return redirect;
    }
  } else if (pathname.endsWith(".html")) {
    if (
      (redirect = safeRedirect(
        pathname,
        pathname.slice(0, -".html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
    if (
      (redirect = safeRedirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        pathname.slice(0, -".html".length),
        manifest,
        config,
        skipRedirects
      ))
    )
      return redirect;
  }

  if (exactMeta) return assetIntent(pathname, exactMeta);
  let p = `${pathname}.html`;
  if ((meta = exists(manifest, p))) {
    return assetIntent(p, meta);
  }
  p = `${pathname}/index.html`;
  if ((meta = exists(manifest, p))) {
    return assetIntent(p, meta);
  }

  return notFound(pathname, manifest, config, acceptsHtml);
}

function htmlNone(
  pathname: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  acceptsHtml: boolean
): Intent {
  const meta = exists(manifest, pathname);
  return meta
    ? assetIntent(pathname, meta)
    : notFound(pathname, manifest, config, acceptsHtml);
}

// ── Not-found handling ──────────────────────────────────────────────

function notFound(
  pathname: string,
  manifest: AssetManifest,
  config: NormalizedConfig,
  acceptsHtml = true
): Intent {
  switch (config.not_found_handling) {
    case "single-page-application": {
      // Only serve the SPA fallback for requests that accept HTML
      // (browser navigation). API calls (Accept: */* or application/json)
      // should fall through to the user's server code.
      if (!acceptsHtml) return undefined;
      const meta = exists(manifest, "/index.html");
      if (meta) return assetIntent("/index.html", meta, 200);
      return undefined;
    }
    case "404-page": {
      let cwd = pathname;
      while (cwd) {
        cwd = cwd.slice(0, cwd.lastIndexOf("/"));
        const p = `${cwd}/404.html`;
        const meta = exists(manifest, p);
        if (meta) return assetIntent(p, meta, 404);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// ── Cache headers ───────────────────────────────────────────────────

const CACHE_CONTROL_REVALIDATE = "public, max-age=0, must-revalidate";
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

function getCacheControl(pathname: string): string {
  // Hashed assets (contain content hash in filename) get long-lived caching
  // Common patterns: app.abc123.js, styles.abc123.css, image.abc123.png
  if (/\.[a-f0-9]{8,}\.\w+$/.test(pathname)) {
    return CACHE_CONTROL_IMMUTABLE;
  }
  return CACHE_CONTROL_REVALIDATE;
}

// ── Main handler ────────────────────────────────────────────────────

/**
 * Handle an asset request. Returns a Response if an asset matches,
 * or null if the request should fall through to the user's Worker.
 *
 * @param request - The incoming HTTP request
 * @param manifest - Asset manifest (pathname -> metadata)
 * @param storage - Storage backend for fetching content
 * @param config - Asset serving configuration
 */
export async function handleAssetRequest(
  request: Request,
  manifest: AssetManifest,
  storage: AssetStorage,
  config?: AssetConfig
): Promise<Response | null> {
  const normalized = normalizeConfig(config);

  // Only handle GET and HEAD
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    return null;
  }

  // Check redirects first
  const redirectResult = handleRedirects(request, normalized);
  if (redirectResult instanceof Response) {
    return attachCustomHeaders(request, redirectResult, normalized);
  }

  const { pathname } = redirectResult;
  const decodedPathname = decodePath(pathname);

  // SPA fallback should only apply to navigation requests that explicitly
  // accept HTML, not to API calls (fetch/XHR) which have Accept: */*
  const accept = request.headers.get("Accept") || "";
  const acceptsHtml = accept.includes("text/html");

  // Resolve intent through HTML handling
  const intent = getIntent(
    decodedPathname,
    manifest,
    normalized,
    false,
    acceptsHtml
  );

  if (!intent) {
    return null;
  }

  if (intent.type === "redirect") {
    const url = new URL(request.url);
    const encodedDest = encodePath(intent.to);
    const response = new Response(null, {
      status: 307,
      headers: { Location: encodedDest + url.search }
    });
    return attachCustomHeaders(request, response, normalized);
  }

  // Check if canonical path differs (needs redirect)
  const encodedPathname = encodePath(decodedPathname);
  if (encodedPathname !== pathname) {
    const url = new URL(request.url);
    const response = new Response(null, {
      status: 307,
      headers: { Location: encodedPathname + url.search }
    });
    return attachCustomHeaders(request, response, normalized);
  }

  // ETag conditional request
  const { pathname: assetPath, meta, status } = intent;
  const strongETag = `"${meta.etag}"`;
  const weakETag = `W/${strongETag}`;
  const ifNoneMatch = request.headers.get("If-None-Match") || "";
  const eTags = new Set(ifNoneMatch.split(",").map((t) => t.trim()));

  const headers = new Headers();
  headers.set("ETag", strongETag);
  if (meta.contentType) {
    headers.set("Content-Type", meta.contentType);
  }
  headers.set("Cache-Control", getCacheControl(decodedPathname));

  if (eTags.has(weakETag) || eTags.has(strongETag)) {
    const response = new Response(null, { status: 304, headers });
    return attachCustomHeaders(request, response, normalized);
  }

  // Fetch content from storage (only for non-HEAD)
  let body: ReadableStream | ArrayBuffer | string | null = null;
  if (method !== "HEAD") {
    body = await storage.get(assetPath);
  }

  const response = new Response(body, { status, headers });
  return attachCustomHeaders(request, response, normalized);
}
