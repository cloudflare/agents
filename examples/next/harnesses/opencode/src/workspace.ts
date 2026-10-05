import type { Workspace } from "@cloudflare/computer";
import {
  createPiTools,
  type CreatePiToolsOptions,
  type PiTool
} from "@cloudflare/computer/tools/pi-ai";
import type { Plugin } from "@opencode/plugin";

export const JAVASCRIPT_BACKEND = "javascript";

const LOCAL_TOOLS = new Set([
  "edit",
  "execute",
  "glob",
  "grep",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write"
]);

const EXEC_DESCRIPTION = `Run JavaScript in the workspace. \`command\` is the source of an ES module, run in a fresh sandboxed isolate with no network access. If the module default-exports a function, it is called with \`input\` and its return value comes back as \`result\`. console.log and console.error go to stdout and stderr. There is no shell, npm or package install: the only imports are these two, plus relative imports of .js files in the workspace.

- \`node:fs/promises\`: the workspace files, async only (readFile, writeFile, mkdir, rm, readdir, stat, lstat, access). readFile takes "utf8" for text.
- \`ws:git\`: git on the workspace, cloning over HTTPS through the host. Each \`dir\` is resolved against the module's working directory, defaults to it, and must stay inside /workspace, so pass the repository's directory. Its exports:

\`\`\`ts
function clone(options: {
  url: string;
  dir?: string;
  ref?: string;
  depth?: number;
  paths?: string[];
  singleBranch?: boolean;
  noTags?: boolean;
}): Promise<void>;
function status(options?: { dir?: string }): Promise<
  { path: string; index: " " | "A" | "M" | "D"; worktree: " " | "A" | "M" | "D" | "?" }[]
>;

function diff(options?: { dir?: string; ref?: string; to?: string; paths?: string[] }): Promise<string>;

function log(options?: { dir?: string; ref?: string; depth?: number }): Promise<
  {
    oid: string;
    message: string;
    tree: string;
    parent: string[];
    author: { name: string; email: string; timestamp: number; timezoneOffset: number };
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

export type ToolInfo = {
  readonly name: string;
  readonly description: string;
};

export function createWorkspaceTools(
  workspace: Workspace,
  options: Omit<CreatePiToolsOptions, "workspace" | "shell"> = {}
): { readonly plugin: Plugin.Plugin; readonly tools: readonly ToolInfo[] } {
  const { tools: declared, execute } = createPiTools({
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
  const tools = declared.map((tool) =>
    tool.name === "exec" ? describeExec(tool) : tool
  );

  const plugin: Plugin.Plugin = {
    id: "opencode-harness-example.workspace",
    async setup(context) {
      const registration = await context.tool.transform((editor) => {
        // OpenCode's built-in file and shell tools have no local runtime in
        // workerd. Replace them with tools backed by this Workspace.
        for (const tool of editor.list()) {
          if (LOCAL_TOOLS.has(tool.name)) editor.remove(tool.id);
        }
        for (const tool of tools) {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.parameters,
            options: { codemode: false },
            async execute(input, toolContext) {
              const { content, isError } = await execute(
                { id: toolContext.id, name: tool.name, arguments: input },
                { abortSignal: toolContext.signal }
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
      return () => registration.dispose();
    }
  };

  return {
    plugin,
    tools: tools.map(({ name, description }) => ({ name, description }))
  };
}
