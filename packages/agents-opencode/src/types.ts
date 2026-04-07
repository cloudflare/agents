import type { UIMessage } from "ai";
import type {
  Config,
  FileDiff as SDKFileDiff,
  Todo as SDKTodo,
  Pty as SDKPty,
  EventLspClientDiagnostics
} from "@opencode-ai/sdk/v2";

/**
 * Re-export SDK types under local names for use throughout the library.
 * This keeps our public API stable even if the SDK renames things, and
 * lets us add library-specific fields if needed in the future.
 */
export type FileDiff = SDKFileDiff;
export type Todo = SDKTodo;
export type Diagnostic = EventLspClientDiagnostics["properties"];

/**
 * Process information tracked from pty.created / pty.updated / pty.exited
 * events. Based on the SDK's `Pty` type but simplified to the fields we
 * surface in `OpenCodeRunOutput`.
 */
export type ProcessInfo = Pick<SDKPty, "id" | "command" | "args" | "status"> & {
  exitCode?: number;
};

/**
 * File change event from the file watcher stream.
 * Mirrors `EventFileWatcherUpdated["properties"]` from the SDK.
 */
export type FileChange = {
  file: string;
  event: "add" | "change" | "unlink";
};

/**
 * Output type for every yield of the `opencode` async-generator tool.
 * Preliminary yields carry the growing sub-conversation; the final yield
 * includes the completed conversation and optional summary.
 */
export type OpenCodeRunOutput = {
  /** Overall lifecycle status. */
  status: "working" | "complete" | "error";
  /** OpenCode session ID for correlation. */
  sessionId: string;
  /** Sub-conversation messages using AI SDK's native UIMessage format. */
  messages: UIMessage[];
  /** Files edited by the agent during this run. */
  filesEdited: string[];
  /** File system changes observed during this run. */
  fileChanges: FileChange[];
  /** Session diff: file-level diffs produced at the end of the run. */
  diffs: FileDiff[];
  /** LSP diagnostics encountered during the run. */
  diagnostics: Diagnostic[];
  /** Shell processes spawned by the agent during the run. */
  processes: ProcessInfo[];
  /** Todos/tasks tracked by the agent during the run. */
  todos: Todo[];
  /** Model ID used by the OpenCode agent (from the event stream). */
  modelID?: string;
  /** Final summary text (only on status === "complete"). */
  summary?: string;
  /** Error description (only on status === "error"). */
  error?: string;
  /** Absolute path of the primary output file artifact, if any. */
  outputFile?: string;
};

/** Supported provider identifiers. */
export type ProviderID = "cloudflare-workers-ai" | "anthropic" | "openai";

/**
 * Credentials needed to configure a provider inside the sandbox.
 * Each provider type has its own shape.
 */
export type ProviderCredentials =
  | {
      provider: "cloudflare-workers-ai";
      accountId: string;
      apiKey: string;
    }
  | {
      provider: "anthropic";
      apiKey: string;
    }
  | {
      provider: "openai";
      apiKey: string;
    };

/**
 * All provider credentials detected from the environment.
 * Multiple providers can be available simultaneously — the resolver
 * merges them into a single config so every model is accessible.
 */
export type AllProviderCredentials = {
  credentials: ProviderCredentials[];
  /** Which provider to use as the default (its model is set in config.model). */
  defaultProvider: ProviderID;
};

/**
 * Resolved provider configuration: the OpenCode Config to use inside
 * the sandbox, the env vars to inject, and the auth registrations.
 *
 * When multiple provider credentials are available, the config merges
 * all of them so every model is accessible in the sandbox. The `id`
 * identifies the default provider (the one whose model is set in
 * `config.model`).
 */
export type ResolvedProvider = {
  /** Default provider identifier. */
  id: ProviderID;
  /** OpenCode config to pass to `createOpencode()`. */
  config: Config;
  /** Environment variables to inject into the sandbox (all providers). */
  env: Record<string, string>;
  /** Auth registrations for each detected provider. */
  auths: Array<{
    providerID: string;
    auth: { type: "api"; key: string };
  }>;
};

/**
 * Persisted state for an OpenCode session. Stored in DO SQLite storage
 * alongside the sandbox filesystem backup handle.
 */
export type OpenCodeSessionState = {
  /** OpenCode session ID (from the SDK). */
  sessionId: string;
  /** Provider used for this session. */
  providerId: ProviderID;
  /** Whether a run was in-flight when the backup was taken. */
  runInFlight: boolean;
  /** The prompt of the in-flight run, if any. */
  runPrompt?: string;
};

export type ServerMessage = {
  type: "file-change";
  eventType: string;
  path: string;
  isDirectory: boolean;
};

export type OpenCodeRunOptions = {
  /** Abort signal to cancel the run. */
  signal?: AbortSignal;
  /** Callback invoked after each run completes (for backup). */
  onComplete?: () => Promise<void>;
  /** DO storage for periodic mid-run backups. If not provided, no periodic backups occur. */
  storage?: DurableObjectStorage;
  /** Interval in ms between periodic backups during a run (default: 30000). */
  backupIntervalMs?: number;
  /** Existing OpenCode session ID to continue instead of creating a new session. */
  sessionId?: string;
};
