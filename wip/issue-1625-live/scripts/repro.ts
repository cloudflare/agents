/**
 * Live #1625 teardown repro orchestrator.
 *
 * Drives a REAL deployed `McpAgent` through the Streamable-HTTP session
 * lifecycle and verifies the session DELETE durably tears the session DO down —
 * the production failure mode the local test runtime cannot reproduce (it never
 * cancels `waitUntil`).
 *
 *   1. POST `initialize` -> obtain an mcp-session-id.
 *   2. Seed the session DO's `state.counter` to a sentinel (default 7) via the
 *      worker's `/introspect?action=seed` route.
 *   3. Probe: confirm the sentinel stuck and the session is `initialized`.
 *   4. DELETE the session. With `--abort`, the client connection is aborted
 *      right after the request is sent, mimicking the disconnected client that
 *      used to cut the old `waitUntil(destroy())` short.
 *   5. Poll `/introspect?action=probe` until the session DO is fully wiped
 *      (counter back to initialState 1, no condemned marker, no alarm, not
 *      initialized) — or fail if it stays a zombie past the timeout.
 *
 * Run (from wip/issue-1625-live):
 *   pnpm run repro -- --deploy                 # deploy, test, leave it up
 *   pnpm run repro -- --deploy --cleanup       # deploy, test, then delete it
 *   pnpm run repro -- --url https://issue-1625-live.<you>.workers.dev
 *   pnpm run repro -- --url <...> --abort      # simulate the disconnected client
 *
 * Exit code: 0 = PASS (teardown converged), 1 = FAIL (zombie/stuck), 2 = setup
 * error (couldn't init the session, no URL, etc.).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, "..");

type Args = {
  url: string | null;
  deploy: boolean;
  cleanup: boolean;
  abort: boolean;
  sentinel: number;
  timeoutMs: number;
  pollMs: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const has = (name: string) => argv.includes(`--${name}`);
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    url: argv.includes("--url") ? get("url", "") : null,
    deploy: has("deploy"),
    cleanup: has("cleanup"),
    abort: has("abort"),
    sentinel: Number(get("sentinel", "7")),
    timeoutMs: Number(get("timeout", "30000")),
    pollMs: Number(get("poll", "1000"))
  };
}

const args = parseArgs();

function log(msg: string): void {
  console.log(`[repro] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deployAndResolveUrl(): string {
  log("deploying with `wrangler deploy`…");
  const out = execSync("npx wrangler deploy", {
    cwd: PKG_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  process.stdout.write(out);
  const match = out.match(/https:\/\/[^\s]*\.workers\.dev/);
  if (!match) {
    throw new Error(
      "could not find a *.workers.dev URL in `wrangler deploy` output"
    );
  }
  return match[0];
}

function cleanupDeployment(): void {
  log("deleting worker with `wrangler delete`…");
  try {
    // Feed "y" to the confirmation prompt so this works in a non-TTY shell.
    execSync("npx wrangler delete --name issue-1625-live", {
      cwd: PKG_DIR,
      input: "y\n",
      stdio: ["pipe", "inherit", "inherit"]
    });
  } catch (err) {
    log(`cleanup failed (delete it manually): ${String(err)}`);
  }
}

/** Poll the health route until the worker is reachable (covers post-deploy
 * propagation lag, which otherwise 404s the first request). */
async function waitForReady(baseUrl: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`worker at ${baseUrl} did not become ready`);
}

/** POST an MCP `initialize` and return the assigned session id. */
async function mcpInitialize(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "issue-1625-repro", version: "1.0" },
        protocolVersion: "2025-03-26"
      }
    })
  });
  const sessionId = res.headers.get("mcp-session-id");
  // Drain the body so the connection can be reused/closed cleanly.
  await res.body?.cancel();
  if (res.status !== 200 || !sessionId) {
    throw new Error(
      `initialize failed: status=${res.status} session=${sessionId}`
    );
  }
  return sessionId;
}

type TeardownProbe = {
  counter: number;
  markerPresent: boolean;
  hasAlarm: boolean;
  initialized: boolean;
};

