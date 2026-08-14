import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEMO_ENTRYPOINT = "dist/rebuild/src/demo/interactive.js";

async function runDemo(
  args: readonly string[],
  input: string,
  env?: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; output: string; errors: string }> {
  const child = spawn(process.execPath, [DEMO_ENTRYPOINT, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(env !== undefined ? { env } : {})
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  child.stdin.end(input);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { exitCode, output, errors };
}

test("interactive demo accepts terminal input and prints a reply", async () => {
  const result = await runDemo(
    ["--db", ":memory:"],
    "I feel optimistic\n/quit\n"
  );
  assert.equal(result.exitCode, 0, result.errors);
  assert.match(result.output, /model=eliza, context=window/);
  assert.match(result.output, /Agent> Tell me more about feeling optimistic\./);
});

test("CLI composes the practical strategy choices", async () => {
  const result = await runDemo(
    [
      "--db",
      ":memory:",
      "--context",
      "compactor",
      "--admission",
      "priority",
      "--middleware",
      "tollbooth",
      "--loop",
      "planner"
    ],
    "please help me plan\n/quit\n"
  );
  assert.equal(result.exitCode, 0, result.errors);
  assert.match(result.output, /context=compactor/);
  assert.match(result.output, /admission=priority/);
  assert.match(result.output, /middleware=tollbooth/);
  assert.match(result.output, /loop=planner/);
  assert.match(result.output, /Agent>/);
});

test("CLI composes the wacky strategy choices", async () => {
  const result = await runDemo(
    [
      "--db",
      ":memory:",
      "--context",
      "librarian",
      "--admission",
      "bouncer",
      "--loop",
      "debater"
    ],
    "please debate this\n/quit\n"
  );
  assert.equal(result.exitCode, 0, result.errors);
  assert.match(result.output, /context=librarian/);
  assert.match(result.output, /admission=bouncer/);
  assert.match(result.output, /loop=debater/);
  assert.match(result.output, /Agent>/);
});

test("--db persists the session: a second run replays the conversation", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "rebuild-demo-")), "session.db");
  const first = await runDemo(["--db", db], "I feel optimistic\n/quit\n");
  assert.equal(first.exitCode, 0, first.errors);
  assert.match(first.output, /Agent> Tell me more about feeling optimistic\./);

  const second = await runDemo(["--db", db], "/quit\n");
  assert.equal(second.exitCode, 0, second.errors);
  assert.match(second.output, /resuming session/);
  assert.match(second.output, /You> I feel optimistic/);
  assert.match(second.output, /Agent> Tell me more about feeling optimistic\./);
});

test("the bouncer's silence is made visible", async () => {
  const result = await runDemo(
    ["--db", ":memory:", "--admission", "bouncer"],
    "no magic word here\n/quit\n"
  );
  assert.equal(result.exitCode, 0, result.errors);
  assert.match(result.output, /no turn was admitted/);
});

test("AI SDK selection crashes when no gateway token is present", async () => {
  // No fallback model, by design: it fails loudly rather than degrading.
  const env = { ...process.env };
  delete env.AI_GATEWAY_KEY;
  const result = await runDemo(
    ["--db", ":memory:", "--model", "ai-sdk"],
    "",
    env
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.errors, /No gateway token/);
});

test("the removed --provider flag is rejected, not silently ignored", async () => {
  const result = await runDemo(
    ["--db", ":memory:", "--provider", "./whatever.mjs"],
    ""
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.errors, /Unknown option/);
});
