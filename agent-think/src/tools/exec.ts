/**
 * `exec` — run a shell command inside the workspace's configured
 * backends. The tool exposes a `backend` parameter so the model
 * picks where each command runs.
 *
 * The agent is told about each backend's tradeoffs through the
 * descriptions on `ExecToolOptions.backends`. A typical setup
 * (see agent.ts) declares two: a "shell" backend (just-bash in a
 * Dynamic Worker, cold-start fast but limited to its built-in
 * command set) and a "container" backend (Cloudflare Container
 * running wsd, full Linux userland but slow to boot). The tool
 * description hints that the model should try the default backend
 * first and fall through to a heavier one only when the lighter
 * shell can't run the command.
 *
 * Borrowed from the hackspace agent's exec tool but stripped of
 * the streaming-UI machinery (`LoopTracker`, `ExecOutputBuffer`,
 * per-tool-call cancellation). This example has no UI to stream
 * into and the loop is short enough that running an exec to
 * completion in one tool round is fine.
 */

import { tool } from "ai";
import { z } from "zod";

/**
 * Minimal subset of `@cloudflare/workspace.Workspace` we depend on:
 * the shell facade exposes `exec(command, { cwd, encoding, backend })`
 * and the returned handle resolves to a `{ exitCode, stdout, stderr }`
 * result.
 */
export interface ExecWorkspaceLike {
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
    }>;
  };
}

export interface ExecBackendDescription {
  /**
   * One-paragraph summary of what this backend can and can't run.
   * The model reads it through the tool's input-schema description
   * to decide which backend a given command belongs on.
   */
  description: string;
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  /**
   * The set of backend ids the tool advertises to the model. Each
   * entry's description is folded into the `backend` parameter's
   * schema so the model can read the tradeoffs.
   *
   * Keys must match the `id` of a backend the underlying Workspace
   * was constructed with. An unknown id reaches the Workspace and
   * rejects with a clear error from there.
   */
  backends: Record<string, ExecBackendDescription>;
  /**
   * Which backend the tool picks when the model omits `backend`.
   * Must be one of the keys in `backends`. Typically the cheapest
   * / fastest one (a worker-isolate shell rather than a container).
   */
  defaultBackend: string;
  /** Truncate captured stdout/stderr above this many bytes. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB per stream

export function createExecTool(opts: ExecToolOptions) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const backendIds = Object.keys(opts.backends);
  if (backendIds.length === 0) {
    throw new Error("createExecTool: pass at least one backend in `backends`");
  }
  if (!backendIds.includes(opts.defaultBackend)) {
    throw new Error(
      `createExecTool: defaultBackend ${JSON.stringify(opts.defaultBackend)} is not one of ${backendIds.map((id) => JSON.stringify(id)).join(", ")}`
    );
  }

  // Render the per-backend descriptions into one block of guidance
  // the model reads on every tool call. Keeps the agent's mental
  // model of "which backend can run what" in front of it without
  // forcing a separate tools-table read.
  const backendGuidance = backendIds
    .map((id) => `- ${JSON.stringify(id)}: ${opts.backends[id].description}`)
    .join("\n");

  const description = [
    "Run a shell command in the workspace. The workspace exposes",
    "multiple backends, each with different capabilities. Pick the",
    "cheapest backend that can run the command; fall back to a",
    "heavier one only when the lighter backend's command set",
    "doesn't cover what you need.",
    "",
    "Backends:",
    backendGuidance,
    "",
    `Default backend: ${JSON.stringify(opts.defaultBackend)}. Try this`,
    "first for any command you're not sure about; if it fails with a",
    '"command not found" or a similar capability error, retry on a',
    "backend whose description covers the missing tool.",
    "",
    "Use for builds, test runs, typechecks, formatters, and `git`",
    "plumbing. Prefer the dedicated `read` / `write` / `edit` tools",
    "for file ops. Long output is truncated to keep tool replies",
    "small."
  ].join("\n");

  // Schema-side description for the backend field. zod's
  // describe() metadata threads through to the JSON schema the
  // model sees on each call.
  const backendSchema = z
    .enum(backendIds as [string, ...string[]])
    .optional()
    .describe(
      [
        "Which backend to run on. Omit to use the default",
        `(${JSON.stringify(opts.defaultBackend)}). Set explicitly when the`,
        "default backend isn't capable of running the command (see the",
        "per-backend descriptions in the tool summary)."
      ].join(" ")
    );

  const inputSchema = z.object({
    command: z
      .string()
      .describe("Shell command, e.g. 'npm test -- --run' or 'git diff HEAD'."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory. Defaults to the workspace root."),
    backend: backendSchema
  });

  return tool({
    description,
    inputSchema,
    execute: async ({ command, cwd, backend }) => {
      const handle = await opts.workspace.shell.exec(command, {
        cwd,
        encoding: "utf8",
        backend
      });
      const result = await handle.result();
      return {
        command,
        cwd: cwd ?? null,
        backend: backend ?? opts.defaultBackend,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, maxBytes),
        stderr: truncate(result.stderr, maxBytes)
      };
    }
  });
}

function truncate(value: string, maxBytes: number): string {
  if (!value) return value;
  // Approximate bytes via length; UTF-8 worst case overcounts but
  // never undercounts, which is what we want for a soft cap.
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}\n\n[truncated, ${value.length - maxBytes} more bytes]`;
}
