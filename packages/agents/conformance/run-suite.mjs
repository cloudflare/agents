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
const baselinePath = takeOption("--baseline", { required: true });
const specVersion = takeOption("--spec-version");
const suite = takeOption("--suite") ?? "all";
const scenario = takeOption("--scenario");
const scenarioList = takeOption("--scenarios");
if (scenario && scenarioList) {
  throw new Error("Use either --scenario or --scenarios, not both");
}
const explicitScenarios = scenario ?? scenarioList;
const driver = takeOption("--driver");
const url = takeOption("--url");
const concurrency = Number(
  takeOption("--concurrency") ?? (role === "client" ? 6 : 1)
);
const clientTimeoutMs = Number(takeOption("--client-timeout") ?? 90_000);
const scenarioTimeoutMs = Number(takeOption("--scenario-timeout") ?? 120_000);

if (argv.length > 0) throw new Error(`Unknown arguments: ${argv.join(" ")}`);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--concurrency must be a positive integer");
}
if (role === "client" && !driver)
  throw new Error("Client role requires --driver");
if (role === "server" && !url) throw new Error("Server role requires --url");
if (suite !== "all" && suite !== "extensions") {
  throw new Error(`Unsupported suite ${suite}; expected all or extensions`);
}
if (suite === "extensions" && specVersion) {
  throw new Error(
    "Extension scenarios are off the spec timeline; omit --spec-version"
  );
}

function runNode(
  args,
  { timeoutMs = scenarioTimeoutMs, env = process.env } = {}
) {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(process.execPath, args, {
      env,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer;

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
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, timeoutMs);
    child.on("error", (error) => {
      finish({ code: -1, stdout, stderr: `${stderr}\n${error}`, timedOut });
    });
    child.on("close", (code, signal) => {
      // The direct CLI can exit before a spawned driver/mock server. Make the
      // timeout terminal for the whole group before advancing to another case.
      if (timedOut) kill("SIGKILL");
      finish({ code: code ?? (signal ? 1 : 0), stdout, stderr, timedOut });
    });
  });
}

function parseListedScenarios(output) {
  const rows = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^  - (\S+)(?: \[([^\]]+)\])?$/);
    if (match) {
      rows.push({
        name: match[1],
        tags: match[2]?.split(",").map((value) => value.trim()) ?? []
      });
    }
  }
  return rows;
}

async function selectedScenarios() {
  if (explicitScenarios) {
    const selected = explicitScenarios
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (selected.length === 0) throw new Error("--scenarios selected nothing");
    return selected;
  }

  const args = [
    conformance,
    "list",
    role === "client" ? "--client" : "--server"
  ];
  if (specVersion) args.push("--spec-version", specVersion);
  const listed = await runNode(args, { timeoutMs: 30_000 });
  if (listed.code !== 0) {
    throw new Error(
      `Failed to list conformance scenarios:\n${listed.stderr || listed.stdout}`
    );
  }
  const rows = parseListedScenarios(listed.stdout);
  const selected =
    suite === "extensions"
      ? rows
          .filter((row) => row.tags.includes("extension"))
          .map((row) => row.name)
      : rows.map((row) => row.name);
  if (selected.length === 0)
    throw new Error("Selected conformance suite is empty");
  return selected;
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

const scenarios = await selectedScenarios();
const duplicateScenarios = duplicates(scenarios);
if (duplicateScenarios.length > 0) {
  throw new Error(
    `Duplicate selected scenarios: ${duplicateScenarios.join(", ")}`
  );
}

const baselineDocument = parseYaml(await readFile(baselinePath, "utf8")) ?? {};
const expected = baselineDocument[role] ?? [];
if (
  !Array.isArray(expected) ||
  !expected.every((value) => typeof value === "string")
) {
  throw new Error(`${baselinePath} must contain a ${role}: string[] baseline`);
}
const duplicateExpected = duplicates(expected);
if (duplicateExpected.length > 0) {
  throw new Error(
    `Duplicate baseline entries: ${duplicateExpected.join(", ")}`
  );
}
const selectedSet = new Set(scenarios);
const unseenBaseline = expected.filter(
  (scenario) => !selectedSet.has(scenario)
);
// A manually focused run may select one scenario from a larger lane baseline.
// Full CI lanes never pass --scenario(s), so coverage remains fail-closed there.
if (!explicitScenarios && unseenBaseline.length > 0) {
  throw new Error(
    `Baseline entries not selected by this run: ${unseenBaseline.join(", ")}`
  );
}

if (role === "client") {
  const manifest = await runNode([driver, "--list-scenarios"], {
    timeoutMs: 10_000
  });
  if (manifest.code !== 0) {
    throw new Error(
      `Failed to read driver scenario manifest:\n${manifest.stderr}`
    );
  }
  const supported = new Set(manifest.stdout.trim().split("\n").filter(Boolean));
  const unsupported = scenarios.filter((scenario) => !supported.has(scenario));
  if (unsupported.length > 0) {
    throw new Error(
      `Driver does not implement selected upstream scenarios: ${unsupported.join(", ")}`
    );
  }
}

const selectedExpected = expected.filter((entry) => selectedSet.has(entry));
console.log(
  `Running ${scenarios.length} official ${role} scenarios` +
    `${specVersion ? ` at ${specVersion}` : ""}` +
    `${suite === "extensions" ? " (extensions)" : ""}` +
    `; ${selectedExpected.length} selected expected failure(s).`
);

function parseChecks(stdout) {
  const trimmed = stdout.trim();
  const resultsMarker = trimmed.lastIndexOf("\nTest Results:");
  const beforeResults =
    resultsMarker === -1 ? trimmed : trimmed.slice(0, resultsMarker).trim();
  const topLevelArray = beforeResults.lastIndexOf("\n[");
  const candidates = [
    trimmed,
    ...(topLevelArray >= 0 ? [beforeResults.slice(topLevelArray + 1)] : [])
  ];
  for (let index = trimmed.lastIndexOf("\n["); index >= 0; ) {
    candidates.push(trimmed.slice(index + 1));
    index = trimmed.lastIndexOf("\n[", index - 1);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next JSON-array boundary.
    }
  }
  return undefined;
}

