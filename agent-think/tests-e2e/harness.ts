/**
 * E2E test harness: spawn `wrangler dev --local` once, share across tests.
 *
 * Boot is slow (~30s — docker container, miniflare setup). We keep wrangler
 * running for the whole vitest process and tear it down on shutdown.
 *
 * Tests talk to it over HTTP as gh-app would over the service binding, so the
 * whole stack (ThinkAgent DO, container-backed Workspace, real gh/git/npm) is
 * exercised end-to-end. Only model inference is replaced by the test Worker;
 * this is how we reproduce locally why a run silently wedges.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 8799);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;
const output: string[] = [];

export function wranglerOutput(): string {
  return output.join("");
}

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

  // Build assets and seed the real local R2 binding before workerd starts.
  execFileSync("pnpm", ["build:client"], {
    cwd: resolve(process.cwd()),
    env,
    stdio: "pipe"
  });
  seedLocalSkills(env);

  const args = [
    "wrangler",
    "dev",
    "--config",
    "tests-e2e/wrangler.jsonc",
    "--local",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    "0"
  ];
  proc = spawn("npx", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: resolve(process.cwd()),
    detached: true // own process group so we can SIGKILL the whole tree
  });

  output.length = 0;
  proc.stdout?.on("data", (chunk) => output.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => output.push(chunk.toString()));

  const deadline = Date.now() + 180_000; // cold docker build can take a while
  while (Date.now() < deadline) {
    if (!proc || proc.exitCode !== null) {
      throw new Error("wrangler exited during startup:\n" + wranglerOutput());
    }
    if (await isUp()) return;
    await sleep(1000);
  }
  await stopWrangler();
  throw new Error(
    "wrangler dev failed to come up in time\n" + wranglerOutput()
  );
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

function seedLocalSkills(env: NodeJS.ProcessEnv): void {
  const root = resolve(process.cwd());
  for (const entry of readdirSync(resolve(root, "skills"), {
    withFileTypes: true
  })) {
    if (!entry.isDirectory()) continue;
    const file = resolve(root, "skills", entry.name, "SKILL.md");
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `agent-think-skills/.agents/skills/${entry.name}/SKILL.md`,
        "--file",
        file,
        "--local",
        "--config",
        "tests-e2e/wrangler.jsonc"
      ],
      { cwd: root, env, stdio: "pipe" }
    );
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
