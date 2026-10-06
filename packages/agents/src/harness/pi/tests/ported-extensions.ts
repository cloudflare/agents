/**
 * The portable parts of the five most downloaded pi packages (npm, week of
 * 2026-10-05), rewritten against `agents/harness/extensions`. Each port
 * keeps the package's model-facing behaviour and swaps its process-local
 * dependencies (child processes, the terminal, config files) for a port the
 * host injects. What could not be ported is listed on each, and in
 * `design/rfc-portable-harness-extensions.md`.
 */
import { z } from "zod";
import type { SkillSource } from "../../../skills";
import {
  defineExtension,
  defineTool,
  jsonSchema,
  type JsonObject,
  type ToolResult
} from "../../extensions";

// ── 1. pi-mcp-adapter (534k/week) ─────────────────────────────────────────

/** One MCP server, as the extension needs it. */
export type McpServer = {
  readonly name: string;
  listTools(): Promise<
    readonly {
      readonly name: string;
      readonly description: string;
      readonly inputSchema: Record<string, unknown>;
    }[]
  >;
  callTool(name: string, args: JsonObject): Promise<ToolResult>;
};

/**
 * pi-mcp-adapter's direct tools: every tool of every server, as
 * `mcp__<server>__<tool>`. The original registers tools imperatively and
 * unregisters them through an undocumented `unregisterTool` when a server
 * changes. Here the tool list is one transform over a fetched catalog, so
 * `refresh()` gives exactly the servers' current tools.
 *
 * The network call stays outside the transform. A rebuild of the tool
 * domain replays every extension's transforms, so a transform that listed
 * the servers itself would re-list them whenever any extension reloaded.
 *
 * Not ported: stdio servers (no child processes), OAuth with the OS
 * keyring, the TUI panel, `/mcp` commands, the `mcp` proxy tool's lazy
 * per-session activation (`setActiveTools`).
 */
export function mcpAdapter(servers: () => readonly McpServer[]) {
  type Listed = Awaited<ReturnType<McpServer["listTools"]>>;
  let catalog: readonly { server: McpServer; tools: Listed }[] = [];
  const fetchCatalog = async () => {
    catalog = await Promise.all(
      servers().map(async (server) => ({
        server,
        tools: await server.listTools()
      }))
    );
  };
  let reload: (() => Promise<void>) | undefined;
  const extension = defineExtension({
    id: "pi-mcp-adapter",
    async setup(ctx) {
      await fetchCatalog();
      await ctx.tool.transform((tools) => {
        for (const { server, tools: listed } of catalog) {
          for (const tool of listed) {
            tools.add({
              id: `mcp__${server.name}__${tool.name}`.replace(/-/g, "_"),
              description: tool.description,
              input: jsonSchema(tool.inputSchema),
              execute: (args) => server.callTool(tool.name, args)
            });
          }
        }
      });
      reload = () => ctx.tool.reload();
    }
  });
  return {
    extension,
    /** Call after a server's tool list changes. */
    async refresh() {
      await fetchCatalog();
      await reload?.();
    }
  };
}

// ── 2. billion-context (388k/week) ────────────────────────────────────────
//
// Not ported. It compresses context by patching globalThis.fetch and
// WebSocket to route model traffic through a local proxy process it
// spawns, stamps provider headers (`before_provider_headers`), rewrites
// the payload (`before_provider_request`), and cancels pi's compaction
// (`session_before_compact`). The portable format has no model-request or
// compaction domain yet, and the proxy is a process. Its one portable
// piece, tools read from the proxy's manifest, is the same transform as
// `mcpAdapter`.

// ── 3. pi-web-access (230k/week) ──────────────────────────────────────────

/** A search backend, as pi-web-access's providers reduce to. */
export type WebSearch = (
  query: string,
  signal: AbortSignal
) => Promise<readonly { title: string; url: string; snippet: string }[]>;

/**
 * pi-web-access's `web_search` and `fetch_content`, with an instructions
 * section telling the model when to use them.
 *
 * Not ported: lazy activation (`web_enable` calls `setActiveTools` for one
 * session; the portable format has no per-session tool selection), the
 * curator UI and widgets, reading API keys from pi's model registry
 * (inject them into `search`), `appendEntry` storage of fetched pages for
 * `get_search_content`.
 */
