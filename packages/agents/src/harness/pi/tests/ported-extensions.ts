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
  jsonSchema,
  type Extension,
  type ExtensionContext,
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
 * pi-mcp-adapter's tools: every tool of every server, as
 * `mcp__<server>__<tool>`, deferred behind one `mcp_enable` loader, as the
 * original keeps them out of context until the model asks. The original
 * registers tools imperatively and drops them through an undocumented
 * `unregisterTool` when a server changes; here the list is one transform
 * over a fetched catalog, so `refresh()` gives exactly the servers' tools.
 *
 * The network call stays outside the transform: a rebuild of the tool
 * domain replays every extension's transforms, so a transform that listed
 * the servers itself would re-list them whenever any extension reloaded.
 *
 * Not ported: stdio servers (no child processes) and OAuth with the OS
 * keyring, which are process-local; the TUI panel.
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
  const ids = () =>
    catalog.flatMap(({ server, tools }) =>
      tools.map((tool) =>
        `mcp__${server.name}__${tool.name}`.replace(/-/g, "_")
      )
    );

  async function piMcpAdapter(ctx: ExtensionContext): Promise<void> {
    await fetchCatalog();
    ctx.tool.add({
      id: "mcp_enable",
      description: "Load the MCP servers' tools for this session.",
      input: z.object({}),
      execute: () => ({
        content: `Enabled: ${ids().join(", ")}`,
        activate: ids()
      })
    });
    ctx.tool.transform((tools) => {
      for (const { server, tools: listed } of catalog) {
        for (const tool of listed) {
          tools.add({
            id: `mcp__${server.name}__${tool.name}`.replace(/-/g, "_"),
            description: tool.description,
            input: jsonSchema(tool.inputSchema),
            deferred: true,
            execute: async (args) => server.callTool(tool.name, args)
          });
        }
      }
    });
    ctx.command.add({
      name: "mcp",
      description: "List MCP tools.",
      run: () => ({ text: ids().join("\n") })
    });
    reload = () => ctx.tool.reload();
  }

  return Object.assign(piMcpAdapter, {
    /** Call after a server's tool list changes. */
    async refresh() {
      await fetchCatalog();
      await reload?.();
    }
  });
}

// ── 2. billion-context (388k/week) ────────────────────────────────────────
//
// Not ported. It compresses context by patching globalThis.fetch and
// WebSocket to route model traffic through a local proxy process it
// spawns, stamps provider headers (`before_provider_headers`), rewrites
// the payload (`before_provider_request`), and cancels pi's compaction
// (`session_before_compact`). Provider and compaction hooks stay native
// to each harness, and the proxy is a process. Its portable pieces, tools
// read from the proxy's manifest and the `/acp` status commands, are the
// same transform and command as `mcpAdapter`.

// ── 3. pi-web-access (230k/week) ──────────────────────────────────────────

/** A search backend, as pi-web-access's providers reduce to. */
export type WebSearch = (
  query: string,
  signal: AbortSignal
) => Promise<readonly { title: string; url: string; snippet: string }[]>;

/**
 * pi-web-access: `web_search` and `fetch_content`, deferred behind the
 * `web_enable` loader exactly as the original does with `setActiveTools`,
 * and an instructions section telling the model to load them. Fetched
 * pages are kept per session, as the original keeps them with
 * `appendEntry`, for `get_search_content`.
 *
 * Not ported: the curator UI and widgets. API keys come in through
 * `search`, not pi's model registry.
 */
