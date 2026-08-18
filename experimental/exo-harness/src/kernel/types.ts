/** Shared types between the kernel (server) and the UI (client). */

export type JournalKind =
  | "genesis"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "harness_upgrade"
  | "harness_rollback"
  | "harness_load_failed"
  | "file_write"
  | "file_delete"
  | "note"
  | "error";

export interface JournalEntry {
  id: number;
  ts: number;
  kind: JournalKind;
  data: Record<string, unknown>;
}

export interface VersionInfo {
  version: number;
  sha: string;
  note: string;
  ts: number;
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
