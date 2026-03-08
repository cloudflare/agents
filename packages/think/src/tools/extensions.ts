import { tool } from "ai";
import { z } from "zod";
import type { ExtensionManager } from "../extensions/manager";
import { sanitizeName } from "../extensions/manager";

export interface ExtensionToolsOptions {
  manager: ExtensionManager;
}

/**
 * Create AI SDK tools for managing extensions at runtime.
 *
 * These tools let the LLM load and list extensions dynamically.
 * Loaded extensions expose their own tools on the next inference
 * turn. Unloading is a client-side action (via @callable RPC).
 *
 * @example
 * ```ts
 * const extensions = new ExtensionManager({ loader: this.env.LOADER, workspace: this.workspace });
 * const extensionTools = createExtensionTools({ manager: extensions });
 *
 * getTools() {
 *   return {
 *     ...createWorkspaceTools(this.workspace),
 *     ...extensionTools,
 *     ...extensions.getTools(), // tools from loaded extensions
 *   };
 * }
 * ```
 */
export function createExtensionTools(options: ExtensionToolsOptions) {
  const { manager } = options;

  return {
    load_extension: tool({
      description:
        "Load an extension from JavaScript source code. " +
        "The source is a JS object expression defining tools. " +
        "Each tool has: description, parameters (JSON Schema properties), " +
        "optional required array, and an async execute function. " +
        "The execute function receives (args, host) where host provides " +
        "workspace access (host.readFile, host.writeFile, host.listFiles). " +
        "IMPORTANT: Use only lowercase letters, numbers, and underscores in the extension name. " +
        "Tool names are prefixed: name 'math' with tool 'add' becomes 'math_add'. " +
        "New tools become available on the next message turn — call them by their full prefixed name.",
      inputSchema: z.object({
        name: z.string().describe("Unique name for the extension"),
        version: z.string().describe("Semver version (e.g. '1.0.0')"),
        description: z
          .string()
          .optional()
          .describe("Human-readable description"),
        source: z
          .string()
          .describe(
            "JavaScript object expression defining tools. Example:\n" +
              "{\n" +
              '  greet: {\n    description: "Greet someone",\n' +
              '    parameters: { name: { type: "string" } },\n' +
              '    required: ["name"],\n' +
              '    execute: async (args) => "Hello, " + args.name\n  }\n}'
          ),
        workspace_access: z
          .enum(["none", "read", "read-write"])
          .optional()
          .describe("Workspace access level for the extension (default: none)"),
        network: z
          .array(z.string())
          .optional()
          .describe(
            "Network hosts the extension needs access to (default: none)"
          )
      }),
      execute: async ({
        name,
        version,
        description,
        source,
        workspace_access,
        network
      }) => {
        const info = await manager.load(
          {
            name,
            version,
            description,
            permissions: {
              workspace: workspace_access ?? "none",
              network
            }
          },
          source
        );
        return {
          loaded: true,
          name: info.name,
          prefix: sanitizeName(name),
          version: info.version,
          tools: info.tools,
          message: `Extension "${name}" loaded. On the NEXT message turn, call these tools by their full name: ${info.tools.join(", ")}.`
        };
      }
    }),

    list_extensions: tool({
      description: "List all currently loaded extensions and their tools.",
      inputSchema: z.object({}),
      execute: async () => {
        const extensions = manager.list();
        return {
          count: extensions.length,
          extensions: extensions.map((ext) => ({
            name: ext.name,
            version: ext.version,
            description: ext.description,
            tools: ext.tools,
            permissions: ext.permissions
          }))
        };
      }
    })
  };
}
