/**
 * Run Think's workers suite against the harness-backed Think and keep score.
 *
 *   pnpm test:harness          run everything, rewrite harness-compat.{md,json}
 *   pnpm test:harness --check  run everything, fail if a test that passed in
 *                              harness-compat.json fails now
 *
 * The denominator is every test the normal suite collects, so a file that
 * fails to load under the harness counts all its tests as failing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type ListedTest = { name: string; file: string };
type AssertionResult = {
  ancestorTitles: string[];
  title: string;
  status: string;
};
type RunReport = {
  testResults: Array<{ name: string; assertionResults: AssertionResult[] }>;
};
type Scoreboard = {
  total: number;
  passed: number;
  /** Tests that fail when Think cannot be constructed: they need Think. */
  needThink: number;
  /** Of those, the ones that pass against the harness-backed Think. */
  needThinkPassed: number;
  files: Record<string, { total: number; passed: number }>;
  passing: string[];
};

const packageDir = path.join(import.meta.dirname, "..");
const scoreboardJson = path.join(packageDir, "harness-compat.json");
const scoreboardMd = path.join(packageDir, "harness-compat.md");
const check = process.argv.includes("--check");
const work = mkdtempSync(path.join(tmpdir(), "think-harness-"));

function vitest(args: string[], env: Record<string, string> = {}): void {
  spawnSync("pnpm", ["exec", "vitest", ...args], {
    cwd: packageDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env }
  });
}

/** Ids of the tests a JSON report records as passing. */
function passedIn(reportFile: string): Set<string> {
  const report = existsSync(reportFile)
    ? (JSON.parse(readFileSync(reportFile, "utf8")) as RunReport)
    : { testResults: [] };
  const ids = new Set<string>();
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status !== "passed") continue;
      ids.add(id(file.name, [...test.ancestorTitles, test.title].join(" > ")));
    }
  }
  return ids;
}

function relative(file: string): string {
  return path.relative(path.join(packageDir, "src", "tests"), file);
}

function id(file: string, name: string): string {
  return `${relative(file)} > ${name}`;
}

// 1. Every test the normal suite has.
const inventoryFile = path.join(work, "inventory.json");
vitest(["list", "-c", "src/tests/vitest.config.ts", `--json=${inventoryFile}`]);
if (!existsSync(inventoryFile)) {
  console.error("Could not list the Think test suite.");
  process.exit(1);
}
const inventory = JSON.parse(
  readFileSync(inventoryFile, "utf8")
) as ListedTest[];

// 2. The same suite against the harness-backed Think.
const reportFile = path.join(work, "report.json");
vitest([
  "--run",
  "-c",
  "src/tests/vitest.harness.config.ts",
  "--reporter=dot",
  "--reporter=json",
  `--outputFile.json=${reportFile}`
]);
const passedIds = passedIn(reportFile);

// 2b. And against a Think that cannot be constructed: whatever still passes
// never constructs Think, so it is not evidence about the harness.
const absentFile = path.join(work, "absent.json");
vitest(
  [
    "--run",
    "-c",
    "src/tests/vitest.harness.config.ts",
    "--reporter=dot",
    "--reporter=json",
    `--outputFile.json=${absentFile}`
  ],
  { THINK_COMPAT_TARGET: "absent" }
);
const withoutThink = passedIn(absentFile);

// 3. Score against the inventory.
const files: Scoreboard["files"] = {};
const passing: string[] = [];
let needThink = 0;
let needThinkPassed = 0;
for (const test of inventory) {
  const key = relative(test.file);
  const testId = id(test.file, test.name);
  files[key] ??= { total: 0, passed: 0 };
  files[key].total += 1;
  const needsThink = !withoutThink.has(testId);
  if (needsThink) needThink += 1;
  if (passedIds.has(testId)) {
    files[key].passed += 1;
    passing.push(testId);
    if (needsThink) needThinkPassed += 1;
  }
}
passing.sort();
const scoreboard: Scoreboard = {
  total: inventory.length,
  passed: passing.length,
  needThink,
  needThinkPassed,
  files: Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
  ),
  passing
};

const percent = (passed: number, total: number) =>
  total === 0 ? "0%" : `${Math.floor((passed / total) * 100)}%`;
console.log(
  `\nThink on ThinkHarness: ${needThinkPassed} of the ${needThink} tests that construct Think pass (${percent(needThinkPassed, needThink)}); ${scoreboard.passed} of all ${scoreboard.total}.`
);

if (check) {
  const recorded = existsSync(scoreboardJson)
    ? (JSON.parse(readFileSync(scoreboardJson, "utf8")) as Scoreboard)
    : { passing: [] as string[] };
  const now = new Set(passing);
  const regressions = recorded.passing.filter((test) => !now.has(test));
  const recordedSet = new Set(recorded.passing);
  const gains = passing.filter((test) => !recordedSet.has(test));
  if (gains.length > 0) {
    console.log(
      `${gains.length} more tests pass than harness-compat.json records. Run pnpm test:harness to record them.`
    );
  }
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} tests that passed now fail:`);
    for (const test of regressions) console.error(`  ${test}`);
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(scoreboardJson, `${JSON.stringify(scoreboard, null, 2)}\n`);
const rows = Object.entries(scoreboard.files).map(
  ([file, { total, passed }]) =>
    `| \`${file}\` | ${passed} / ${total} | ${percent(passed, total)} |`
);
writeFileSync(
  scoreboardMd,
  `# Think on ThinkHarness

Generated by \`pnpm test:harness\`. Do not edit by hand.

Think's workers suite, run against the harness-backed Think in
\`src/harness/think.ts\` instead of \`src/think.ts\`. When every test passes,
Think moves onto \`agents/harness/think\`.

The headline counts only tests that construct Think: the run is repeated
against a Think that throws when constructed, and a test that still passes
there (one that tests a module Think uses, such as extensions or fetch
tools) is left out of it. A failing test that reaches a Think feature the
harness-backed class does not have yet fails with "Think.<name> is not
supported by the harness-backed Think yet".

**${needThinkPassed} of the ${needThink} tests that construct Think pass (${percent(needThinkPassed, needThink)}).** Across the whole suite, ${scoreboard.passed} of ${scoreboard.total}.

| File | Passing | |
| --- | --- | --- |
${rows.join("\n")}
`
);
spawnSync("pnpm", ["exec", "oxfmt", scoreboardMd, scoreboardJson], {
  cwd: packageDir,
  stdio: "ignore"
});
console.log("Wrote harness-compat.md and harness-compat.json.");
