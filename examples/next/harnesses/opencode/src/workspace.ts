import type { Workspace } from "@cloudflare/computer";
import {
  createPiTools,
  type CreatePiToolsOptions,
  type PiTool
} from "@cloudflare/computer/tools/pi-ai";
import type { Plugin } from "@opencode/plugin";

/** The id of the Workspace's one backend, which `exec` runs on. */
export const JAVASCRIPT_BACKEND = "javascript";

/**
 * OpenCode's tools that need a local filesystem or process. The Workers
 * profile has neither, so the Workspace's tools replace them.
 */
const LOCAL_TOOLS = ["read", "write", "edit", "patch", "glob", "grep", "shell"];

const SYSTEM = `You are running inside a Cloudflare Durable Object, not on the user's computer. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. Paths are absolute. You can fetch web pages with webfetch. Use tools whenever they can answer the request, and explain their results plainly. Be concise.`;

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
 * This app's OpenCode plugin: the Workspace tools from
 * `@cloudflare/computer/tools/pi-ai` in place of OpenCode's local file and
 * shell tools, and a system prompt that says what is there.
 *
 * `createPiTools` returns tool declarations and one `execute` that runs a
 * call by name. `execute` validates the arguments against the tool's schema
 * and reports failures as `isError` results, which become tool errors here.
 */
export function workspacePlugin(
  workspace: Workspace,
  options: Omit<CreatePiToolsOptions, "workspace" | "shell"> = {}
): Plugin.Plugin {
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

  return {
    id: "example.workspace",
    async setup(ctx) {
      await ctx.agent.transform((editor) => {
        editor.update("build", (agent) => {
          agent.system = SYSTEM;
        });
      });
      await ctx.tool.transform((editor) => {
        for (const id of LOCAL_TOOLS) editor.remove(id);
        for (const declared of tools) {
          const tool =
            declared.name === "exec" ? describeExec(declared) : declared;
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.parameters,
            // Offer each tool to the model by name. Otherwise OpenCode wraps
            // plugin tools in its `execute` code-mode tool.
            options: { codemode: false },
            async execute(input, context) {
              const { content, isError } = await execute(
                { id: context.id, name: tool.name, arguments: input },
                { abortSignal: context.signal }
              );
              const text = content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("\n");
              if (isError) throw new Error(text || `${tool.name} failed`);
              return { content: text };
            }
          });
        }
      });
    }
  };
}
