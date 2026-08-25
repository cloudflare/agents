/** Shared types between the kernel (server) and the UI (client). */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type JournalKind =
  | "genesis"
  | "model_invocation"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "harness_upgrade"
  | "harness_rollback"
  | "harness_load_failed"
  | "artifacts_push"
  | "artifacts_push_failed"
  | "fork"
  | "history_compacted"
  | "task_scheduled"
  | "task_run"
  | "task_failed"
  | "task_skipped"
  | "task_cancelled"
  | "task_disabled"
  | "file_write"
  | "file_delete"
  | "note"
  | "error";

export interface JournalEntry {
  id: number;
  ts: number;
  kind: JournalKind;
  data: JsonObject;
}

export interface VersionInfo {
  version: number;
  sha: string;
  note: string;
  ts: number;
  /** Artifacts git remote this version was pushed to, or null if not pushed. */
  remote: string | null;
  /** Commit SHA confirmed pushed to the remote, or null if not pushed. */
  pushedSha: string | null;
}

/** A harness tool manifest, extracted from its module inside the isolate. */
export interface HarnessToolManifest {
  /** Module path relative to /harness, e.g. "tools/echo.js". */
  file: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Control points implemented by the self-editable /harness/runtime.js. */
export const HARNESS_RUNTIME_HOOK_NAMES = [
  "beforeTurn",
  "beforeStep",
  "beforeToolCall",
  "afterToolCall",
  "transformOutput",
  "afterTurn"
] as const;

/** One control point in the evolvable turn runtime. */
export type HarnessRuntimeHookName =
  (typeof HARNESS_RUNTIME_HOOK_NAMES)[number];

/** Validated hook surface loaded from /harness/runtime.js. */
export interface HarnessRuntimeManifest {
  file: "runtime.js";
  hooks: HarnessRuntimeHookName[];
}

/** Origin of a main agent turn. */
export type TurnSource = "chat" | "prompt" | "task";

/** Every model request origin counted by the per-user circuit breaker. */
export type ModelInvocationSource = TurnSource | "runtime";

/** A decision returned by the evolvable runtime before tool execution. */
export type HarnessRuntimeToolDecision =
  | { action: "allow"; input?: unknown }
  | { action: "block"; reason: string }
  | { action: "substitute"; output: unknown };

/** Input visible to /harness/runtime.js before a tool executes. */
export interface HarnessRuntimeToolCall {
  source: TurnSource;
  tool: string;
  toolCallId: string;
  input: unknown;
  messages: unknown;
}

/** Input visible to /harness/runtime.js after a tool executes. */
export interface HarnessRuntimeToolResult extends HarnessRuntimeToolCall {
  output: unknown;
}

/** The activated self a fork was taken from. */
export interface ForkParent {
  name: string;
  version: number;
  sha: string;
}

/**
 * How a forked child receives its genesis: a clone of the parent's
 * Artifacts repo fork (full git lineage) or a direct file snapshot
 * (offline fallback when no Artifacts binding is bound).
 */
export type ForkOrigin =
  | { kind: "artifacts"; repoName: string; remote: string; parent: ForkParent }
  | { kind: "files"; files: Record<string, string>; parent: ForkParent };

export interface HarnessPolicy {
  /** "mock", a Workers AI model, or a managed "openai/<id>" model. */
  model: string;
  maxSteps?: number;
}

/**
 * The agent's context policy (/harness/context.json) — how its own model
 * context is assembled each turn. Self-editable like everything under
 * /harness; the kernel clamps every knob into hard bounds so the agent can
 * neither self-lobotomize nor self-bloat.
 */
export interface ContextPolicy {
  /** Max messages handed to the model per turn (after kernel pruning). */
  keepMessages: number;
  /** Soft token budget; exceeding it adds a pressure nudge to the briefing. */
  tokenTarget: number;
  /** Workspace file injected into the system prompt as working memory. */
  memoryFile: string;
  /** Max chars of the memory file injected (tail wins). */
  memoryMaxChars: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  keepMessages: 40,
  tokenTarget: 6000,
  memoryFile: "/memory/core.md",
  memoryMaxChars: 4000
};

/** Hard kernel bounds for the self-editable context policy. */
export const CONTEXT_POLICY_BOUNDS = {
  keepMessages: { min: 4, max: 200 },
  tokenTarget: { min: 500, max: 60000 },
  memoryMaxChars: { min: 0, max: 16000 }
} as const;

/** A requested-but-not-yet-applied transcript compaction. */
export interface PendingCompaction {
  keepLast: number;
  memoryFile: string;
  requestedTs: number;
}

export type TaskState = "active" | "done" | "cancelled" | "disabled";

/** A self-scheduled task in the kernel's registry (backed by this.schedule). */
export interface TaskInfo {
  /** Same id as the underlying SDK schedule. */
  id: string;
  instruction: string;
  kind: "delay" | "at" | "cron";
  /** Human-readable spec: seconds, ISO time, or cron expression. */
  spec: string;
  state: TaskState;
  createdTs: number;
  lastRunTs: number | null;
  runs: number;
  consecutiveFailures: number;
  /** Next scheduled firing (epoch ms), when known and active. */
  nextRunTs: number | null;
}

/**
 * Kernel-fixed rails for self-scheduled tasks (the agent cannot edit
 * these). Deliberately loose — the goal is preventing runaway loops, not
 * constraining use.
 */
export const TASK_BOUNDS = {
  maxActiveTasks: 10,
  maxRunsPerDay: 48,
  minMsBetweenRuns: 5 * 60_000,
  disableAfterConsecutiveFailures: 5
} as const;

/** Fixed per-agent circuit breaker for model inference. */
export const MODEL_INVOCATION_BOUNDS = {
  maxPerRolling24Hours: 10_000,
  rollingWindowMs: 24 * 60 * 60 * 1000
} as const;

export interface LoadedHarness {
  identity: string;
  policy: HarnessPolicy;
  /** Clamped context policy (defaults when /harness/context.json is absent). */
  context: ContextPolicy;
  tools: HarnessToolManifest[];
  runtime: HarnessRuntimeManifest | null;
  /** All /harness file contents, keyed by absolute path. */
  files: Record<string, string>;
}

export interface HarnessFileInfo {
  path: string;
  size: number;
}

/**
 * The exact raw model context assembled at the start of the most recent
 * turn: system prompt, pruned message array, and the tool surface. Stored
 * (overwritten each turn) for the glass-skull Context tab.
 */
export interface ContextSnapshot {
  ts: number;
  source: TurnSource;
  model: string;
  system: string;
  /** The pruned ModelMessage[] exactly as passed to the model. */
  messages: Json;
  tools: { name: string; description: string }[];
  /** The clamped context policy in effect this turn. */
  contextPolicy: ContextPolicy;
  /** Rough size estimate (chars/4) of system + messages. */
  estimatedTokens: number;
  /** Chars of working memory injected into the system prompt. */
  memoryChars: number;
}

/** State synced to all connected clients via the Agents state sync. */
export interface ExoState {
  activeVersion: number;
  activeSha: string;
  versions: VersionInfo[];
  journalTail: JournalEntry[];
  harnessFiles: HarnessFileInfo[];
  tasks: TaskInfo[];
}

export const INITIAL_STATE: ExoState = {
  activeVersion: 0,
  activeSha: "",
  versions: [],
  journalTail: [],
  harnessFiles: [],
  tasks: []
};

/** Number of journal entries mirrored into synced state for the live UI. */
export const JOURNAL_TAIL_LIMIT = 100;
