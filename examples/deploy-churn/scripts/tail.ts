/**
 * Capture the deployed worker's server-side logs during a churn run.
 *
 * Runs `wrangler tail --format json` and writes every structured `deploy-churn`
 * log line (and any thrown exceptions, e.g. "Durable Object reset because its
 * code was updated") to scripts/runs/tail-<ts>.jsonl. Run this in a second
 * terminal alongside `npm run churn` to get the server's view of the timeline.
 *
 * Note: live tail can briefly disconnect during a deploy; this script restarts
 * it automatically. For a complete, deploy-correlated picture (with scriptVersion
 * per event) use the Workers Observability MCP server after the run — see
 * README.md.
 *
 * Usage (from examples/deploy-churn):
 *   npm run tail -- --worker agents-deploy-churn
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(__dirname, "runs");

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase().replace(/-/g, "_")] ?? fallback;
}

const WORKER_NAME = arg("worker", "agents-deploy-churn");

fs.mkdirSync(RUNS_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(RUNS_DIR, `tail-${runId}.jsonl`);
const out = fs.createWriteStream(outPath, { flags: "a" });

console.log(`Tailing "${WORKER_NAME}" → ${outPath}`);
console.log("Ctrl-C to stop.\n");

let child: ChildProcess | null = null;
let stopping = false;

function write(record: Record<string, unknown>): void {
  out.write(`${JSON.stringify({ capturedAt: Date.now(), ...record })}\n`);
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const event = parsed as Record<string, unknown>;

  // wrangler tail JSON wraps each event; logs are under `.logs`, exceptions
  // under `.exceptions`. Surface our structured lines and any errors.
  const logs = Array.isArray(event.logs) ? event.logs : [];
  for (const entry of logs) {
    const message = (entry as { message?: unknown[] }).message;
    if (!Array.isArray(message)) continue;
    for (const m of message) {
      if (typeof m === "string" && m.includes('"kind":"deploy-churn"')) {
        try {
          write({ source: "log", ...JSON.parse(m) });
        } catch {
          write({ source: "log", raw: m });
        }
      }
    }
  }
  const exceptions = Array.isArray(event.exceptions) ? event.exceptions : [];
  for (const ex of exceptions) {
    write({
      source: "exception",
      exception: ex,
      scriptVersion: event.scriptVersion
    });
    console.log(`[exception] ${JSON.stringify(ex)}`);
  }
}

function start(): void {
  if (stopping) return;
  child = spawn("npx", ["wrangler", "tail", WORKER_NAME, "--format", "json"], {
    cwd: EXAMPLE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  let buffer = "";
  child.stdout?.on("data", (b: Buffer) => {
    buffer += b.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr?.on("data", (b: Buffer) => {
    const text = b.toString().trim();
    if (text) console.error(`[wrangler] ${text}`);
  });
  child.on("close", () => {
    if (stopping) return;
    console.log("tail disconnected; reconnecting in 2s...");
    setTimeout(start, 2000);
  });
}

process.on("SIGINT", () => {
  stopping = true;
  try {
    child?.kill("SIGINT");
  } catch {
    // ignore
  }
  out.end();
  console.log(`\nSaved ${outPath}`);
  process.exit(0);
});

start();
