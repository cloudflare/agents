// The perf report: run every perf scenario on local workerd against the
// latest release (agents, @cloudflare/ai-chat and @cloudflare/think from
// npm, installed together) and against this repository's build, and print
// one markdown table: storage cost per scenario, release / this build, bold
// where this build costs more. Report only: it fails only when a run breaks.
//
//   cd nightly && pnpm run perf [scenario-regex]
//
// With GITHUB_STEP_SUMMARY set (a CI job), the table also goes there.

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScenarios, type Result } from "./run";

const DIR = import.meta.dirname;
const WRANGLER = path.join(DIR, "..", "node_modules", ".bin", "wrangler");
const RELEASE = ["agents", "@cloudflare/ai-chat", "@cloudflare/think"];
const only = process.argv[2];

/** Bundle the Worker in `cwd` into `out` without deploying. */
function bundle(cwd: string, out: string) {
  execFileSync(
    WRANGLER,
    [
      "deploy",
      "--dry-run",
      "--outdir",
      out,
      "--config",
      path.join(cwd, "wrangler.jsonc")
    ],
    {
      cwd,
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
}

/** The Worker bundled on the latest release, in a scratch directory. */
function releaseBundle(scratch: string): Record<string, string> {
  const versions = Object.fromEntries(
    RELEASE.map((p) => [
      p,
      execFileSync("npm", ["view", p, "version"], { encoding: "utf8" }).trim()
    ])
  );
  writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      // agents' skills runner imports the optional peer just-bash.
      dependencies: {
        ...versions,
        ai: "^7.0.0",
        zod: "^4.0.0",
        "just-bash": "^3.0.0"
      }
    })
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: scratch, stdio: "ignore" }
  );
  for (const f of ["worker.ts", "meter.ts", "model.ts", "wrangler.jsonc"]) {
    copyFileSync(path.join(DIR, f), path.join(scratch, f));
  }
  bundle(scratch, path.join(scratch, "out"));
  return versions;
}

/** Stop every local runtime this report started, also when it is interrupted. */
const running = new Set<() => void>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const stop of running) stop();
    process.exit(1);
  });
}

/** A local `wrangler dev` of a bundle on fresh state, in its own process group. */
async function startDev(out: string, port: number): Promise<() => void> {
  if (await alive(port)) throw new Error(`port ${port} is in use`);
  const state = mkdtempSync(path.join(tmpdir(), "nightly-perf-state-"));
  const dev = spawn(
    WRANGLER,
    [
      "dev",
      path.join(out, "worker.js"),
      "--no-bundle",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1000),
      "--persist-to",
      state,
      "--log-level",
      "warn"
    ],
    // Its own process group, so wrangler and workerd stop together.
    { cwd: DIR, stdio: "ignore", detached: true }
  );
  const stop = () => {
    running.delete(stop);
    if (dev.pid) {
      try {
        process.kill(-dev.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(state, { recursive: true, force: true });
  };
  running.add(stop);
  for (let i = 0; !(await alive(port)); i++) {
    if (i > 90) {
      stop();
      throw new Error(`wrangler dev on ${port} did not come up`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return stop;
}

function alive(port: number): Promise<boolean> {
  return fetch(`http://localhost:${port}/since/agent/ping`).then(
    (r) => r.ok,
    () => false
  );
}

/**
 * Run every scenario, one at a time. A scenario that takes the local runtime
 * down (the release does not recover some faults) gets a fresh one for the
 * scenarios after it.
 */
async function runLocal(
  out: string,
  port: number
): Promise<Record<string, Result>> {
  let stop = await startDev(out, port);
  const results: Record<string, Result> = {};
  try {
    for (;;) {
      let next: string | undefined;
      const batch = await runScenarios(`http://localhost:${port}`, (key) => {
        if (next || key in results || (only && !new RegExp(only).test(key)))
          return false;
        next = key;
        return true;
      });
      if (!next) break;
      Object.assign(results, batch);
      if (!(await alive(port))) {
        stop();
        stop = await startDev(out, port);
      }
    }
  } finally {
    stop();
  }
  return results;
}

const sum = (c: Record<string, number> | undefined, keys: string[]) =>
  c ? keys.reduce((a, k) => a + (c[k] ?? 0), 0) : undefined;
const userTables = (r: Result) =>
  (r.tables ?? []).filter((t) => !t.table.startsWith("__"));
const METRICS: Record<string, (r: Result) => number | undefined> = {
  stmts: (r) => r.counts?.sqlStatements,
  "rows W": (r) => r.counts?.rowsWritten,
  "rows R": (r) => r.counts?.rowsRead,
  "KV writes": (r) =>
    sum(r.counts, ["kvPut", "kvDelete", "asyncPut", "asyncDelete"]),
  "alarm writes": (r) => sum(r.counts, ["setAlarm", "deleteAlarm"]),
  sync: (r) => r.counts?.sync,
  "rows left": (r) =>
    r.tables ? userTables(r).reduce((a, t) => a + t.rows, 0) : undefined,
  jobs: (r) => r.jobs?.length
};

function table(
  release: Record<string, Result>,
  main: Record<string, Result>
): string {
  const names = Object.keys(METRICS);
  const lines = [
    `| scenario | ${names.join(" | ")} |`,
    `|---|${names.map(() => "---").join("|")}|`
  ];
  for (const key of [
    ...new Set([...Object.keys(release), ...Object.keys(main)])
  ]) {
    const cells = names.map((m) => {
      const get = (r: Result | undefined) =>
        r && r.ok !== false ? METRICS[m](r) : undefined;
      const a = get(release[key]);
      const b = get(main[key]);
      const txt = `${a ?? "–"} / ${b ?? "–"}`;
      return a != null && b != null && b > a ? `**${txt}**` : txt;
    });
    lines.push(`| ${key} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

const scratch = mkdtempSync(path.join(tmpdir(), "nightly-perf-release-"));
try {
  const versions = releaseBundle(scratch);
  bundle(DIR, path.join(scratch, "main"));
  const release = await runLocal(path.join(scratch, "out"), 8791);
  const main = await runLocal(path.join(scratch, "main"), 8793);
  // A scenario that threw or timed out measured nothing comparable.
  const failed = (r: Result) =>
    r.ok === false ||
    Boolean(r.error) ||
    Boolean((r.value as { timeout?: boolean } | undefined)?.timeout);
  const broken = Object.entries(main).filter(([, r]) => failed(r));
  const report = [
    `## Storage cost per scenario: release (${Object.entries(versions)
      .map(([p, v]) => `${p}@${v}`)
      .join(", ")}) / this build`,
    "",
    "Bold: this build costs more than the release.",
    "",
    table(release, main),
    ...(broken.length
      ? [
          "",
          `Broken on this build: ${broken.map(([k, r]) => `${k} (${r.error})`).join("; ")}`
        ]
      : [])
  ].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (broken.length) process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
