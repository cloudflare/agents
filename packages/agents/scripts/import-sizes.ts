import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareImportSizeSnapshots,
  measurePackageImports,
  parseImportSizeSnapshot,
  writeImportSizeJson,
  type ImportSizeReport
} from "./import-size-report";

const DEFAULT_THRESHOLD_PERCENT = 10;

type Command =
  | {
      readonly name: "measure";
      readonly packageDirectory: string;
      readonly revision: string;
      readonly output: string;
    }
  | {
      readonly name: "compare";
      readonly base: string;
      readonly head: string;
      readonly output: string;
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly workflowRunId: number;
      readonly workflowRunAttempt: number;
      readonly thresholdPercent: number;
      readonly githubStepSummary?: string;
    };

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.name === "measure") {
    const snapshot = await measurePackageImports({
      packageDirectory: command.packageDirectory,
      revision: command.revision
    });
    await writeImportSizeJson(command.output, snapshot);
    console.log(
      `Measured ${snapshot.measurements.length} runtime imports from ${snapshot.packageName}@${snapshot.packageVersion}`
    );
    return;
  }

  const [base, head] = await Promise.all([
    readSnapshot(command.base),
    readSnapshot(command.head)
  ]);
  const report = compareImportSizeSnapshots(base, head, {
    repository: command.repository,
    pullRequestNumber: command.pullRequestNumber,
    workflowRunId: command.workflowRunId,
    workflowRunAttempt: command.workflowRunAttempt,
    thresholdPercent: command.thresholdPercent
  });
  await writeImportSizeJson(command.output, report);
  printReportSummary(report);

  if (command.githubStepSummary !== undefined) {
    await appendFile(
      resolve(command.githubStepSummary),
      renderStepSummary(report),
      "utf8"
    );
  }
}

function parseCommand(args: ReadonlyArray<string>): Command {
  const [commandName, ...rest] = args;
  const flags = parseFlags(rest);
  if (commandName === "measure") {
    return {
      name: "measure",
      packageDirectory: requiredFlag(flags, "package-dir"),
      revision: requiredFlag(flags, "revision"),
      output: requiredFlag(flags, "output")
    };
  }
  if (commandName === "compare") {
    return {
      name: "compare",
      base: requiredFlag(flags, "base"),
      head: requiredFlag(flags, "head"),
      output: requiredFlag(flags, "output"),
      repository: requiredFlag(flags, "repository"),
      pullRequestNumber: positiveIntegerFlag(flags, "pr"),
      workflowRunId: positiveIntegerFlag(flags, "run-id"),
      workflowRunAttempt: positiveIntegerFlag(flags, "run-attempt"),
      thresholdPercent: nonNegativeNumberFlag(
        flags,
        "threshold",
        DEFAULT_THRESHOLD_PERCENT
      ),
      ...(flags.get("github-step-summary") !== undefined
        ? {
            githubStepSummary: requiredFlag(flags, "github-step-summary")
          }
        : {})
    };
  }
  throw new Error("Usage: import-sizes.ts measure|compare --flag value");
}

function parseFlags(args: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args.at(index);
    const value = args.at(index + 1);
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`Invalid command arguments near ${flag ?? "end"}`);
    }
    const name = flag.slice(2);
    if (name.length === 0 || flags.has(name)) {
      throw new Error(`Invalid or duplicate flag ${flag}`);
    }
    flags.set(name, value);
  }
  return flags;
}

function requiredFlag(
  flags: ReadonlyMap<string, string>,
  name: string
): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required --${name} flag`);
  }
  return value;
}

function positiveIntegerFlag(
  flags: ReadonlyMap<string, string>,
  name: string
): number {
  const value = Number(requiredFlag(flags, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumberFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  fallback: number
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return value;
}

async function readSnapshot(path: string) {
  const raw = await readFile(resolve(path), "utf8");
  const value: unknown = JSON.parse(raw);
  const parsed = parseImportSizeSnapshot(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function printReportSummary(report: ImportSizeReport): void {
  console.log(
    [
      `${report.packageName} import sizes: ${report.overall}`,
      `${report.summary.red} red`,
      `${report.summary.yellow} yellow`,
      `${report.summary.green} green`,
      `${report.summary.unchanged} unchanged`,
      `${report.summary.new} new`,
      `${report.summary.removed} removed`
    ].join(", ")
  );

  const notable = report.changes
    .filter(
      (change) =>
        change.status === "red" ||
        change.status === "yellow" ||
        change.status === "green"
    )
    .sort((left, right) => {
      const leftDelta = Math.abs(left.delta?.gzipPercent ?? 0);
      const rightDelta = Math.abs(right.delta?.gzipPercent ?? 0);
      return rightDelta - leftDelta;
    })
    .slice(0, 20);
  for (const change of notable) {
    console.log(
      `  ${change.status.padEnd(6)} ${change.entryPoint}#${change.exportName}: ${formatDelta(change.delta?.gzipBytes, change.delta?.gzipPercent)}`
    );
  }
}

function renderStepSummary(report: ImportSizeReport): string {
  const status = {
    red: "🔴",
    yellow: "🟡",
    green: "🟢",
    unchanged: "⚪"
  }[report.overall];
  return [
    `## ${status} ${report.packageName} import sizes\n`,
    `Measured ${report.summary.total} runtime imports as minified gzip. ` +
      `Increases above ${formatPercent(report.thresholdPercent)} are marked red; this report is informational.\n`,
    `| Red | Yellow | Green | Unchanged | New | Removed |`,
    `| ---: | -----: | ----: | --------: | --: | ------: |`,
    `| ${report.summary.red} | ${report.summary.yellow} | ${report.summary.green} | ${report.summary.unchanged} | ${report.summary.new} | ${report.summary.removed} |\n`
  ].join("\n");
}

function formatDelta(
  bytes: number | undefined,
  percent: number | null | undefined
): string {
  if (bytes === undefined) return "n/a";
  const sign = bytes > 0 ? "+" : "";
  const renderedPercent =
    percent === null || percent === undefined
      ? "n/a"
      : `${percent > 0 ? "+" : ""}${formatPercent(percent)}`;
  return `${sign}${formatBytes(bytes)} (${renderedPercent})`;
}

function formatBytes(bytes: number): string {
  const absolute = Math.abs(bytes);
  if (absolute < 1_024) return `${bytes} B`;
  const value = bytes / 1_024;
  return `${value.toFixed(1)} KiB`;
}

function formatPercent(percent: number): string {
  return `${percent
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1")}%`;
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
