import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  parseMessageDiagnostics,
  type MessageDiagnostics
} from "../src/diagnostics";
import type { ObservedRuntimeConfig } from "../src/core";
import {
  ARC_AGI_2_COMMIT,
  ARC_AGI_2_REPOSITORY,
  ARC_TASK_PROMPT,
  ARC_TASKS,
  FAST_ARC_TASK_IDS,
  MICRO_ARC_TASKS,
  arcTaskUrl,
  assertArcTask,
  parseArcAnswer,
  scoreArcTask,
  visibleTaskMaterial,
  type ArcScore,
  type ArcTask,
  type ArcTaskSpec,
  type Grid,
  type ParsedArcAnswer
} from "./arc";
import {
  terminalRun as projectTerminalRun,
  type Condition,
  type ConditionRun
} from "./result";

type LoadedTask = {
  spec: ArcTaskSpec;
  material: string;
  gold: Grid[];
};

type DiagnosedConditionRun = ConditionRun & {
  diagnostics?: MessageDiagnostics;
  diagnosticsError?: string;
};

type ScoredRun = DiagnosedConditionRun & {
  parsed: ParsedArcAnswer;
  score: ArcScore;
};

type Options = {
  baseUrl: string;
  runId: string;
  nonce: string;
  suite: "micro" | "fast" | "full";
  taskId?: string;
  limit?: number;
  timeoutMs: number;
};

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

function usage(): string {
  return `Usage: pnpm run eval:arc -- [options]

Options:
  --suite micro|fast|full
                      Three smallest tasks, size-stratified fast (default), or all five strata
  --task-id ID        Run one task from the checked-in micro/full manifests
  --limit N           Run only the first N tasks selected by --suite
  --base-url URL      Running example URL (default: http://localhost:5173)
  --run-id ID         Stable label for this run (default: timestamp + random suffix)
  --timeout-ms N      Per-condition wall timeout (default: 360000)
  --help              Show this message`;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized) throw new Error("run id must contain a letter or number");
  return normalized;
}

function defaultRunId(): string {
  return slug(
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(
      0,
      8
    )}`
  );
}

function invocationNonce(): string {
  return randomUUID().replaceAll("-", "");
}

async function codeRevision(): Promise<{
  commit: string | null;
  dirty: boolean | null;
}> {
  try {
    const [revision, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: EVAL_DIR,
        encoding: "utf8"
      }),
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: EVAL_DIR,
        encoding: "utf8"
      })
    ]);
    return {
      commit: revision.stdout.trim(),
      dirty: status.stdout.trim().length > 0
    };
  } catch {
    return {
      commit: process.env.GITHUB_SHA?.trim() || null,
      dirty: null
    };
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    baseUrl: process.env.RLM_EVAL_BASE_URL ?? "http://localhost:5173",
    runId: defaultRunId(),
    nonce: invocationNonce(),
    suite: "fast",
    timeoutMs: 360_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--suite") {
      if (value !== "micro" && value !== "fast" && value !== "full") {
        throw new Error("--suite must be micro, fast, or full");
      }
      options.suite = value;
    } else if (arg === "--task-id") {
      options.taskId = value;
    } else if (arg === "--limit") {
      options.limit = Number(value);
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
    } else if (arg === "--base-url") {
      options.baseUrl = value.replace(/\/$/, "");
    } else if (arg === "--run-id") {
      options.runId = slug(value);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10_000) {
        throw new Error("--timeout-ms must be an integer of at least 10000");
      }
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
    index += 1;
  }
  if (options.taskId && options.limit !== undefined) {
    throw new Error("--task-id and --limit cannot be used together");
  }
  while (options.nonce === options.runId) {
    options.nonce = invocationNonce();
  }
  return options;
}

async function responseJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      value &&
      typeof value === "object" &&
      typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : `HTTP ${response.status}`;
    throw new Error(`${url}: ${message}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${url}: response was not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseRuntimeConfig(
  value: Record<string, unknown>
): ObservedRuntimeConfig {
  const model = value.model;
  const reasoningEffort = value.reasoningEffort;
  const maxSteps = value.maxSteps;
  const timeoutMs = value.timeoutMs;
  const maxDepth = value.maxDepth;
  const maxRlmCalls = value.maxRlmCalls;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("/eval/config returned an invalid model");
  }
  if (
    reasoningEffort !== null &&
    reasoningEffort !== "low" &&
    reasoningEffort !== "medium" &&
    reasoningEffort !== "high"
  ) {
    throw new Error("/eval/config returned an invalid reasoning effort");
  }
  const integers: Array<[string, unknown, number, number]> = [
    ["maxSteps", maxSteps, 2, 40],
    ["timeoutMs", timeoutMs, 10_000, 900_000],
    ["maxDepth", maxDepth, 0, 1],
    ["maxRlmCalls", maxRlmCalls, 0, 16]
  ];
  for (const [name, observed, minimum, maximum] of integers) {
    if (
      !Number.isInteger(observed) ||
      (observed as number) < minimum ||
      (observed as number) > maximum
    ) {
      throw new Error(`/eval/config returned an invalid ${name}`);
    }
  }
  return {
    model,
    reasoningEffort,
    maxSteps: maxSteps as number,
    timeoutMs: timeoutMs as number,
    maxDepth: maxDepth as number,
    maxRlmCalls: maxRlmCalls as number
  };
}

