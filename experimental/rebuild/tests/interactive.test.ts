import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const DEMO_ENTRYPOINT = "dist/rebuild/src/demo/interactive.js";

async function runDemo(
  args: readonly string[],
  input: string
): Promise<{ exitCode: number | null; output: string; errors: string }> {
  const child = spawn(process.execPath, [DEMO_ENTRYPOINT, ...args], {
    stdio: ["pipe", "pipe", "pipe"]
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
  const result = await runDemo([], "I feel optimistic\n/quit\n");
  assert.equal(result.exitCode, 0, result.errors);
  assert.match(result.output, /model=eliza, context=window/);
  assert.match(result.output, /Agent> Tell me more about feeling optimistic\./);
});

test("CLI composes the practical strategy choices", async () => {
  const result = await runDemo(
    [
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
    ["--context", "librarian", "--admission", "bouncer", "--loop", "debater"],
    "please debate this\n/quit\n"
  );
  assert.equal(result.exitCode, 0, result.errors);
  assert.match(result.output, /context=librarian/);
  assert.match(result.output, /admission=bouncer/);
  assert.match(result.output, /loop=debater/);
  assert.match(result.output, /Agent>/);
});

test("AI SDK selection crashes when no provider is supplied", async () => {
  const result = await runDemo(["--model", "ai-sdk"], "");
  assert.notEqual(result.exitCode, 0);
  assert.match(result.errors, /requires --provider/);
});
