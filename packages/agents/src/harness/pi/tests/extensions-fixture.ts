import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Lifecycle } from "../../../lifecycle";
import { fromManifest } from "../../../skills/manifest";
import {
  isNativeTool,
  type Extension,
  type ExtensionContext
} from "../../extensions";
import { setWakeTimingForTests } from "../harness";
import { NOTE_ENTRY, PiHarness } from "../index";
import { fauxModels, NO_RETRY } from "./faux";
import { script, type Offered } from "./factory-fixture";
import {
  askUserQuestion,
  guard,
  mcpAdapter,
  subagents,
  webAccess,
  type McpServer
} from "./ported-extensions";
import { TEST_TIMING } from "./timing";

const MCP_TOOLS_KEY = "test:mcp-tools";

const Command = Type.Object({ command: Type.String() });

/** A native pi tool, to show portable hooks and transforms reach it. */
const shell: ToolRegistration<typeof Command> = {
  name: "shell",
  description: "Pretend to run a command.",
  parameters: Command,
  async execute({ command }) {
    return {
      content: [{ type: "text", text: `ran ${command}, key sk-123` }],
      details: { exit: 0 }
    };
  }
};

/** A native tool a portable extension removes. */
const legacy: ToolRegistration<typeof Command> = {
  name: "legacy",
  description: "Old.",
  parameters: Command,
  async execute() {
    return { content: [{ type: "text", text: "legacy" }] };
  }
};

const subagentSkills = fromManifest({
  id: "pi-subagents-skills",
  fingerprint: "v1",
  skills: [
    {
      name: "delegation",
      description: "When to hand work to a subagent.",
      body: "Delegate self-contained tasks."
    }
  ]
});

/** Counts its starts in storage and adds a tool with a refined schema. */
function counter(ctx: ExtensionContext): void {
  const store = ctx.storage("counter");
  store.put("starts", (store.get<number>("starts") ?? 0) + 1);
  ctx.tool.add({
    id: "add",
    description: "Add two numbers.",
    // The refinement has no JSON Schema form, so only the tool's own parse,
    // after pi's validation, can catch it.
    input: z
      .object({ a: z.number(), b: z.number() })
      .refine(({ a, b }) => a + b <= 100, "sum over 100"),
    replay: "safe",
    execute: ({ a, b }) => ({ content: String(a + b) })
  });
}

/** Edits native tools: removes `legacy`, re-describes `shell`. */
function nativeEditor(ctx: ExtensionContext): void {
  ctx.tool.transform((tools) => {
    tools.remove("legacy");
    tools.update("shell", (entry) =>
      isNativeTool(entry)
        ? { ...entry, description: "Run a command (guarded)." }
        : entry
    );
  });
}

/**
 * The agent writes itself a tool and calls it in the same run, as in the
 * OpenCode post. The made tools live in storage, so they come back after
 * an eviction.
 */
function toolMaker(ctx: ExtensionContext): void {
  const store = ctx.storage("tool-maker");
  ctx.tool.transform((tools) => {
    tools.add({
      id: "make_tool",
      description: "Make a tool that greets.",
      input: z.object({ name: z.string() }),
      async execute({ name }) {
        const made = store.get<string[]>("made") ?? [];
        store.put("made", [...new Set([...made, name])]);
        await ctx.tool.reload();
        return { content: `made ${name}` };
      }
    });
    for (const name of store.get<string[]>("made") ?? []) {
      tools.add({
        id: name,
        description: "Greet.",
        input: z.object({}),
        execute: () => ({ content: `hello from ${name}` })
      });
    }
  });
}

/** Records events, and drives sessions from commands. */
function recorder(ctx: ExtensionContext): void {
  const log = ctx.storage("recorder");
  const record = (line: string) =>
    log.put("events", [...(log.get<string[]>("events") ?? []), line]);
  ctx.event.on("session.created", (e) =>
    record(`session.created ${e.session}`)
  );
  ctx.event.on("tool.end", (e) =>
    record(`tool.end ${e.tool} ${JSON.stringify(e.result.metadata ?? {})}`)
  );
  ctx.event.on("turn.end", (e) => record(`turn.end ${e.text}`));
  ctx.command.add({
    name: "note",
    description: "Add a note to the transcript.",
    run: async (args, { session }) => {
      await ctx.session(session).note(args, { operationId: `note:${args}` });
      return { text: "noted" };
    }
  });
  ctx.command.add({
    name: "later",
    description: "Queue a prompt.",
    run: async (args, { session }) => {
      await ctx.session(session).submit(args, { operationId: `later:${args}` });
      return { text: "queued" };
    }
  });
}