async function withMessageDiagnostics(
  run: DiagnosedConditionRun,
  url: string,
  timeoutMs: number
): Promise<DiagnosedConditionRun> {
  try {
    const result = await responseJson(
      url,
      { method: "GET" },
      Math.min(timeoutMs, 10_000)
    );
    return {
      ...run,
      diagnostics: parseMessageDiagnostics(result.diagnostics)
    };
  } catch (error) {
    return {
      ...run,
      diagnosticsError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function loadTask(spec: ArcTaskSpec): Promise<LoadedTask> {
  const url = arcTaskUrl(spec);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const raw = await response.text();
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== spec.sha256) {
    throw new Error(`${spec.id}: SHA-256 mismatch for pinned ARC task`);
  }
  const value = JSON.parse(raw) as unknown;
  assertArcTask(value);
  const task: ArcTask = value;
  return {
    spec,
    material: visibleTaskMaterial(task),
    gold: task.test.map(({ output }) => output)
  };
}

function terminalRun(
  taskId: string,
  condition: Condition,
  startedAt: number,
  result: Record<string, unknown>
): ConditionRun {
  return projectTerminalRun(
    taskId,
    condition,
    Math.round(performance.now() - startedAt),
    result
  );
}

async function runPlainThink(
  task: LoadedTask,
  options: Options,
  ordinal: number
): Promise<DiagnosedConditionRun> {
  const startedAt = performance.now();
  const trial = `arc2-${options.runId}-${options.nonce}-${ordinal}-plain`;
  const url = `${options.baseUrl}/eval/baselines/${encodeURIComponent(trial)}`;
  let run: DiagnosedConditionRun;
  try {
    const result = await responseJson(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: ARC_TASK_PROMPT, context: task.material })
      },
      options.timeoutMs
    );
    run = terminalRun(task.spec.id, "basic-think", startedAt, result);
  } catch (error) {
    run = {
      taskId: task.spec.id,
      condition: "basic-think",
      status: "error",
      elapsedMs: Math.round(performance.now() - startedAt),
      answer: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return withMessageDiagnostics(run, url, options.timeoutMs);
}

async function runRlm(
  task: LoadedTask,
  options: Options,
  ordinal: number
): Promise<DiagnosedConditionRun> {
  const startedAt = performance.now();
  const session = `arc2-${options.runId}-${options.nonce}-${ordinal}-rlm`;
  const requestId = `arc2-${options.runId}-${options.nonce}-${ordinal}`;
  const diagnosticsUrl = `${options.baseUrl}/eval/rlm/${encodeURIComponent(
    session
  )}`;
  let run: DiagnosedConditionRun;
  try {
    let result = await responseJson(
      `${options.baseUrl}/sessions/${encodeURIComponent(session)}/think`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          task: ARC_TASK_PROMPT,
          context: task.material
        })
      },
      Math.min(options.timeoutMs, 30_000)
    );
    while (result.status === "admitted" || result.status === "running") {
      if (performance.now() - startedAt >= options.timeoutMs) {
        throw new Error(`RLM exceeded ${options.timeoutMs} ms wall timeout`);
      }
      await delay(1_000);
      result = await responseJson(
        `${options.baseUrl}/sessions/${encodeURIComponent(
          session
        )}/requests?requestId=${encodeURIComponent(requestId)}`,
        { method: "GET" },
        Math.min(options.timeoutMs, 30_000)
      );
    }
    run = terminalRun(task.spec.id, "rlm", startedAt, result);
  } catch (error) {
    run = {
      taskId: task.spec.id,
      condition: "rlm",
      status: "error",
      elapsedMs: Math.round(performance.now() - startedAt),
      answer: "",
      error: error instanceof Error ? error.message : String(error),
      recursiveCalls: null
    };
  }
  return withMessageDiagnostics(run, diagnosticsUrl, options.timeoutMs);
}

