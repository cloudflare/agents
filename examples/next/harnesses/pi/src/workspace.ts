import type { Workspace } from "@cloudflare/computer";
import {
  createPiTools,
  type CreatePiToolsOptions,
  type PiTool
} from "@cloudflare/computer/tools/pi-ai";
import type { PiExtension } from "agents/harness/pi";

/** The id of the Workspace's one backend, which `exec` runs on. */
export const JAVASCRIPT_BACKEND = "javascript";

/**
 * Tools that can run again after an eviction cut them off. Reads and
 * searches have no effect, `write` replaces the whole file, and `delete`
 * succeeds on a missing path. `edit` would fail to find text it already
 * replaced, and `exec` runs arbitrary code, so pi hands the model an
 * interrupted result for those instead.
 */
const REPLAY_SAFE = new Set(["read", "ls", "find", "grep", "write", "delete"]);

/**
 * The shared `exec` description is written for a choice of shell backends.
 * This Workspace has one JavaScript backend, so say what that is instead.
 */
const EXEC_DESCRIPTION = `Run JavaScript in the workspace. \`command\` is the source of an ES module, run in a fresh sandboxed isolate with no network access. If the module default-exports a function, it is called with \`input\` and its return value comes back as \`result\`. console.log and console.error go to stdout and stderr. There is no shell, npm or package install: the only imports are these two, plus relative imports of .js files in the workspace.

- \`node:fs/promises\`: the workspace files, async only (readFile, writeFile, mkdir, rm, readdir, stat, lstat, access). readFile takes "utf8" for text.
- \`ws:git\`: git on the workspace, cloning over HTTPS through the host. Each \`dir\` is resolved against the module's working directory, defaults to it, and must stay inside /workspace, so pass the repository's directory. Its exports:

\`\`\`ts
function clone(options: {
  url: string; // HTTPS only
  dir?: string; // working tree to create
  ref?: string; // branch, tag or commit; default: the remote's default branch
  depth?: number; // shallow clone; default: full history
  paths?: string[]; // check out only these paths
  singleBranch?: boolean; // default true
  noTags?: boolean; // default true
}): Promise<void>;
function status(options?: { dir?: string }): Promise<
  { path: string; index: " " | "A" | "M" | "D"; worktree: " " | "A" | "M" | "D" | "?" }[]
>;
// A unified diff of \`ref\` (default HEAD) against the working tree, or against \`to\` when set.
function diff(options?: { dir?: string; ref?: string; to?: string; paths?: string[] }): Promise<string>;
// Newest first, from \`ref\` (default HEAD); \`depth\` caps the count.
function log(options?: { dir?: string; ref?: string; depth?: number }): Promise<
  {
    oid: string;
    message: string;
    tree: string;
    parent: string[];
    author: { name: string; email: string; timestamp: number; timezoneOffset: number }; // timestamp in seconds
    committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
  }[]
>;
\`\`\`

Example:
import { clone, log } from "ws:git";
export default async function () {
  await clone({ url: "https://github.com/octocat/Hello-World", dir: "/workspace/hello", depth: 5 });
  return (await log({ dir: "/workspace/hello" })).map((c) => \`\${c.oid.slice(0, 7)} \${c.message.split("\\n")[0]}\`);
}

Prefer the read, write and edit tools for plain file changes.`;

const COMMAND_DESCRIPTION =
  "ES module source to run. Default-export a function to receive `input` and return a result.";

/** `exec`'s declaration, described for the JavaScript backend. */
function describeExec(tool: PiTool): PiTool {
  const properties = tool.parameters.properties ?? {};
  const command = properties.command;
  return {
    ...tool,
    description: EXEC_DESCRIPTION,
    parameters: {
      ...tool.parameters,
      properties: {
        ...properties,
        command:
          typeof command === "object" && command !== null
            ? { ...command, description: COMMAND_DESCRIPTION }
            : command
      }
    }
  };
}

/**
 * The Workspace tools from `@cloudflare/computer/tools/pi-ai`, as a pi
 * extension.
 *
 * `createPiTools` returns pi-ai declarations and one `execute` that runs a
 * call, for a hand-written agent loop. pi-durable runs the loop itself and
 * wants each tool to carry its own `execute`, so this pairs them up by
 * name. `execute` validates the arguments against the tool's schema and
 * reports failures as `isError` results rather than throwing.
 */
export function workspaceTools(
  workspace: Workspace,
  options: Omit<CreatePiToolsOptions, "workspace" | "shell"> = {}
): PiExtension {
  const { tools, execute } = createPiTools({
    ...options,
    workspace,
    shell: {
      defaultBackend: JAVASCRIPT_BACKEND,
      backends: {
        [JAVASCRIPT_BACKEND]: {
          description: "Runs ES module source in a sandboxed isolate."
        }
      }
    }
  });

  return (ctx) =>
    ctx.tools.transform((draft) => {
      for (const declared of tools) {
        const tool =
          declared.name === "exec" ? describeExec(declared) : declared;
        draft.set(tool.name, {
          description: tool.description,
          // Plain JSON Schema: pi validates with TypeBox, which accepts it,
          // but computer's schema type is untyped, so `args` is too.
          parameters: tool.parameters,
          ...(tool.constrainedSampling
            ? { constrainedSampling: tool.constrainedSampling }
            : {}),
          replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
          async execute(args, { api, signal }) {
            const { content, isError } = await execute(
              { id: api.callId, name: tool.name, arguments: args },
              { abortSignal: signal }
            );
            return { content, isError };
          }
        });
      }
    });
}