/** `script`, plus: after `made <tool>` or `Enabled: <tool>, …`, call it. */
function fixtureScript(context: TranscriptContext): AssistantMessage {
  const last = context.messages.filter((m) => m.role !== "system").at(-1);
  const text =
    last?.role === "toolResult"
      ? last.content.map((part) => ("text" in part ? part.text : "")).join("")
      : "";
  const next = /^made (\S+)$/.exec(text)?.[1];
  if (next) {
    return fauxAssistantMessage([fauxToolCall(next, {})], {
      stopReason: "toolUse"
    });
  }
  if (text.startsWith("Enabled: web_search")) {
    return fauxAssistantMessage(
      [fauxToolCall("web_search", { query: "same run" })],
      { stopReason: "toolUse" }
    );
  }
  return script(context);
}

/**
 * Real Durable Object fixture: PiHarness running portable extensions,
 * including ports of the five most downloaded pi packages.
 */
export class PiPortableExtensionsTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 1_000,
    tokenSize: { min: 8, max: 16 }
  });
  readonly #mcp = mcpAdapter(() => [this.#mcpServer()]);
  readonly #extensions: Record<string, Extension> = {
    counter,
    mcp: this.#mcp,
    web: webAccess({
      search: async (query) => [
        { title: `About ${query}`, url: "https://example.com", snippet: "…" }
      ],
      fetch: async (url) => new Response(`page at ${String(url)}`)
    }),
    subagents: subagents({
      run: async (agent, task) => {
        const child = await this.harness.sessions.create();
        const answer = await child.prompt(`${agent}: ${task}`);
        return answer.text ?? "";
      },
      skills: subagentSkills
    }),
    ask: askUserQuestion,
    guard,
    nativeEditor,
    toolMaker,
    recorder
  };

  readonly harness = new PiHarness({
    extensions: Object.values(this.#extensions),
    harness: async ({ storage, context, registry }) => {
      registry.install({ name: "native", tools: [shell, legacy] });
      return Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry,
          settings: { retry: NO_RETRY }
        },
        context
      );
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses(Array.from({ length: 2_000 }, () => fixtureScript));
  }

  /** An MCP server whose tool list lives in storage, like a config file. */
  #mcpServer(): McpServer {
    const storage = this.ctx.storage;
    return {
      name: "docs",
      async listTools() {
        const names = (await storage.get<string[]>(MCP_TOOLS_KEY)) ?? [
          "search"
        ];
        return names.map((name) => ({
          name,
          description: `docs ${name}`,
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"]
          }
        }));
      },
      async callTool(name, args) {
        return { content: `docs ${name}(${JSON.stringify(args)})` };
      }
    };
  }

  async prompt(input: string, session?: string) {
    const response = await this.harness.prompt(
      input,
      session ? { session } : {}
    );
    return { status: response.status, text: response.text };
  }

  async submit(input: string, operationId?: string) {
    return this.harness.submit(input, operationId ? { operationId } : {});
  }

  async wait(operationId: string) {
    const result = await this.harness.wait(operationId);
    return { status: result.status, text: result.text };
  }

  async inspect(session?: string): Promise<Offered> {
    const response = await this.harness.prompt(
      "inspect",
      session ? { session } : {}
    );
    return JSON.parse(response.text ?? "{}");
  }

  async setMcpTools(names: string[]): Promise<void> {
    await this.harness.pi();
    await this.ctx.storage.put(MCP_TOOLS_KEY, names);
    await this.#mcp.refresh();
  }

  async removeExtension(name: string): Promise<boolean> {
    const extension = this.#extensions[name];
    if (!extension) return false;
    return (await this.harness.extensions()).remove(extension);
  }

  async starts(): Promise<number> {
    await this.harness.pi();
    return this.ctx.storage.kv.get<number>("ext/counter/k/starts") ?? 0;
  }

  async events(): Promise<string[]> {
    await this.harness.pi();
    return this.ctx.storage.kv.get<string[]>("ext/recorder/k/events") ?? [];
  }

  async requests() {
    return this.harness.requests();
  }

  /** Resolve once a request is open. */
  async nextRequest() {
    for (let i = 0; i < 200; i++) {
      const [request] = await this.harness.requests();
      if (request) return request;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No request was opened");
  }

  async reply(id: string, value: boolean | string) {
    return this.harness.reply(id, value);
  }

  async commands() {
    return this.harness.commands();
  }

  async notes(): Promise<string[]> {
    const entries = await this.harness.messages();
    return entries.flatMap((entry) =>
      entry.kind === NOTE_ENTRY &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "text" in entry.data
        ? [String(entry.data.text)]
        : []
    );
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }
}
