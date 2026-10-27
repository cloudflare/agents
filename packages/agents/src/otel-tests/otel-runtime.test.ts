/**
 * End-to-end check of `experimental_registerOpenTelemetry()` in workerd: packs this
 * package, installs it into a scratch Worker next to AI SDK v6, runs
 * `wrangler dev`, and reads the recorded native spans back from Local
 * Explorer.
 *
 *   pnpm run build
 *   pnpm run test:otel-runtime
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "../..");
const fixtureDir = path.join(import.meta.dirname, "fixture");
// The first wrangler release whose workerd has span IDs, status and rename.
const WRANGLER_VERSION = process.env.OTEL_TEST_WRANGLER ?? "4.153.0";

type Row = {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly attributes: Record<string, unknown>;
};

let workDir: string;
let wrangler: ChildProcess | undefined;
let base: string;
let output = "";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("No free port");
  }
  return address.port;
}

async function query(sql: string): Promise<Row[]> {
  const response = await fetch(
    `${base}/cdn-cgi/local/explorer/api/local/observability/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql })
    }
  );
  const payload = (await response.json()) as {
    success: boolean;
    result: { columns: string[]; rows: unknown[][] };
  };
  expect(payload.success, JSON.stringify(payload)).toBe(true);
  return payload.result.rows.map((row) => {
    const record = Object.fromEntries(
      payload.result.columns.map((column, i) => [column, row[i]])
    );
    return {
      ...record,
      attributes: JSON.parse(String(record.attributes ?? "{}"))
    } as Row;
  });
}

/** Clears recorded spans, requests `pathname`, and waits for `expected` span names. */
async function trace(pathname: string, expected: readonly string[]) {
  await fetch(`${base}/cdn-cgi/local/explorer/api/local/observability/clear`, {
    method: "POST"
  });
  const response = await fetch(`${base}${pathname}`);
  const body = await response.text();
  expect(response.status, body).toBe(200);

  let rows: Row[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    rows = await query(
      "select trace_id, span_id, parent_id, name, json(attributes) as attributes from spans order by start_ms"
    );
    const names = new Set(rows.map((row) => row.name));
    if (expected.every((name) => names.has(name))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const byId = new Map(rows.map((row) => [row.span_id, row]));
  const spans = (name: string) => rows.filter((row) => row.name === name);
  const span = (name: string, filter: (row: Row) => boolean = () => true) => {
    const matches = spans(name).filter(filter);
    expect(
      matches,
      `${name} in ${JSON.stringify(rows.map((r) => r.name))}`
    ).toHaveLength(1);
    return matches[0];
  };
  const parentOf = (row: Row) =>
    row.parent_id === null ? undefined : byId.get(row.parent_id);
  const childrenOf = (row: Row) =>
    rows.filter((candidate) => candidate.parent_id === row.span_id);
  return { body, rows, span, spans, parentOf, childrenOf };
}

beforeAll(async () => {
  if (!fs.existsSync(path.join(packageDir, "dist/observability/index.js"))) {
    throw new Error("Build the package first: pnpm run build");
  }
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-otel-runtime-"));
  execFileSync("pnpm", ["pack", "--pack-destination", workDir], {
    cwd: packageDir,
    stdio: "pipe"
  });
  const agentsTarball = fs
    .readdirSync(workDir)
    .find((entry) => entry.startsWith("agents-") && entry.endsWith(".tgz"));
  for (const file of fs.readdirSync(fixtureDir)) {
    fs.copyFileSync(path.join(fixtureDir, file), path.join(workDir, file));
  }

  fs.writeFileSync(
    path.join(workDir, "package.json"),
    JSON.stringify(
      {
        name: "agents-otel-runtime-fixture",
        private: true,
        type: "module",
        dependencies: {
          agents: `file:./${agentsTarball}`,
          ai: "^6.0.0",
          wrangler: WRANGLER_VERSION,
          zod: "^4.0.0"
        }
      },
      null,
      2
    )
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: workDir,
    stdio: "pipe"
  });
  // One copy of the OTel API, as in a user's project.
  const otelCopies = execFileSync(
    "npm",
    ["ls", "@opentelemetry/api", "--all", "--parseable"],
    {
      cwd: workDir
    }
  )
    .toString()
    .split("\n")
    .filter(Boolean);
  expect(new Set(otelCopies).size, otelCopies.join("\n")).toBe(1);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wrangler = spawn(
    path.join(workDir, "node_modules/.bin/wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", String(port)],
    {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true" }
    }
  );
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  wrangler.stdout?.on("data", capture);
  wrangler.stderr?.on("data", capture);
  wrangler.on("error", () => {});

  for (let attempt = 0; attempt < 300; attempt++) {
    if (wrangler.exitCode !== null) {
      throw new Error(`wrangler dev exited:\n${output}`);
    }
    try {
      const ready = await fetch(`${base}/ready`, {
        signal: AbortSignal.timeout(1000)
      });
      if (ready.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev did not start:\n${output}`);
}, 300_000);

afterAll(() => {
  if (wrangler?.pid !== undefined) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (workDir !== undefined) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

describe("experimental_registerOpenTelemetry() in workerd", () => {
  it("records plain OTel spans with platform spans nested inside", async () => {
    const { span, parentOf, childrenOf } = await trace("/otel", [
      "user span",
      "manual span",
      "kv_get"
    ]);
    const request = span("GET");
    for (const name of ["user span", "manual span"]) {
      const otelSpan = span(name);
      expect(parentOf(otelSpan)?.span_id).toBe(request.span_id);
      expect(childrenOf(otelSpan).map((child) => child.name)).toEqual([
        "kv_get"
      ]);
    }
  });

  it("records AI SDK v6 experimental_telemetry spans", async () => {
    const { span, parentOf, childrenOf } = await trace("/ai-telemetry", [
      "ai.generateText",
      "ai.generateText.doGenerate"
    ]);
    const top = span("ai.generateText");
    const call = span("ai.generateText.doGenerate");
    expect(parentOf(top)?.name).toBe("GET");
    expect(parentOf(call)?.span_id).toBe(top.span_id);
    expect(childrenOf(call).map((child) => child.name)).toEqual(["kv_get"]);
  });

  it("nests Agents SDK spans and OTel spans in one tree", async () => {
    const { span, parentOf, childrenOf } = await trace("/agent-spans", [
      "otel outer",
      "invoke_agent weather-agent",
      "model work"
    ]);
    const outer = span("otel outer");
    const agent = span("invoke_agent weather-agent");
    const work = span("model work");
    expect(parentOf(outer)?.name).toBe("GET");
    expect(parentOf(agent)?.span_id).toBe(outer.span_id);
    expect(parentOf(work)?.name).toMatch(/^chat /);
    expect(parentOf(parentOf(work)!)?.span_id).toBe(agent.span_id);
    expect(childrenOf(work).map((child) => child.name)).toEqual(["kv_get"]);
  });
});
