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

export interface HarnessPolicy {
  /** "mock" or "workers-ai:<model-id>". */
  model: string;
  maxSteps?: number;
}

export interface LoadedHarness {
  identity: string;
  policy: HarnessPolicy;
  tools: HarnessToolManifest[];
  /** All /harness file contents, keyed by absolute path. */
  files: Record<string, string>;
}

export interface HarnessFileInfo {
  path: string;
  size: number;
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
