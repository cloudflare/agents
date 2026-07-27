#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const argv = process.argv.slice(2);
const role = argv.shift();
if (role !== "client" && role !== "server") {
  throw new Error("Usage: run-suite.mjs <client|server> [options]");
}

function takeOption(name, { required = false } = {}) {
  const index = argv.indexOf(name);
  if (index === -1) {
    if (required) throw new Error(`Missing required option ${name}`);
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  argv.splice(index, 2);
  return value;
}

const conformance = takeOption("--conformance", { required: true });
const baselinePath = takeOption("--baseline");
const specVersion = takeOption("--spec-version", { required: true });
const scenario = takeOption("--scenario");
const driver = takeOption("--driver");
const url = takeOption("--url");
const concurrency = Number(
  takeOption("--concurrency") ?? (role === "client" ? 6 : 1)
);
const clientTimeoutMs = Number(takeOption("--client-timeout") ?? 90_000);
const scenarioTimeoutMs = Number(takeOption("--scenario-timeout") ?? 150_000);

if (argv.length > 0) throw new Error(`Unknown arguments: ${argv.join(" ")}`);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--concurrency must be a positive integer");
}
if (role === "client" && !driver) {
  throw new Error("Client role requires --driver");
}
if (role === "server" && !url) throw new Error("Server role requires --url");

function runNode(args, { timeoutMs = scenarioTimeoutMs } = {}) {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(process.execPath, args, {
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const kill = (signal) => {
      try {
        if (useProcessGroup && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process group may already have exited.
      }
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The referee can exit before its spawned driver/mock server. Always
      // tear down the complete group so inherited pipes cannot hang the lane.
      kill("SIGTERM");
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      stderr += `\n${error}`;
      finish(-1);
    });
    child.on("exit", finish);

    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
      finish(1);
    }, timeoutMs);
  });
}

function parseScenarios(output) {
  return output
    .split("\n")
    .map((line) => line.match(/^  - (\S+)/)?.[1])
    .filter(Boolean);
}

async function selectedScenarios() {
  const listed = await runNode(
    [
      conformance,
      "list",
      role === "client" ? "--client" : "--server",
      "--spec-version",
      specVersion
    ],
    { timeoutMs: 30_000 }
  );
  if (listed.code !== 0) {
    throw new Error(
      `Failed to list scenarios:\n${listed.stderr || listed.stdout}`
    );
  }
  const available = parseScenarios(listed.stdout);
  if (scenario) {
    if (!available.includes(scenario)) {
      throw new Error(`Scenario ${scenario} is not selected at ${specVersion}`);
    }
    return [scenario];
  }
  if (available.length === 0) throw new Error("Selected suite is empty");
  return available;
}

async function expectedFailures(selected) {
  if (!baselinePath) return new Set();
  const document = parseYaml(await readFile(baselinePath, "utf8")) ?? {};
  const entries = document[role] ?? [];
  if (
    !Array.isArray(entries) ||
    !entries.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      `${baselinePath} must contain a ${role}: string[] baseline`
    );
  }
  const duplicates = entries.filter(
    (entry, index) => entries.indexOf(entry) !== index
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate baseline entries: ${[...new Set(duplicates)].join(", ")}`
    );
  }
  if (!scenario) {
    const selectedSet = new Set(selected);
    const unseen = entries.filter((entry) => !selectedSet.has(entry));
    if (unseen.length > 0) {
      throw new Error(
        `Baseline entries not selected by this lane: ${unseen.join(", ")}`
      );
    }
  }
  return new Set(entries);
}

async function verifyClientManifest(selected) {
  if (role !== "client") return;
  const manifest = await runNode([driver, "--list-scenarios"], {
    timeoutMs: 10_000
  });
  if (manifest.code !== 0) {
    throw new Error(`Failed to read driver manifest:\n${manifest.stderr}`);
  }
  const supported = new Set(manifest.stdout.trim().split("\n").filter(Boolean));
  const missing = selected.filter((entry) => !supported.has(entry));
  if (missing.length > 0) {
    throw new Error(`Driver does not implement: ${missing.join(", ")}`);
  }
}

const selected = await selectedScenarios();
const expected = await expectedFailures(selected);
await verifyClientManifest(selected);

console.log(
  `Running ${selected.length} official ${role} scenarios at ${specVersion}; ` +
    `${[...expected].filter((entry) => selected.includes(entry)).length} expected failure(s).`
);

async function runScenario(name) {
  const args = [
    conformance,
    role,
    "--scenario",
    name,
    "--spec-version",
    specVersion,
    "--verbose"
  ];
  if (role === "client") {
    args.push(
      "--command",
      `${process.execPath} ${driver}`,
      "--timeout",
      String(clientTimeoutMs)
    );
  } else {
    args.push("--url", url);
  }
  const result = await runNode(args, { timeoutMs: scenarioTimeoutMs });
  // Alpha.10's server command reports WARNING checks but exits zero. Warnings
  // remain non-conformant unless the scenario is explicitly baselined.
  const warned = /"status"\s*:\s*"WARNING"/.test(result.stdout);
  const failed = result.code !== 0 || result.timedOut || warned;
  return { name, expected: expected.has(name), failed, ...result };
}

const results = new Array(selected.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= selected.length) return;
    results[index] = await runScenario(selected[index]);
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, selected.length) }, worker)
);

const unexpected = [];
const stale = [];
for (const result of results) {
  if (result.failed && result.expected) {
    console.log(`~ ${result.name} (expected failure)`);
  } else if (result.failed) {
    unexpected.push(result);
    console.log(`✗ ${result.name} (unexpected failure)`);
  } else if (result.expected) {
    stale.push(result);
    console.log(`! ${result.name} (stale baseline)`);
  } else {
    console.log(`✓ ${result.name}`);
  }
}

for (const result of unexpected) {
  console.log(`\n--- ${result.name} diagnostics ---`);
  const output = `${result.stdout}\n${result.stderr}`.trim().split("\n");
  console.log(output.slice(-40).join("\n") || "No output");
}

console.log("\n=== SUITE SUMMARY ===");
console.log(`Scenarios: ${results.length}`);
console.log(`Unexpected failures: ${unexpected.length}`);
console.log(`Stale baseline entries: ${stale.length}`);

if (unexpected.length > 0 || stale.length > 0) process.exit(1);
