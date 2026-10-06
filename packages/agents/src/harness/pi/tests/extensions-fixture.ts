import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Lifecycle } from "../../../lifecycle";
import { fromManifest } from "../../../skills/manifest";
import {
  defineExtension,
  defineTool,
  type ExtensionHost
} from "../../extensions";
import { setWakeTimingForTests } from "../harness";
import { PiHarness, piExtensions } from "../index";
import { fauxModels, NO_RETRY } from "./faux";
import { script, type Offered } from "./factory-fixture";
import {
  guard,
  mcpAdapter,
  subagents,
  webAccess,
  type McpServer
} from "./ported-extensions";
import { TEST_TIMING } from "./timing";

const MCP_TOOLS_KEY = "test:mcp-tools";

const Command = Type.Object({ command: Type.String() });

/** A native pi tool, to show portable hooks reach native tools too. */
const shell: ToolRegistration<typeof Command> = {
  name: "shell",
  description: "Pretend to run a command.",
  parameters: Command,
  async execute({ command }) {
    return { content: [{ type: "text", text: `ran ${command}, key sk-123` }] };
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

/** An extension whose setup counts its runs, in storage. */
function counter(storage: DurableObjectStorage) {
  return defineExtension({
    id: "counter",
    async setup(ctx) {
      const runs = ((await storage.get<number>("test:setup-runs")) ?? 0) + 1;
      await storage.put("test:setup-runs", runs);
      await ctx.tool.transform((tools) =>
        tools.add(
          defineTool({
            id: "add",
            description: "Add two numbers.",
            // The refinement has no JSON Schema form, so only the tool's
            // own parse, after pi's validation, can catch it.
            input: z
              .object({ a: z.number(), b: z.number() })
              .refine(({ a, b }) => a + b <= 100, "sum over 100"),
            replay: "safe",
            execute: ({ a, b }) => ({ content: String(a + b) })
          })
        )
      );
    }
  });
}

/**
 * The agent writes itself a tool and calls it in the same run, as in the
 * OpenCode post: `make_tool` adds a tool and reloads the tool domain.
 */
function toolMaker() {
  const made = new Set<string>();
  return defineExtension({
    id: "tool-maker",
    async setup(ctx) {
      await ctx.tool.transform((tools) => {
        tools.add(
          defineTool({
            id: "make_tool",
            description: "Make a tool that greets.",
            input: z.object({ name: z.string() }),
            async execute({ name }) {
              made.add(name);
              await ctx.tool.reload();
              return { content: `made ${name}` };
            }
          })
        );
        for (const name of made) {
          tools.add(
            defineTool({
              id: name,
              description: "Greet.",
              input: z.object({}),
              execute: () => ({ content: `hello from ${name}` })
            })
          );
        }
      });
    }
  });
}

/** `script`, plus: after `made <tool>`, call that tool. */
function scriptWithMadeTools(context: TranscriptContext): AssistantMessage {
  const last = context.messages.filter((m) => m.role !== "system").at(-1);
  const text =
    last?.role === "toolResult"
      ? last.content.map((part) => ("text" in part ? part.text : "")).join("")
      : "";
  const made = /^made (\S+)$/.exec(text);
  if (made?.[1]) {
    return fauxAssistantMessage([fauxToolCall(made[1], {})], {
      stopReason: "toolUse"
    });
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
  #host: ExtensionHost | undefined;

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const registry = createRegistry();
      registry.install({ name: "native", tools: [shell] });
      const { host, failures } = await piExtensions({
        registry,
        extensions: [
          counter(this.ctx.storage),
          this.#mcp.extension,
          webAccess({
            search: async (query) => [
              {
                title: `About ${query}`,
                url: "https://example.com",
                snippet: "…"
              }
            ],
            fetch: async (url) => new Response(`page at ${String(url)}`)
          }),
          subagents({
            run: async (agent, task) => {
              const child = await this.harness.sessions.create();
              const answer = await child.prompt(`${agent}: ${task}`);
              return answer.text ?? "";
            },
            skills: subagentSkills
          }),
          guard,
          toolMaker()
        ]
      });
      if (failures.length > 0) throw new AggregateError(failures);
      this.#host = host;
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
    this.#faux.setResponses(
      Array.from({ length: 2_000 }, () => scriptWithMadeTools)
    );
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

  async inspect(): Promise<Offered> {
    return JSON.parse((await this.harness.prompt("inspect")).text ?? "{}");
  }

  /** Change the MCP server's tools and tell the extension. */
  async setMcpTools(names: string[]): Promise<void> {
    await this.harness.pi();
    await this.ctx.storage.put(MCP_TOOLS_KEY, names);
    await this.#mcp.refresh();
  }

  async removeExtension(id: string): Promise<boolean> {
    await this.harness.pi();
    return (await this.#host?.remove(id)) ?? false;
  }

  async setupRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>("test:setup-runs")) ?? 0;
  }
}