function parseCounts(output, checks) {
  const matches = [
    ...output.matchAll(
      /Passed:\s*(\d+)\/(\d+),\s*(\d+) failed,\s*(\d+) warnings/g
    )
  ];
  const match = matches.at(-1);
  if (!match) return undefined;
  const skipped =
    checks?.filter((check) => check?.status === "SKIPPED").length ?? 0;
  return {
    passed: Number(match[1]),
    denominator: Number(match[2]),
    failed: Number(match[3]),
    warnings: Number(match[4]),
    skipped
  };
}

function diagnosticLines(result) {
  const selected = result.output
    .split("\n")
    .filter((line) =>
      /Client exited|Scenario failed|Passed:|OVERALL:|timed out|SKIPPED:/.test(
        line
      )
    );
  const failedChecks =
    result.checks
      ?.filter(
        (check) => check?.status === "FAILURE" || check?.status === "WARNING"
      )
      .map(
        (check) =>
          `${check.status === "WARNING" ? "warning" : "failure"}: ${check.name}: ${check.errorMessage ?? check.description}`
      ) ?? [];
  return [...selected.slice(-12), ...failedChecks.slice(0, 30)].join("\n");
}

async function runScenario(scenario) {
  const args = [conformance, role, "--verbose"];
  if (role === "client") {
    args.push(
      "--command",
      `${process.execPath} ${driver}`,
      "--scenario",
      scenario,
      "--timeout",
      String(clientTimeoutMs)
    );
  } else {
    args.push("--url", url, "--scenario", scenario);
  }
  if (specVersion) args.push("--spec-version", specVersion);

  const result = await runNode(args);
  const output = `${result.stdout}\n${result.stderr}`;
  const checks = parseChecks(result.stdout);
  const counts = parseCounts(output, checks);
  // The upstream client suite ignores a non-zero client process when all wire
  // checks happen to pass; the individual CLI exit and this explicit check do not.
  // The server CLI also ignores WARNINGs for its process exit, so count those.
  const failed =
    result.code !== 0 ||
    result.timedOut ||
    !counts ||
    counts.failed > 0 ||
    counts.warnings > 0;
  const notExercised =
    !failed &&
    counts.denominator === 0 &&
    counts.warnings === 0 &&
    counts.skipped > 0;
  return {
    scenario,
    ...result,
    output,
    checks,
    counts,
    failed,
    notExercised
  };
}

const results = new Array(scenarios.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= scenarios.length) return;
    results[index] = await runScenario(scenarios[index]);
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, scenarios.length) }, worker)
);

const expectedSet = new Set(expected);
const clean = [];
const notExercised = [];
const expectedFailures = [];
const unexpectedFailures = [];
const staleBaseline = [];
let checksPassed = 0;
let checksFailed = 0;
let checksWarnings = 0;
let checksSkipped = 0;

for (const result of results) {
  if (result.counts) {
    checksPassed += result.counts.passed;
    checksFailed += result.counts.failed;
    checksWarnings += result.counts.warnings;
    checksSkipped += result.counts.skipped;
  }
  const wasExpected = expectedSet.has(result.scenario);
  if (result.failed && wasExpected) {
    expectedFailures.push(result);
    console.log(`~ ${result.scenario} (expected failure)`);
  } else if (result.failed) {
    unexpectedFailures.push(result);
    console.log(`✗ ${result.scenario} (UNEXPECTED FAILURE)`);
  } else if (wasExpected) {
    staleBaseline.push(result);
    console.log(`! ${result.scenario} (STALE BASELINE: now passes)`);
  } else if (result.notExercised) {
    notExercised.push(result);
    console.log(`- ${result.scenario} (not exercised by upstream referee)`);
  } else {
    clean.push(result);
    console.log(`✓ ${result.scenario}`);
  }
}

for (const result of [...expectedFailures, ...unexpectedFailures]) {
  console.log(`\n--- ${result.scenario} diagnostics ---`);
  const diagnostics = diagnosticLines(result);
  console.log(
    diagnostics || `exit=${result.code}; no conformance summary emitted`
  );
}

console.log("\n=== TRUTHFUL SUITE SUMMARY ===");
console.log(`Scenarios: ${clean.length} clean`);
console.log(`           ${expectedFailures.length} expected failure`);
console.log(`           ${unexpectedFailures.length} unexpected failure`);
console.log(`           ${notExercised.length} not exercised`);
console.log(`           ${staleBaseline.length} stale baseline`);
console.log(
  `Checks:    ${checksPassed} passed, ${checksFailed} failed, ${checksWarnings} warnings, ${checksSkipped} skipped`
);

if (unexpectedFailures.length > 0 || staleBaseline.length > 0) process.exit(1);
