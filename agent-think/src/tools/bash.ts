/**
 * `bash` — run a shell command inside the workspace's configured
 * backends. Named `bash` (not `exec`) to line up with pi and Claude
 * Code: models have far more training data on a tool with this name.
 *
 * The tool exposes a `backend` parameter so the model picks where
 * each command runs. The per-backend tradeoffs are folded into the
 * `backend` parameter's schema description from
 * `BashToolOptions.backends`, so the guidance can never drift from
 * what is actually wired up. A typical setup (see agent.ts) declares
 * two: a "shell" backend (just-bash in a Dynamic Worker, cold-start
 * fast but limited to its built-in command set) and a "container"
 * backend (Cloudflare Container running wsd, full Linux userland).
 *
 * Design notes:
 * - Exit code is data, not an exception: every call returns
 *   `{ exitCode, stdout, stderr }`, so failing commands surface
 *   their output without error-path gymnastics.
 * - Truncation is head+tail per stream: build banners live at the
 *   head, but the error you need is almost always at the tail.
 * - `timeout` (seconds) races the command and SIGTERMs it on expiry,
 *   returning exit code 124 (the GNU `timeout(1)` convention).
 *
 * Borrowed from the hackspace agent's exec tool but stripped of the
 * streaming-UI machinery (`LoopTracker`, `ExecOutputBuffer`,
 * per-tool-call cancellation) — this agent has no UI to stream into.
 */

import { tool } from "ai";
import { z } from "zod";

/**
 * Minimal subset of `@cloudflare/workspace.Workspace` we depend on:
 * the shell facade exposes `exec(command, { cwd, encoding, backend })`
 * and the returned handle resolves to a `{ exitCode, stdout, stderr }`
 * result. `kill` is present on local handles (it is missing from the
 * cross-RPC stub flavor), so it is feature-detected before use.
 */
export interface BashWorkspaceLike {
  shell: {
    exec(
      command: string,
      options: { cwd?: string; encoding: "utf8"; backend?: string }
    ): Promise<{
      result(): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
      kill?(signal?: string): Promise<void>;
    }>;
  };
}

export interface BashBackendDescription {
  /**
   * One-paragraph summary of what this backend can and can't run.
   * The model reads it through the `backend` parameter's schema
   * description to decide which backend a given command belongs on.
   */
  description: string;
}

export interface BashToolOptions {
  workspace: BashWorkspaceLike;
  /**
   * The set of backend ids the tool advertises to the model. Keys
   * must match the `id` of a backend the underlying Workspace was
   * constructed with; an unknown id reaches the Workspace and
   * rejects with a clear error from there.
   */
  backends: Record<string, BashBackendDescription>;
  /**
   * Which backend the tool picks when the model omits `backend`.
   * Must be one of the keys in `backends`.
   */
  defaultBackend: string;
  /** Truncate captured stdout/stderr above this many bytes. */
  maxBytes?: number;
  /** Of `maxBytes`, how much to keep from the head on truncation. */
  headBytes?: number;
}

const TIMED_OUT: unique symbol = Symbol("bash-timeout");

const DEFAULT_MAX_BYTES = 32 * 1024; // per stream
const DEFAULT_HEAD_BYTES = 4 * 1024;
/** Exit code reported when `timeout` expires — GNU timeout(1) convention. */
const TIMEOUT_EXIT_CODE = 124;

export function createBashTool(opts: BashToolOptions) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const headBytes = Math.min(opts.headBytes ?? DEFAULT_HEAD_BYTES, maxBytes);
  const backendIds = Object.keys(opts.backends);
  if (backendIds.length === 0) {
    throw new Error("createBashTool: pass at least one backend in `backends`");
  }
  if (!backendIds.includes(opts.defaultBackend)) {
    throw new Error(
      `createBashTool: defaultBackend ${JSON.stringify(opts.defaultBackend)} is not one of ${backendIds.map((id) => JSON.stringify(id)).join(", ")}`
    );
  }

  const description = [
    "Run a shell command in the workspace (like a terminal). Returns",
    "{ exitCode, stdout, stderr } — a non-zero exitCode is a normal",
    "result, not an error. Use for ls / find / grep / rm / cat, git",
    "and gh, builds, installs, test runs, curl, and deploys. Prefer",
    "the dedicated read / write / edit tools for file content ops.",
    "",
    "IMPORTANT: redirect NOISY commands (installs, builds, test",
    "suites) to a container-local file and tail it, e.g.:",
    "  CI=1 pnpm install --reporter=append-only > /tmp/install.log 2>&1; tail -30 /tmp/install.log",
    "Streaming megabytes of live output through the session can",
    "kill it irrecoverably.",
    "",
    `Each output stream is truncated to ${Math.floor(maxBytes / 1024)} KB`,
    "(head + tail kept, middle elided) — another reason to tail log",
    "files instead of dumping them."
  ].join("\n");

  // Per-backend guidance lives on the parameter itself so the model
  // reads it exactly where it makes the choice, and it can never
  // drift from the backends actually configured.
  const backendSchema = z
    .enum(backendIds as [string, ...string[]])
    .optional()
    .describe(
      [
        `Where to run the command. Omit for the default (${JSON.stringify(opts.defaultBackend)}).`,
        ...backendIds.map((id) => `"${id}": ${opts.backends[id].description}`)
      ].join("\n")
    );

  const inputSchema = z.object({
    command: z
      .string()
      .describe("Shell command, e.g. 'npm test -- --run' or 'git diff HEAD'."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory. Defaults to the workspace root."),
    backend: backendSchema,
    timeout: z
      .number()
      .int()
      .positive()
      .max(3600)
      .optional()
      .describe(
        "Timeout in seconds (optional; no default). On expiry the " +
          `command is SIGTERMed and exitCode ${TIMEOUT_EXIT_CODE} is returned.`
      )
  });

  return tool({
    description,
    inputSchema,
    execute: async ({ command, cwd, backend, timeout }) => {
      const handle = await opts.workspace.shell.exec(command, {
        cwd,
        encoding: "utf8",
        backend
      });

      const meta = {
        command,
        cwd: cwd ?? null,
        backend: backend ?? opts.defaultBackend
      };

      const result =
        timeout === undefined
          ? await handle.result()
          : await Promise.race([
              handle.result(),
              sleep(timeout * 1000).then((): typeof TIMED_OUT => TIMED_OUT)
            ]);

      if (result === TIMED_OUT) {
        // Best-effort: local handles expose kill; cross-RPC stubs may not,
        // in which case the process can outlive the timeout.
        await handle.kill?.("SIGTERM").catch(() => {});
        return {
          ...meta,
          exitCode: TIMEOUT_EXIT_CODE,
          timedOut: true,
          stdout: "",
          stderr: `command timed out after ${timeout}s (SIGTERM sent)`
        };
      }

      return {
        ...meta,
        exitCode: result.exitCode,
        timedOut: false,
        stdout: truncate(result.stdout, maxBytes, headBytes),
        stderr: truncate(result.stderr, maxBytes, headBytes)
      };
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Head+tail truncation: keep the first `headBytes` and the newest
 * tail within the byte budget, eliding the middle. Approximates
 * bytes via UTF-16 length, which overcounts but never undercounts —
 * the right direction for a soft cap.
 */
function truncate(value: string, maxBytes: number, headBytes: number): string {
  if (!value || value.length <= maxBytes) return value;
  const tailBytes = maxBytes - headBytes;
  const omitted = value.length - maxBytes;
  return `${value.slice(0, headBytes)}\n[… ${omitted} bytes omitted …]\n${value.slice(value.length - tailBytes)}`;
}
