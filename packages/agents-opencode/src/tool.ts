import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { Sandbox } from "@cloudflare/sandbox";
import type { Config } from "@opencode-ai/sdk/v2";
import type { ProviderCredentials, OpenCodeRunOutput } from "./types";
import { OpenCodeSession } from "./session";

/**
 * Options for creating the high-level OpenCode tool.
 */
export interface OpenCodeTaskOptions<
  S extends Sandbox<unknown> = Sandbox<unknown>
> {
  /** DurableObjectNamespace binding for the sandbox container. */
  sandbox: DurableObjectNamespace<S>;
  /** Name for the sandbox instance (typically the agent's name). */
  name: string;
  /** Environment bindings — used for auto-detecting provider credentials. */
  env: Record<string, unknown>;
  /** Durable Object storage for backup/restore across evictions. */
  storage: DurableObjectStorage;
  /**
   * Explicit provider credentials. If not provided, credentials are
   * auto-detected from `env` variables.
   */
  credentials?: ProviderCredentials[];
  /**
   * User-provided OpenCode config, merged recursively on top of
   * auto-detected config. Takes precedence.
   *
   * If `model` is set (e.g. `"anthropic/claude-sonnet-4-20250514"`),
   * it also determines the default provider.
   */
  userConfig?: Partial<Config>;
  /**
   * Custom description for the tool. Shown to the LLM to help it
   * decide when to invoke the tool.
   */
  description?: string;
}

/** WeakMap-based singleton cache for sessions keyed by sandbox binding. */
const sessionCache = new WeakMap<
  DurableObjectNamespace<Sandbox<unknown>>,
  Map<string, OpenCodeSession>
>();

function getOrCreateSession<S extends Sandbox<unknown>>(
  sandbox: DurableObjectNamespace<S>,
  name: string
): OpenCodeSession<S> {
  let byName = sessionCache.get(
    sandbox as DurableObjectNamespace<Sandbox<unknown>>
  );
  if (!byName) {
    byName = new Map();
    sessionCache.set(
      sandbox as DurableObjectNamespace<Sandbox<unknown>>,
      byName
    );
  }
  let session = byName.get(name) as OpenCodeSession<S> | undefined;
  if (!session) {
    session = new OpenCodeSession<S>(sandbox, name);
    byName.set(name, session as OpenCodeSession);
  }
  return session;
}

const DEFAULT_DESCRIPTION = [
  "Delegate a coding task to an autonomous coding agent (OpenCode) running in a sandbox container.",
  "The sandbox has a full development environment with Node.js, npm, Bun, Python, git, and standard Unix tools.",
  "Use this for any coding request: building apps, creating files, refactoring, debugging, running commands, etc.",
  "The agent has full shell, file read/write, and tool access inside /workspace.",
  "The prompt should be self-contained with clear inputs and expected outputs so the agent knows what to build and how to verify it.",
  "IMPORTANT: When running web services, use ports 8000–8005 only. Port 3000 is reserved and must NEVER be used.",
  "Always set the `outputFile` parameter so the user can download the result.",
  "When the task produces a single file artifact (image, CSV, PDF, HTML page, etc.), set `outputFile` to its absolute path in the sandbox (e.g. `/workspace/output.png`).",
  "When the task produces multiple files (a full project, several source files, etc.), instruct the agent to zip them into a single archive and set `outputFile` to the zip path (e.g. `/workspace/project.zip`)."
].join(" ");

/**
 * Create a high-level AI SDK tool that delegates coding tasks to OpenCode.
 *
 * This is the recommended entry point for most users. It handles session
 * lifecycle, provider detection, streaming, and backup automatically.
 *
 * @example
 * ```typescript
 * import { opencodeTask } from "@cloudflare/agents-opencode";
 *
 * const result = streamText({
 *   model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
 *   tools: {
 *     opencode: opencodeTask({
 *       sandbox: env.Sandbox,
 *       name: this.name,
 *       env,
 *       storage: this.ctx.storage,
 *     }),
 *   },
 * });
 * ```
 */
export function opencodeTask<S extends Sandbox<unknown> = Sandbox<unknown>>(
  options: OpenCodeTaskOptions<S>
) {
  const {
    sandbox,
    name,
    env,
    storage,
    credentials,
    userConfig,
    description = DEFAULT_DESCRIPTION
  } = options;

  return tool<
    { prompt: string; sessionId?: string; outputFile?: string },
    OpenCodeRunOutput
  >({
    description,
    inputSchema: zodSchema(
      z.object({
        prompt: z
          .string()
          .describe(
            "The coding task description. Be as specific as possible. Include the desired inputs and expected outputs so the agent knows what to build and how to verify it."
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Optional OpenCode session ID to continue a previous session instead of creating a new one."
          ),
        outputFile: z
          .string()
          .optional()
          .describe(
            "Absolute path of the output file in the sandbox. For a single artifact use its path (e.g. `/workspace/output.png`). For multiple files, zip them and use the zip path (e.g. `/workspace/project.zip`). Always set this so the user can download the result."
          )
      })
    ),
    execute: async (
      { prompt, sessionId, outputFile },
      { abortSignal }
    ): Promise<OpenCodeRunOutput> => {
      const session = getOrCreateSession(sandbox, name);

      if (!session.isStarted) {
        await session.start(env as Record<string, unknown>, storage, {
          credentials,
          userConfig
        });
      }

      let lastSnapshot: OpenCodeRunOutput | undefined;
      for await (const snapshot of session.run(prompt, {
        signal: abortSignal,
        storage,
        sessionId,
        onComplete: () => session.backup(storage)
      })) {
        lastSnapshot = snapshot;
      }

      const result: OpenCodeRunOutput = lastSnapshot ?? {
        status: "error",
        sessionId: sessionId ?? "",
        messages: [],
        filesEdited: [],
        fileChanges: [],
        diffs: [],
        diagnostics: [],
        processes: [],
        todos: [],
        outputFile: undefined,
        error: "No output from OpenCode run"
      };

      if (outputFile) {
        result.outputFile = outputFile;
      }

      return result;
    }
  });
}
