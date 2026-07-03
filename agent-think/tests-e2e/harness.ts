/**
 * E2E test harness: spawn `wrangler dev --local` once, share across tests.
 *
 * Boot is slow (~30s — docker container, miniflare setup). We keep wrangler
 * running for the whole vitest process and tear it down on shutdown.
 *
 * Tests talk to it over HTTP as gh-app would over the service binding, so the
 * whole stack (ThinkAgent DO, container-backed Workspace, real gh/git/npm) is
 * exercised end-to-end. No mocks — this is how we reproduce locally why a run
 * silently wedges.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 8799);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;

/** Spawn wrangler dev with .env loaded. Resolves when the server is reachable. */
export async function startWrangler(): Promise<void> {
  if (proc) return;

  // If a previous run left a server on the port (e.g. an interactive
  // `wrangler dev` in another terminal), reuse it instead of crashing.
  if (await isUp()) return;

  const env = { ...process.env };
  // Load GH_TOKEN (and anything else) from a local/parent .env like Aron does,
  // so the harness works both standalone and from the monorepo root.
  for (const rel of ["../.env", ".env"]) {
    try {
      const dotenv = await readFile(resolve(process.cwd(), rel), "utf8");
      for (const line of dotenv.split("\n")) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] && !(m[1] in env)) env[m[1]] = m[2] ?? "";
      }
    } catch {
      /* .env optional */
    }
  }

  // LOCAL_DEV=1 unlocks the /dev/dispatch + /dev/messages HTTP surface that
  // production never exposes (see the LOCAL_DEV gate in src/index.ts).
  env.LOCAL_DEV = "1";

  const args = [
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    "0",
    "--var",
    "LOCAL_DEV:1"
  ];
  proc = spawn("npx", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: resolve(process.cwd()),
    detached: true // own process group so we can SIGKILL the whole tree
  });

  const logs: string[] = [];
  proc.stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => logs.push(chunk.toString()));

  const deadline = Date.now() + 180_000; // cold docker build can take a while
  while (Date.now() < deadline) {
    if (!proc || proc.exitCode !== null) {
      throw new Error("wrangler exited during startup:\n" + logs.join(""));
    }
    if (await isUp()) return;
    await sleep(1000);
  }
  await stopWrangler();
  throw new Error("wrangler dev failed to come up in time\n" + logs.join(""));
}

export async function stopWrangler(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  // Kill the whole process group — plain SIGTERM on the parent leaves the
  // workerd + docker children running.
  try {
    if (p.pid !== undefined) process.kill(-p.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    if (p.pid !== undefined) process.kill(-p.pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

/**
 * Health check: the worker serves plain-text on `/` (the agent-think banner).
 * A 200 there means workerd is up and the module loaded — enough to start
 * driving /dev/dispatch. (Aron checked /api/app/me; this worker's readiness
 * signal is the root banner.)
 */
async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
