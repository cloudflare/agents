import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveThinkManifest } from "../framework/project";
import {
  buildStudioConfig,
  type StudioConfig,
  type StudioTarget
} from "./studio-config";

export interface StudioCommandOptions {
  /** Manifest agent id/alias or raw route segment to pre-fill the connect view. */
  agent?: string;
  /** Agent instance name to pre-fill. */
  instance?: string;
  /** Remote origin, e.g. `https://app.example.com`. */
  url?: string;
  /** Local host[:port]. */
  host?: string;
  /** Override the derived protocol. */
  protocol?: string;
  /** Auth token, forwarded to the connect view. */
  token?: string;
  /** Extra query params as `key=value` strings. */
  query?: string[];
  /** Project root used to discover the Think manifest. */
  root?: string;
  /** Override the Think route prefix. */
  routePrefix?: string;
  /** Port for the local Studio server. Defaults to 4321. */
  port?: number;
  /** Whether to open the browser automatically. Defaults to true. */
  open?: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

function studioDistDir(): string {
  // At runtime this module lives in dist/cli; the built SPA is in dist/studio.
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../studio"
  );
}

async function loadManifestAgents(
  root: string | undefined,
  routePrefix: string | undefined
) {
  try {
    return await resolveThinkManifest(
      { routePrefix },
      path.resolve(root ?? process.cwd())
    );
  } catch {
    return null;
  }
}

function buildTarget(options: StudioCommandOptions): StudioTarget {
  const target: StudioTarget = {};
  if (options.url) target.url = options.url;
  if (options.host) target.host = options.host;
  if (options.protocol === "ws" || options.protocol === "wss") {
    target.protocol = options.protocol;
  }
  if (options.token) target.token = options.token;
  if (options.agent) target.agent = options.agent;
  if (options.instance) target.instance = options.instance;
  if (options.routePrefix) target.routePrefix = options.routePrefix;
  return target;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32"
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — the URL is printed regardless.
  }
}

/** Resolve a file under `root`, guarding against path traversal. */
function safeResolve(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    // Malformed percent-encoding (e.g. `/%` or `/%zz`) makes decodeURIComponent
    // throw. Treat it as unresolvable (404) rather than letting the URIError
    // escape the request handler and crash the server.
    return null;
  }
  const resolved = path.resolve(root, `.${decoded}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function studioCommand(
  options: StudioCommandOptions
): Promise<void> {
  const distDir = studioDistDir();
  try {
    await stat(path.join(distDir, "index.html"));
  } catch {
    throw new Error(
      `Think Studio assets were not found at ${distDir}. ` +
        "Reinstall @cloudflare/think (the published package ships the prebuilt Studio), " +
        "or run the package build."
    );
  }

  const manifest = await loadManifestAgents(options.root, options.routePrefix);
  const config: StudioConfig = buildStudioConfig({
    target: buildTarget(options),
    manifest
  });
  const configJson = JSON.stringify(config);

  const server = createServer((req, res) => {
    const urlPath = req.url ?? "/";

    if (urlPath === "/__studio/config.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(configJson);
      return;
    }

    const rawPath = urlPath.split("?")[0];
    const candidate =
      rawPath === "/"
        ? path.join(distDir, "index.html")
        : safeResolve(distDir, rawPath);

    const serve = (filePath: string) => {
      const ext = path.extname(filePath).toLowerCase();
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        // The stream can fail to open (file deleted after stat(), permissions)
        // or fault mid-read. Only send a 500 if we haven't already committed
        // the 200 status line; otherwise the headers are gone and the only
        // correct action is to tear down the (now-corrupt) response.
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500);
          res.end("Internal error");
        }
      });
      // Defer the 200 until the file actually opens, so an open error can still
      // produce a clean 500 instead of throwing ERR_HTTP_HEADERS_SENT.
      stream.once("open", () => {
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream"
        });
        stream.pipe(res);
      });
    };

    if (!candidate) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    stat(candidate)
      .then((s) => {
        if (s.isFile()) {
          serve(candidate);
        } else {
          // SPA fallback for directory/unknown routes.
          serve(path.join(distDir, "index.html"));
        }
      })
      .catch(() => serve(path.join(distDir, "index.html")));
  });

  const startPort = options.port ?? 4321;
  const port = await listen(server, startPort);
  const studioUrl = `http://localhost:${port}/`;

  console.log(`Think Studio running at ${studioUrl}`);
  console.log("Press Ctrl+C to stop.");
  if (options.open !== false) openBrowser(studioUrl);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/** Listen on `startPort`, advancing on EADDRINUSE up to 20 ports. */
function listen(
  server: ReturnType<typeof createServer>,
  startPort: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < 20) {
          attempt += 1;
          tryPort(port + 1);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      // Bind to loopback only: the config payload can carry an auth token, so
      // the launcher must not be reachable from other devices on the network.
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    };
    tryPort(startPort);
  });
}