async function seed(
  baseUrl: string,
  session: string,
  counter: number
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/introspect?action=seed&session=${encodeURIComponent(session)}&counter=${counter}`
  );
  if (!res.ok) throw new Error(`seed failed: status=${res.status}`);
  await res.body?.cancel();
}

async function probe(baseUrl: string, session: string): Promise<TeardownProbe> {
  const res = await fetch(
    `${baseUrl}/introspect?action=probe&session=${encodeURIComponent(session)}`
  );
  if (!res.ok) throw new Error(`probe failed: status=${res.status}`);
  return (await res.json()) as TeardownProbe;
}

/** DELETE the session. With `abort`, drop the client connection right after the
 * request is dispatched — the disconnected-client condition behind #1625. */
async function deleteSession(
  baseUrl: string,
  session: string,
  abort: boolean
): Promise<number | "aborted"> {
  const controller = new AbortController();
  const req = fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": session },
    signal: controller.signal
  });
  if (abort) {
    // Give the request just enough time to leave the client, then bail — the
    // server keeps processing but the client is gone, exactly the case that
    // starved the old `waitUntil(destroy())`.
    setTimeout(() => controller.abort(), 50);
  }
  try {
    const res = await req;
    const status = res.status;
    await res.body?.cancel();
    return status;
  } catch (err) {
    if (controller.signal.aborted) return "aborted";
    throw err;
  }
}

function tornDown(p: TeardownProbe): boolean {
  return p.counter === 1 && !p.markerPresent && !p.hasAlarm && !p.initialized;
}

async function main(): Promise<number> {
  let baseUrl = args.url;
  if (!baseUrl && args.deploy) baseUrl = deployAndResolveUrl();
  if (!baseUrl) {
    log("ERROR: provide --url <deployed-url> or --deploy");
    return 2;
  }
  baseUrl = baseUrl.replace(/\/$/, "");
  log(`target: ${baseUrl} (abort=${args.abort}, sentinel=${args.sentinel})`);

  try {
    await waitForReady(baseUrl);
    const session = await mcpInitialize(baseUrl);
    log(`initialized session ${session}`);

    await seed(baseUrl, session, args.sentinel);
    const seeded = await probe(baseUrl, session);
    log(`after seed: ${JSON.stringify(seeded)}`);
    if (seeded.counter !== args.sentinel || !seeded.initialized) {
      log(
        `ERROR: seed did not take (counter=${seeded.counter}, initialized=${seeded.initialized})`
      );
      return 2;
    }

    const deleteResult = await deleteSession(baseUrl, session, args.abort);
    log(`DELETE result: ${deleteResult}`);

    const start = Date.now();
    let last: TeardownProbe | undefined;
    while (Date.now() - start < args.timeoutMs) {
      try {
        last = await probe(baseUrl, session);
      } catch (err) {
        // A 500/connection error here is expected transient noise: `destroy()`
        // ends by aborting the isolate, which poisons any in-flight RPC racing
        // it. Keep polling — a fresh stub resolves a fresh DO.
        log(`poll +${Date.now() - start}ms: probe transient (${String(err)})`);
        await sleep(args.pollMs);
        continue;
      }
      log(
        `poll +${Date.now() - start}ms: counter=${last.counter} marker=${last.markerPresent} alarm=${last.hasAlarm} initialized=${last.initialized}`
      );
      if (tornDown(last)) {
        console.log("\n================ RESULT ================");
        console.log(
          `PASS: session DO fully torn down in ~${Date.now() - start}ms`
        );
        console.log(`  abort mode:   ${args.abort}`);
        console.log(`  final probe:  ${JSON.stringify(last)}`);
        console.log("========================================\n");
        return 0;
      }
      await sleep(args.pollMs);
    }

    console.log("\n================ RESULT ================");
    console.log(`FAIL: teardown did not converge within ${args.timeoutMs}ms`);
    console.log(`  last probe: ${JSON.stringify(last)}`);
    if (last && last.counter === args.sentinel) {
      console.log(
        "  -> counter still holds the sentinel: this is the #1625 ZOMBIE (storage survived a cut-short teardown)."
      );
    } else if (last?.markerPresent) {
      console.log(
        "  -> condemned marker still present: teardown started but is stuck (check `wrangler tail` for alarm errors)."
      );
    }
    console.log("========================================\n");
    return 1;
  } finally {
    if (args.cleanup && args.deploy) cleanupDeployment();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[repro] error:", err);
    process.exit(2);
  });
