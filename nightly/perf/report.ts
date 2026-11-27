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
 * Run every scenario, one at a time. When the local runtime is found down
 * after a scenario (the release does not recover some faults), a fresh one
 * starts and that scenario runs once more on it: only a scenario that fails
 * again on a fresh runtime is reported broken.
 */
async function runLocal(
  out: string,
  port: number
): Promise<Record<string, Result>> {
  let stop = await startDev(out, port);
  const results: Record<string, Result> = {};
  const rerun = new Set<string>();
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
      if (!(await alive(port))) {
        stop();
        stop = await startDev(out, port);
        if (!rerun.has(next) && Object.values(batch).some(failed)) {
          rerun.add(next);
          continue;
        }
      }
      Object.assign(results, batch);
    }
  } finally {
    stop();
  }
  return results;
}

/** A scenario that threw or timed out measured nothing comparable. */
const failed = (r: Result) =>
  r.ok === false ||
  Boolean(r.error) ||
  Boolean((r.value as { timeout?: boolean } | undefined)?.timeout);

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
  const get = (m: string, r: Result | undefined) =>
    r && !failed(r) ? METRICS[m](r) : undefined;
  // A facet scenario's levels (the leaf, @mid, @root) are one tree: its
  // cost is their sum, so only the sum row is bolded.
  const levelsOf = (results: Record<string, Result>, key: string) =>
    Object.keys(results).filter((k) => k === key || k.startsWith(`${key}@`));
  const total = (m: string, results: Record<string, Result>, key: string) => {
    const vals = levelsOf(results, key).map((k) => get(m, results[k]));
    return vals.length && vals.every((v) => v != null)
      ? (vals as number[]).reduce((x, y) => x + y, 0)
      : undefined;
  };
  const row = (
    label: string,
    cell: (m: string) => [number?, number?],
    bold: boolean
  ) =>
    `| ${label} | ${names
      .map((m) => {
        const [a, b] = cell(m);
        const txt = `${a ?? "–"} / ${b ?? "–"}`;
        return bold && a != null && b != null && b > a ? `**${txt}**` : txt;
      })
      .join(" | ")} |`;
  for (const key of [
    ...new Set([...Object.keys(release), ...Object.keys(main)])
  ]) {
    const facet = key.startsWith("facet/");
    lines.push(
      row(key, (m) => [get(m, release[key]), get(m, main[key])], !facet)
    );
  }
  // The sum rows go after each facet tree's last level.
  for (let i = lines.length - 1; i >= 2; i--) {
    const key = lines[i].slice(2, lines[i].indexOf(" |"));
    if (!key.startsWith("facet/")) continue;
    const base = key.split("@")[0];
    const nextKey = lines[i + 1]?.slice(2, lines[i + 1].indexOf(" |"));
    if (nextKey?.split("@")[0] === base) continue;
    if (levelsOf(main, base).length < 2) continue;
    lines.splice(
      i + 1,
      0,
      row(
        `${base} (sum)`,
        (m) => [total(m, release, base), total(m, main, base)],
        true
      )
    );
  }
  return lines.join("\n");
}

const scratch = mkdtempSync(path.join(tmpdir(), "nightly-perf-release-"));
try {
  const versions = releaseBundle(scratch);
  bundle(DIR, path.join(scratch, "main"));
  const release = await runLocal(path.join(scratch, "out"), 8791);
  const main = await runLocal(path.join(scratch, "main"), 8793);
  const why = (r: Result) =>
    r.error ??
    ((r.value as { timeout?: boolean } | undefined)?.timeout
      ? "no reply within 30 s"
      : "failed");
  const bad = Object.entries(main).filter(([, r]) => failed(r));
  // Broken: fails on this build where the release did not. A scenario that
  // fails on both is listed, but it is not this build's regression.
  const broken = bad.filter(([k]) => !release[k] || !failed(release[k]));
  const both = bad.filter(([k]) => release[k] && failed(release[k]));
  const report = [
    `## Storage cost per scenario: release (${Object.entries(versions)
      .map(([p, v]) => `${p}@${v}`)
      .join(", ")}) / this build`,
    "",
    "Bold: this build costs more than the release. A facet scenario is bolded on its (sum) row: the leaf, @mid and @root are one tree.",
    "",
    table(release, main),
    ...(broken.length
      ? [
          "",
          `Broken on this build: ${broken.map(([k, r]) => `${k} (${why(r)})`).join("; ")}`
        ]
      : []),
    ...(both.length
      ? [
          "",
          `Failing on the release and on this build (no numbers): ${both.map(([k, r]) => `${k} (${why(r)})`).join("; ")}`
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
