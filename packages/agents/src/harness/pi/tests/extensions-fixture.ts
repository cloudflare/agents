import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { fromManifest } from "../../../skills/manifest";
import { BACKGROUND_CONTEXT } from "../context";
import {
  PiHarness,
  skills,
  type PiExtension,
  type PiExtensions,
  type PiTool
} from "../index";

/** What one request offered the model, folded from its system messages. */
export type Offered = {
  readonly sections: Record<string, string>;
  readonly tools: string[];
};

function offered(context: TranscriptContext): Offered {
  const sections: Record<string, string> = {};
  const tools = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const [key, text] of Object.entries(message.sections ?? {})) {
      if (text === null) delete sections[key];
      else sections[key] = text;
    }
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { sections, tools: [...tools].sort() };
}

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

/**
 * The faux model's script:
 *
 * - `inspect` answers with what the request offered, as JSON.
 * - `call <tool> <json>` calls `<tool>` with those arguments.
 * - After a tool result it answers `tool said: <result>`.
 * - Anything else is echoed back.
 */
function script(context: TranscriptContext): AssistantMessage {
  const last = context.messages.filter((m) => m.role !== "system").at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      )
    ]);
  }
  const prompt = last?.role === "user" ? textOf(last.content) : "";
  if (prompt === "inspect") {
    return fauxAssistantMessage([fauxText(JSON.stringify(offered(context)))]);
  }
  const call = /^call (\S+) (.*)$/.exec(prompt);
  if (call) {
    return fauxAssistantMessage([fauxToolCall(call[1], JSON.parse(call[2]))], {
      stopReason: "toolUse"
    });
  }
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

const Shout = Type.Object({ text: Type.String() });
const Sum = Type.Object({ values: Type.Array(Type.Number()) });

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

const shout: PiTool<typeof Shout> = {
  description: "Upper-case the text.",
  parameters: Shout,
  replay: "safe",
  async execute({ text: value }) {
    return text(value.toUpperCase());
  }
};

const sum: PiTool<typeof Sum> = {
  description: "Add numbers.",
  parameters: Sum,
  replay: "safe",
  async execute({ values }) {
    return text(String(values.reduce((total, value) => total + value, 0)));
  }
};

const exec: PiTool<typeof Shout> = {
  description: "Run code.",
  parameters: Shout,
  async execute() {
    return text("exec ran");
  }
};

const notes = fromManifest({
  id: "test-skills",
  fingerprint: "v1",
  skills: [
    {
      name: "haiku",
      description: "Write haiku.",
      body: "Five, seven, five syllables.",
      resources: [
        {
          path: "examples.md",
          kind: "reference",
          content: "An old silent pond"
        }
      ]
    }
  ]
});

/** Real Durable Object fixture: a harness with a realistic set of extensions. */
export class PiExtensionsTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 1_000,
    tokenSize: { min: 8, max: 16 }
  });
  /** How many times each extension ran in this isolate. */
  readonly runs: Record<string, number> = {};

  readonly harness = new PiHarness({
    harness: ({ storage, context, registry, settings }) => {
      const models = createModels();
      models.setProvider(this.#faux.provider);
      return Harness.open(storage, { models, registry, settings }, context);
    },
    defaults: {
      model: {
        provider: this.#faux.getModel().provider,
        modelId: this.#faux.getModel().id
      },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }
    },
    extensions: this.#extensions(),
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 2_000 }, () => script));
  }

  #counted(name: string, extension: PiExtension): PiExtension {
    return (ctx) => {
      this.runs[name] = (this.runs[name] ?? 0) + 1;
      return extension(ctx);
    };
  }

  #extensions(): PiExtensions {
    return {
      base: this.#counted("base", (ctx) => {
        ctx.prompt.transform((prompt) =>
          prompt.set("preamble", { render: () => "Be terse.", tag: false })
        );
        ctx.tools.transform((tools) => {
          tools.set("shout", shout);
          tools.set("exec", exec);
        });
      }),
      // Renders from its input, per request.
      where: (ctx) =>
        ctx.prompt.transform((prompt) =>
          prompt.set("where", {
            render: (input) => `conversation ${input.conversationId}`
          })
        ),
      // Loads before it contributes.
      math: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        ctx.tools.transform((tools) => tools.set("sum", sum));
      },
      skills: skills([notes]),
      // Edits what came before it.
      policy: (ctx) => ctx.tools.transform((tools) => tools.delete("exec")),
      audit: (ctx) =>
        ctx.tools.transform((tools) => {
          const original = tools.get("shout");
          if (!original) return;
          tools.set("shout", {
            ...original,
            async execute(args, ctx) {
              const result = await original.execute(args, ctx);
              return {
                ...result,
                content: [
                  { type: "text", text: "audited " },
                  ...(result.content ?? [])
                ]
              };
            }
          });
        }),
      quiet: () => {}
    };
  }

  async prompt(input: string, session?: string) {
    const response = await this.harness.prompt(
      input,
      session ? { session } : {}
    );
    return { status: response.status, text: response.text };
  }

  async inspect(session?: string): Promise<Offered> {
    const response = await this.harness.prompt(
      "inspect",
      session ? { session } : {}
    );
    return JSON.parse(response.text ?? "{}");
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  /** Stop offering `extension` in one session, through pi's own selection. */
  async deselect(session: string, extension: string): Promise<void> {
    const installed = this.harness.registry.snapshot().extension(extension);
    if (!installed) throw new Error(`${extension} is not installed`);
    const conversation = await this.harness.conversation(session);
    await conversation.configure(
      { extensions: { remove: [installed] } },
      BACKGROUND_CONTEXT
    );
  }

  installed() {
    return this.harness.registry
      .snapshot()
      .installed()
      .map((extension) => ({
        name: extension.name,
        tools: (extension.tools ?? []).map((tool) => tool.name),
        sections: (extension.sections ?? []).map((section) => section.key)
      }));
  }

  /** Close pi and open it again in this isolate. */
  async reopen(): Promise<void> {
    await this.harness.dispose();
    await this.harness.pi();
  }

  extensionRuns(): Record<string, number> {
    return { ...this.runs };
  }
}

/** A harness whose extension fails the first time it runs in an isolate. */
export class PiFlakyExtensionTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  #attempts = 0;

  readonly harness = new PiHarness({
    harness: ({ storage, context, registry, settings }) => {
      const models = createModels();
      models.setProvider(this.#faux.provider);
      return Harness.open(storage, { models, registry, settings }, context);
    },
    defaults: {
      model: {
        provider: this.#faux.getModel().provider,
        modelId: this.#faux.getModel().id
      }
    },
    extensions: {
      flaky: (ctx) => {
        this.#attempts += 1;
        if (this.#attempts === 1) throw new Error("extension failed to load");
        ctx.tools.transform((tools) => tools.set("shout", shout));
      }
    },
    timing: { heartbeatMs: 1_000, sleepThresholdMs: 5_000 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 20 }, () => script));
  }

  async prompt(input: string) {
    const response = await this.harness.prompt(input);
    return { status: response.status, text: response.text };
  }

  /** Open the harness, reporting a failure instead of throwing it. */
  async open(): Promise<string> {
    try {
      await this.harness.pi();
      return "opened";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  tools(): string[] {
    return this.harness.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name);
  }
}