export function webAccess(options: {
  readonly search: WebSearch;
  readonly fetch: typeof fetch;
}) {
  return defineExtension({
    id: "pi-web-access",
    async setup(ctx) {
      await ctx.instructions.transform((sections) => {
        sections.set(
          "web",
          "Use web_search for current or external information, and fetch_content to read a page."
        );
      });
      await ctx.tool.transform((tools) => {
        tools.add(
          defineTool({
            id: "web_search",
            description: "Search the web.",
            input: z.object({ query: z.string().min(1) }),
            replay: "safe",
            async execute({ query }, call) {
              const results = await options.search(query, call.signal);
              return {
                content: results
                  .map((r) => `${r.title}\n${r.url}\n${r.snippet}`)
                  .join("\n\n")
              };
            }
          })
        );
        tools.add(
          defineTool({
            id: "fetch_content",
            description: "Fetch a URL and return its text.",
            input: z.object({ url: z.url() }),
            replay: "safe",
            async execute({ url }, call) {
              const response = await options.fetch(url, {
                signal: call.signal
              });
              if (!response.ok) {
                return {
                  content: `Fetch failed: ${response.status}`,
                  isError: true
                };
              }
              return { content: await response.text() };
            }
          })
        );
      });
    }
  });
}

// ── 4. pi-subagents (190k/week) ───────────────────────────────────────────

/** Runs one task as a fresh agent and returns its answer. */
export type RunSubagent = (
  agent: string,
  task: string,
  signal: AbortSignal
) => Promise<string>;

/**
 * pi-subagents' `subagent` tool and its bundled skills. The original
 * spawns `pi` child processes; here the host injects `run`, which on a
 * harness is "create a session and prompt it".
 *
 * Not ported: parallel/chain workflows and their TUI, background runs
 * (`bg_wait`), intercom between children, the watchdog, prompt templates
 * (`registerCommand`), custom message renderers.
 */
export function subagents(options: {
  readonly run: RunSubagent;
  readonly skills: SkillSource;
}) {
  return defineExtension({
    id: "pi-subagents",
    async setup(ctx) {
      await ctx.skill.transform((skills) => skills.add(options.skills));
      await ctx.tool.transform((tools) => {
        tools.add(
          defineTool({
            id: "subagent",
            description: "Delegate a self-contained task to a fresh agent.",
            input: z.object({ agent: z.string(), task: z.string() }),
            async execute({ agent, task }, call) {
              call.progress(`running ${agent}\n`);
              return { content: await options.run(agent, task, call.signal) };
            }
          })
        );
      });
    }
  });
}

// ── 5. @juicesharp/rpiv-ask-user-question (96k/week) ──────────────────────
//
// Not ported. Its `ask_user_question` tool blocks on a terminal dialog
// (`ctx.ui.custom`) until the user answers. A durable harness cannot hold a
// tool call open on a person: it needs a request the harness persists and
// a `reply()` that resumes the call after an eviction (the harness RFC's
// `requests()`/`reply()`). The portable format has no user-request domain
// yet, and pi-durable has no parked tool call to map one onto.

// ── A policy extension, in the shape of the permission extensions ─────────

/**
 * Refuse destructive shell commands and redact secrets from results, as
 * @gotgenes/pi-permission-system and cc-safety-net do with `tool_call` and
 * `tool_result`. Applies to every tool, native ones included.
 */
export const guard = defineExtension({
  id: "guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      const command = event.input["command"];
      if (typeof command === "string" && /\brm\s+-rf\b/.test(command)) {
        event.block = "destructive command";
      }
    });
    await ctx.tool.hook("execute.after", (event) => {
      const content = event.result.content;
      if (typeof content === "string") return;
      event.result = {
        ...event.result,
        content: content.map((part) =>
          part.type === "text"
            ? { ...part, text: part.text.replace(/sk-\w+/g, "[redacted]") }
            : part
        )
      };
    });
  }
});
