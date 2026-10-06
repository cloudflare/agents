import { DurableObject } from "cloudflare:workers";
import type { Plugin } from "@opencode/plugin";
import {
  OpenCodeHarness,
  type OpenCodeEvent,
  type OpenCodeEventStream,
  type OpenCodeOperationResult,
  type OpenCodeReceipt,
  type OpenCodeWhenBusy
} from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/opencode";
import { Streams } from "agents/streams";
import { WebSockets } from "agents/websockets";
import { openCodeRequest } from "../cli";
import { OpenCodeSessionSockets } from "../sockets";
import { EMPTY_VIEW, reduceEvents, type OpenCodeSessionView } from "../view";

const RELEASE_KEY = "test:gate:release";
const GATE_RUNS_KEY = "test:gate:runs";
const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

type ChatMessage = {
  role?: string;
  content?: unknown;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { text?: unknown }[])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function stream(
  delta: Record<string, unknown>,
  finish: "stop" | "tool_calls"
): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", ...delta } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  ];
  return new Response(
    [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
      .map((data) => `data: ${data}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

function toolCall(name: string, args: unknown): Response {
  return stream(
    {
      tool_calls: [
        {
          index: 0,
          id: `call_${crypto.randomUUID().slice(0, 8)}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) }
        }
      ]
    },
    "tool_calls"
  );
}

function script(input: Record<string, unknown>): Response {
  if (input.stream !== true) {
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "title" }
        }
      ]
    });
  }
  const messages = (input.messages ?? []) as ChatMessage[];
  const last = messages.filter((message) => message.role !== "system").at(-1);
  if (last?.role === "tool") {
    return stream({ content: `tool said: ${textOf(last.content)}` }, "stop");
  }
  const prompt = last?.role === "user" ? textOf(last.content) : "";
  const multiply = /^multiply (\d+)$/.exec(prompt);
  if (multiply) return toolCall("multiply", { value: Number(multiply[1]) });
  if (prompt === "gate") return toolCall("gate", {});
  return stream({ content: `echo: ${prompt}` }, "stop");
}

const scriptedBinding = {
  aiGatewayLogId: null,
  async run(_model: string, input: Record<string, unknown>) {
    return script(input);
  }
} as unknown as Ai;

const TOOLS = [
  { name: "multiply", description: "Multiply by three." },
  { name: "gate", description: "Wait until the test releases it." }
];

function testTools(storage: DurableObjectStorage): Plugin.Plugin {
  return {
    id: "opencode-harness-example.test-tools",
    async setup(context) {
      const registration = await context.tool.transform((editor) => {
        for (const tool of editor.list()) editor.remove(tool.id);
        editor.add({
          name: "multiply",
          description: "Multiply by three.",
          input: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"]
          },
          options: { codemode: false },
          async execute(input) {
            return { content: String((input as { value: number }).value * 3) };
          }
        });
        editor.add({
          name: "gate",
          description: "Wait until the test releases it.",
          input: { type: "object", properties: {} },
          options: { codemode: false },
          async execute(_input, toolContext) {
            const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
            await storage.put(GATE_RUNS_KEY, runs);
            while (!(await storage.get<boolean>(RELEASE_KEY))) {
              toolContext.signal.throwIfAborted();
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return { content: `released after ${runs} runs` };
          }
        });
      });
      return () => registration.dispose();
    }
  };
}

export class OpenCodeHarnessTestObject extends DurableObject<Env> {
  readonly ai = createAI({ binding: scriptedBinding });
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    workerd: { models: { fetch: false } },
    providers: [this.ai.provider],
    plugins: [testTools(this.ctx.storage)],
    defaults: { model: this.ai(MODEL_ID) }
  });
  readonly sockets = new OpenCodeSessionSockets(this.harness, TOOLS, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams)
    .use(this.webSockets);

  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }

  async onRequest(request: Request): Promise<Response> {
    return this.harness.fetch(openCodeRequest(request));
  }

  async prompt(text: string): Promise<OpenCodeOperationResult> {
    const { messages: _messages, ...result } = await this.harness.prompt(text);
    return result;
  }

  submit(
    text: string,
    options: { whenBusy?: OpenCodeWhenBusy; operationId?: string } = {}
  ): Promise<OpenCodeReceipt> {
    return this.harness.submit(text, options);
  }

  wait(operationId: string): Promise<OpenCodeOperationResult> {
    return this.harness.wait(operationId);
  }

  async gateStarted(runs: number): Promise<number> {
    for (let i = 0; i < 500; i++) {
      const count = (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The gate tool never started");
  }

  dispose(): Promise<void> {
    return this.harness.dispose();
  }

  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }

  #watching: Promise<{ view: string; types: string[] }> | undefined;

  async watch(): Promise<void> {
    const stream = await this.harness.session().events();
    const view = reduceEvents(EMPTY_VIEW, [stream.snapshot]);
    const types: string[] = ["snapshot"];
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.#watching = this.#follow(stream, view, types, started);
    await ready;
  }

  async watched(): Promise<{ view: string; types: string[] }> {
    if (!this.#watching) throw new Error("Not watching");
    return this.#watching;
  }

  async #follow(
    stream: OpenCodeEventStream,
    initial: OpenCodeSessionView,
    types: string[],
    started: () => void
  ): Promise<{ view: string; types: string[] }> {
    let view = initial;
    await new Promise<void>((resolve) => {
      let ended = false;
      stream.start((events: readonly OpenCodeEvent[]) => {
        types.push(...events.map((event) => event.type));
        view = reduceEvents(view, events);
        if (events.some((event) => event.type === "operation_end")) {
          ended = true;
        }

        if (ended && events.some((event) => event.type === "snapshot")) {
          resolve();
        }
      });
      started();
    });
    await stream.stop();

    return { view: JSON.stringify(view), types };
  }

  async snapshotView(): Promise<string> {
    const stream = await this.harness.session().events();
    await stream.stop();
    return JSON.stringify(reduceEvents(EMPTY_VIEW, [stream.snapshot]));
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