function scoreRun(run: DiagnosedConditionRun, task: LoadedTask): ScoredRun {
  const parsed = parseArcAnswer(run.answer, task.gold.length);
  return { ...run, parsed, score: scoreArcTask(task.gold, parsed) };
}

function logConditionRun(
  run: DiagnosedConditionRun,
  task: LoadedTask,
  ordinal: number,
  total: number
): void {
  const scored = scoreRun(run, task);
  const label = run.condition === "rlm" ? "RLM" : "basic Think";
  const status =
    run.status === "completed"
      ? `exact ${scored.score.correctPairs}/${scored.score.totalPairs}${
          scored.score.solved ? ", solved" : ""
        }`
      : "runtime error";
  const diagnostics: string[] = [];
  if (run.diagnostics) {
    diagnostics.push(
      `steps ${run.diagnostics.modelStepCount}`,
      `tools ${run.diagnostics.toolCallCount}${
        run.diagnostics.toolNames.length
          ? ` (${run.diagnostics.toolNames.join(", ")})`
          : ""
      }`
    );
  }
  if (run.condition === "rlm") {
    diagnostics.push(
      `executions ${run.executionIds?.length ?? 0}`,
      `recursive calls ${run.recursiveCalls ?? "unknown"}`
    );
  }
  console.log(
    `[${ordinal}/${total}] ${label}: ${status}; ${run.elapsedMs} ms${
      diagnostics.length ? `; ${diagnostics.join("; ")}` : ""
    }.`
  );
  if (run.error)
    console.log(`[${ordinal}/${total}] ${label} error: ${run.error}`);
  if (run.diagnosticsError) {
    console.log(
      `[${ordinal}/${total}] ${label} diagnostics unavailable: ${run.diagnosticsError}`
    );
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summary(runs: ScoredRun[], condition: Condition) {
  const selected = runs.filter((run) => run.condition === condition);
  const totalPairs = selected.reduce(
    (sum, run) => sum + run.score.totalPairs,
    0
  );
  return {
    condition,
    tasks: selected.length,
    tasksSolved: selected.filter((run) => run.score.solved).length,
    pairs: `${selected.reduce(
      (sum, run) => sum + run.score.correctPairs,
      0
    )}/${totalPairs}`,
    meanTaskScore: Number(
      (
        selected.reduce((sum, run) => sum + run.score.taskScore, 0) /
        selected.length
      ).toFixed(4)
    ),
    diagnosticCellAccuracy: Number(
      (
        selected.reduce(
          (sum, run) =>
            sum + run.score.diagnosticCellAccuracy * run.score.totalPairs,
          0
        ) / totalPairs
      ).toFixed(4)
    ),
    medianLatencyMs: Math.round(median(selected.map((run) => run.elapsedMs))),
    runtimeErrors: selected.filter((run) => run.status === "error").length,
    formatErrors: selected.filter(
      (run) =>
        run.status === "completed" &&
        (Boolean(run.parsed.error) ||
          run.parsed.test.some((entry) => Boolean(entry.error)))
    ).length,
    recursiveCalls:
      condition !== "rlm" ||
      selected.some(
        (run) => run.recursiveCalls === null || run.recursiveCalls === undefined
      )
        ? null
        : selected.reduce((sum, run) => sum + run.recursiveCalls!, 0)
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const revision = await codeRevision();
  const runtimeConfig = parseRuntimeConfig(
    await responseJson(
      `${options.baseUrl}/eval/config`,
      { method: "GET" },
      Math.min(options.timeoutMs, 10_000)
    )
  );
  console.log(
    `Observed runtime: ${runtimeConfig.model}; reasoning ${
      runtimeConfig.reasoningEffort ?? "none"
    }; ${runtimeConfig.maxSteps} steps; ${
      runtimeConfig.timeoutMs
    } ms turn timeout.`
  );
  const knownSpecs = new Map(
    [...MICRO_ARC_TASKS, ...ARC_TASKS].map((spec) => [spec.id, spec])
  );
  let selectedSpecs: ArcTaskSpec[];
  if (options.taskId) {
    const selected = knownSpecs.get(options.taskId);
    if (!selected) {
      throw new Error(
        `unknown --task-id ${options.taskId}; known ids: ${[
          ...knownSpecs.keys()
        ]
          .sort()
          .join(", ")}`
      );
    }
    selectedSpecs = [selected];
  } else {
    selectedSpecs =
      options.suite === "micro"
        ? [...MICRO_ARC_TASKS]
        : options.suite === "full"
          ? [...ARC_TASKS]
          : ARC_TASKS.filter(({ id }) => FAST_ARC_TASK_IDS.includes(id));
    if (options.limit !== undefined) {
      selectedSpecs = selectedSpecs.slice(0, options.limit);
    }
  }

  console.log(
    `Fetching ${selectedSpecs.length} pinned ARC-AGI-2 public-evaluation tasks...`
  );
  const tasks = await Promise.all(selectedSpecs.map(loadTask));
  const runs: DiagnosedConditionRun[] = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const rlmFirst = index % 2 === 0;
    console.log(
      `[${index + 1}/${
        tasks.length
      }] Running RLM and basic Think serially on fresh task sessions (${
        rlmFirst ? "RLM" : "basic Think"
      } first)...`
    );
    const first = rlmFirst
      ? await runRlm(task, options, index + 1)
      : await runPlainThink(task, options, index + 1);
    logConditionRun(first, task, index + 1, tasks.length);
    const second = rlmFirst
      ? await runPlainThink(task, options, index + 1)
      : await runRlm(task, options, index + 1);
    logConditionRun(second, task, index + 1, tasks.length);
    const pair = rlmFirst ? [first, second] : [second, first];
    runs.push(...pair);
  }

  // Aggregate correctness is computed after every isolated trial has terminated.
  const scored = runs.map((run) =>
    scoreRun(run, tasks.find((task) => task.spec.id === run.taskId)!)
  );
  const summaries = [summary(scored, "rlm"), summary(scored, "basic-think")];

  console.log("\nARC-AGI-2 public-evaluation smoke result");
  console.table(summaries);

  const output = {
    schemaVersion: 1,
    runId: options.runId,
    nonce: options.nonce,
    createdAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    suite: options.suite,
    taskId: options.taskId ?? null,
    limit: options.limit ?? null,
    conditionTimeoutMs: options.timeoutMs,
    codeRevision: revision,
    dataset: {
      repository: ARC_AGI_2_REPOSITORY,
      commit: ARC_AGI_2_COMMIT,
      split: "public evaluation",
      taskIds: selectedSpecs.map(({ id }) => id),
      selection: options.taskId
        ? `Explicit checked-in task selection: ${options.taskId}.`
        : options.suite === "micro"
          ? `The public-evaluation tasks with the fewest agent-visible cells${
              options.limit ? `, limited to the first ${options.limit}` : ""
            }.`
          : `Five visible-size strata with a fixed hash seed; fast uses the small, middle, and largest strata${
              options.limit ? `, limited to the first ${options.limit}` : ""
            }.`,
      caveat:
        "This is a smoke comparison on public tasks, not an official or contamination-resistant ARC-AGI-2 score."
    },
    comparison: {
      runtimeConfig,
      attemptsPerTestInput: 2,
      scorer:
        "exact nested-grid equality; task score is mean test-pair accuracy",
      diagnostic:
        "Cell accuracy is non-official and is zero when candidate dimensions are wrong.",
      rlm: "Only model-facing tool is codemode; each Dynamic Worker pass has an ephemeral JavaScript heap, plus external context, a compact durable per-agent JSON kernel, a durable isolated per-agent Computer /workspace, optional depth-one Think children, and an empty harness per fresh session.",
      basicThink:
        "Direct Think control; full redacted task material in the active prompt, no web/MCP/puzzle helper, and only an evaluation terminal-answer tool active."
    },
    prompt: ARC_TASK_PROMPT,
    summary: summaries,
    runs: scored
  };

  const resultsDir = path.join(EVAL_DIR, "results");
  await mkdir(resultsDir, { recursive: true });
  const outputPath = path.join(
    resultsDir,
    `${options.runId}-${options.nonce}.json`
  );
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  console.log(`Raw answers and diagnostics: ${outputPath}`);

  if (runs.some((run) => run.status === "error")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