export function webAccess(options: {
  readonly search: WebSearch;
  readonly fetch: typeof fetch;
}): Extension {
  const tools = ["web_search", "fetch_content", "get_search_content"];
  return function piWebAccess(ctx) {
    const pages = ctx.storage("pi-web-access");
    ctx.instructions.set(
      "web",
      "For current or external information, call web_enable, then web_search and fetch_content."
    );
    ctx.tool.add({
      id: "web_enable",
      description: "Enable web search and fetching for this session.",
      input: z.object({}),
      execute: () => ({
        content: `Enabled: ${tools.join(", ")}`,
        activate: tools
      })
    });
    ctx.tool.add({
      id: "web_search",
      description: "Search the web.",
      input: z.object({ query: z.string().min(1) }),
      replay: "safe",
      deferred: true,
      async execute({ query }, call) {
        const results = await options.search(query, call.signal);
        return {
          content: results
            .map((r) => `${r.title}\n${r.url}\n${r.snippet}`)
            .join("\n\n"),
          metadata: { results: results.length }
        };
      }
    });
    ctx.tool.add({
      id: "fetch_content",
      description: "Fetch a URL and return its text.",
      input: z.object({ url: z.url() }),
      replay: "safe",
      deferred: true,
      async execute({ url }, call) {
        const response = await options.fetch(url, { signal: call.signal });
        if (!response.ok) {
          return { content: `Fetch failed: ${response.status}`, isError: true };
        }
        const text = await response.text();
        pages.session(call.session).put(url, text);
        return { content: text };
      }
    });
    ctx.tool.add({
      id: "get_search_content",
      description: "Read a page fetched earlier in this session.",
      input: z.object({ url: z.string() }),
      replay: "safe",
      deferred: true,
      execute: ({ url }, call) => {
        const page = pages.session(call.session).get<string>(url);
        return page === undefined
          ? { content: `Not fetched: ${url}`, isError: true }
          : { content: page };
      }
    });
  };
}

// ── 4. pi-subagents (190k/week) ───────────────────────────────────────────

/** Runs one task as a fresh agent and returns its answer. */
export type RunSubagent = (
  agent: string,
  task: string,
  signal: AbortSignal
) => Promise<string>;

/**
 * pi-subagents: the `subagent` tool, its bundled skills, and its prompt
 * templates as commands. The original spawns `pi` child processes; here
 * the host injects `run`, which on a harness is "create a session and
 * prompt it".
 *
 * Not ported: parallel/chain workflow TUI, intercom between children, the
 * watchdog, custom message renderers.
 */
export function subagents(options: {
  readonly run: RunSubagent;
  readonly skills: SkillSource;
}): Extension {
  return function piSubagents(ctx) {
    ctx.skill.add(options.skills);
    ctx.tool.add({
      id: "subagent",
      description: "Delegate a self-contained task to a fresh agent.",
      input: z.object({ agent: z.string(), task: z.string() }),
      async execute({ agent, task }, call) {
        call.progress(`running ${agent}\n`);
        await call.update({ agent, status: "running" });
        const answer = await options.run(agent, task, call.signal);
        return { content: answer, metadata: { agent, status: "done" } };
      }
    });
    // prompts/parallel-review.md, as a prompt template.
    ctx.command.add({
      name: "parallel-review",
      description: "Review the change with parallel subagents.",
      run: (args) => ({ prompt: `Review in parallel: ${args}` })
    });
  };
}

// ── 5. @juicesharp/rpiv-ask-user-question (96k/week) ──────────────────────

/**
 * rpiv-ask-user-question: a structured question the model can put to the
 * person. The original blocks on a terminal dialog; here `call.ask` stores
 * the question, the client answers with `reply()`, and the call resumes,
 * across an eviction too.
 *
 * Not ported: the TUI rendering, the free-text "Type something." row (use
 * an `input` request), i18n.
 */
export function askUserQuestion(ctx: ExtensionContext): void {
  ctx.tool.add({
    id: "ask_user_question",
    description: "Ask the user to choose one option.",
    input: z.object({
      question: z.string(),
      options: z.array(z.string()).min(1)
    }),
    replay: "safe",
    async execute({ question, options }, call) {
      const answer = await call.ask({
        kind: "select",
        message: question,
        options
      });
      return { content: `The user chose: ${answer}` };
    }
  });
}

// ── A policy extension, in the shape of the permission extensions ─────────

/**
 * Refuse destructive shell commands, ask before deploys, and redact
 * secrets from results, as @gotgenes/pi-permission-system and
 * cc-safety-net do with `tool_call` and `tool_result`. Applies to every
 * tool, native ones included.
 */
export function guard(ctx: ExtensionContext): void {
  ctx.tool.hook("execute.before", (event) => {
    const command = event.input["command"];
    if (typeof command !== "string") return;
    if (/\brm\s+-rf\b/.test(command)) event.block = "destructive command";
    else if (/\bdeploy\b/.test(command)) event.ask = `Run "${command}"?`;
  });
  ctx.tool.hook("execute.after", (event) => {
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
