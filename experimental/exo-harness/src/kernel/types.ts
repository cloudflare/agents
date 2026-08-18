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
  /** "mock" or "workers-ai:<model-id>". */
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

export interface LoadedHarness {
  identity: string;
  policy: HarnessPolicy;
  /** Clamped context policy (defaults when /harness/context.json is absent). */
  context: ContextPolicy;
  tools: HarnessToolManifest[];
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
  source: "chat" | "prompt";
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
}

export const INITIAL_STATE: ExoState = {
  activeVersion: 0,
  activeSha: "",
  versions: [],
  journalTail: [],
  harnessFiles: []
};

/** Number of journal entries mirrored into synced state for the live UI. */
export const JOURNAL_TAIL_LIMIT = 100;
