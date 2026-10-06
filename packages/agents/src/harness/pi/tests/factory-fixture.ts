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
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { setWakeTimingForTests } from "../harness";
import { TEST_TIMING } from "./timing";
import { fromManifest } from "../../../skills/manifest";
import {
  createRegistry,
  Harness,
  type Extension,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { fauxModels, NO_RETRY } from "./faux";
import { PiHarness, skills } from "../index";

/** What one request offered the model, folded from its system messages. */
export type Offered = {
  readonly sections: Record<string, string>;
  readonly tools: string[];
};

/** What one request offered the model. */
export function offered(context: TranscriptContext): Offered {
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
export function script(context: TranscriptContext): AssistantMessage {
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

const shout: ToolRegistration<typeof Shout> = {
  name: "shout",
  description: "Upper-case the text.",
  parameters: Shout,
  replay: "safe",
  async execute({ text: value }) {
    return text(value.toUpperCase());
  }
};

const sum: ToolRegistration<typeof Sum> = {
  name: "sum",
  description: "Add numbers.",
  parameters: Sum,
  replay: "safe",
  async execute({ values }) {
    return text(String(values.reduce((total, value) => total + value, 0)));
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

/** Real Durable Object fixture: a factory that installs pi extensions and skills. */
export class PiFactoryTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 1_000,
    tokenSize: { min: 8, max: 16 }
  });
  /** Conversations pi reported creating, through a passed-through option. */
  created = 0;

  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      for (const extension of await this.#extensions()) {
        this.registry.install(extension);
      }
      return Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry: this.registry,
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
    this.#faux.setResponses(Array.from({ length: 2_000 }, () => script));
  }

  /** pi extensions, as an app would install them, loaded first. */
  async #extensions(): Promise<Extension[]> {
    // Loads before it contributes.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [
      {
        name: "base",
        sections: [{ key: "preamble", render: () => "Be terse.", tag: false }],
        tools: [shout]
      },
      { name: "math", tools: [sum] },
      await skills([notes])
    ];
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

  /**
   * The race behind a startup deadlock: an operation starts opening pi
   * before Lifecycle startup, and startup begins while the factory is still
   * waiting on I/O (its 5 ms timer).
   */
  async openWhileStarting(): Promise<string> {
    const opening = this.harness.pi();
    await this.lifecycle.start();
    await opening;
    return "opened";
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }
}

/** A harness whose factory fails the first time it runs in an isolate. */
export class PiFlakyFactoryTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  #attempts = 0;

  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.#attempts += 1;
      if (this.#attempts === 1) throw new Error("extension failed to load");
      this.registry.install({ name: "flaky", tools: [shout] });
      return Harness.open(
        storage,
        { models: fauxModels(this.#faux.provider), registry: this.registry },
        context
      );
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
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
}
