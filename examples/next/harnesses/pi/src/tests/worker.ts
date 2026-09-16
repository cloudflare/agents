import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Harness } from "@cloudflare/agents-next-harness";
import { Lifecycle } from "agents/lifecycle";
import type { SessionMessage } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { Type } from "typebox";
import { PiRuntime } from "../harness/pi-runtime";
import type { PiProtocol, PiTool } from "../harness/types";
import { createModels } from "../providers/models";

const multiplyParameters = Type.Object({ value: Type.Number() });
const waitParameters = Type.Object({});
const TOOL_REVISION_KEY = "test:pi:revision";
/** Long enough for a test to interrupt or steer the running operation. */
const WAIT_TOOL_MS = 5_000;

type ToolContext = {
  readonly revision: number;
};

function messageText(message: SessionMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Real Durable Object fixture: the shared Harness over pi's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new Harness<PiProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: new PiRuntime<ToolContext>({
      models: createModels({ providers: [this.#faux.provider] }),
      model: this.#faux.getModel(),
      thinkingLevel: "off",
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      toolContext: async () => ({
        revision: (await this.ctx.storage.get<number>(TOOL_REVISION_KEY)) ?? 1
      }),
      tools: () => [this.#multiplyTool(), this.#waitTool()],
      systemPrompt: "Use the supplied test tool."
    })
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /** Run one faux-provider turn containing a tool call, and wait for it. */
  async runMultiply(
    value: number,
    revision: number
  ): Promise<{
    readonly operationId: string;
    readonly status: string;
    readonly cursor: string;
    readonly messages: readonly string[];
    readonly result: number | null;
  }> {
    await this.lifecycle.start();
    await this.ctx.storage.put(TOOL_REVISION_KEY, revision);
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { value }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("tool complete")
    ]);
    const session = this.harness.session();
    const receipt = await session.prompt(`multiply ${value}`);
    const outcome = await session.wait(receipt.operationId, {
      timeoutMs: 20_000
    });
    const page = await session.messages();
    const details = page.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .at(-1)?.result;
    const result =
      typeof details === "object" &&
      details !== null &&
      "result" in details &&
      typeof details.result === "number"
        ? details.result
        : null;
    return {
      operationId: receipt.operationId,
      status: outcome.status,
      cursor: outcome.cursor,
      messages: page.messages.map(messageText),
      result
    };
  }

  /** Read the durable transcript without starting another model turn. */
  async messages(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return (await this.harness.session().messages()).messages.map(messageText);
  }

  async status(): Promise<{
    readonly state: string;
    readonly capabilities: readonly string[];
  }> {
    await this.lifecycle.start();
    const status = await this.harness.session().status();
    return { state: status.state, capabilities: status.capabilities };
  }

  /** Replay the durable log, naming each frame by its event type. */
  async eventTypes(from?: string): Promise<readonly string[]> {
    await this.lifecycle.start();
    const controller = new AbortController();
    const types: string[] = [];
    for await (const event of this.harness.session().events({
      ...(from === undefined ? {} : { from }),
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if ("preview" in event) continue;
      const body = event.body;
      types.push(
        body.type === "extension" ? `extension:${body.body.type}` : body.type
      );
    }
    return types;
  }

  /** Start a turn whose tool call blocks until interrupted or timed out. */
  async startWaiting(): Promise<string> {
    await this.lifecycle.start();
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done waiting")
    ]);
    const receipt = await this.harness.session().prompt("wait for me");
    return receipt.operationId;
  }

  /** Fold a message into the running turn. */
  async steer(text: string): Promise<{
    readonly accepted: boolean;
    readonly status: string;
    /** The pi queue entry the steered message landed in, when it took one. */
    readonly entryId: string | null;
  }> {
    await this.lifecycle.start();
    const session = this.harness.session();
    const receipt = await session.prompt(text, { delivery: "steer" });
    const outcome = await session.wait(receipt.operationId, {
      timeoutMs: 20_000
    });
    const raw = outcome.raw;
    return {
      accepted: receipt.accepted,
      status: outcome.status,
      entryId: raw && "entryId" in raw ? raw.entryId : null
    };
  }

  async interrupt(operationId: string): Promise<{
    readonly requested: string | null;
    readonly status: string;
    readonly stopReason: string;
  }> {
    await this.lifecycle.start();
    const session = this.harness.session();
    const interrupted = await session.interrupt();
    const outcome = await session.wait(operationId, { timeoutMs: 20_000 });
    return {
      requested: interrupted.operationId,
      status: outcome.status,
      stopReason: outcome.stopReason.type
    };
  }

  #multiplyTool(): PiTool<
    ToolContext,
    typeof multiplyParameters,
    { readonly result: number; readonly revision: number }
  > {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply by the current tool revision.",
      parameters: multiplyParameters,
      replay: "safe",
      async execute(_id, input, _onUpdate, context) {
        const result = input.value * context.revision;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result, revision: context.revision }
        };
      }
    };
  }

  #waitTool(): PiTool<
    ToolContext,
    typeof waitParameters,
    { readonly interrupted: boolean }
  > {
    return {
      name: "wait",
      label: "Wait",
      description: "Block until the operation is interrupted.",
      parameters: waitParameters,
      replay: "never",
      async execute(
        _id,
        _input,
        _onUpdate,
        _toolContext,
        _invocation,
        piContext
      ) {
        const signal = piContext.abortSignal;
        const interrupted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), WAIT_TOOL_MS);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true }
          );
        });
        return {
          content: [{ type: "text", text: interrupted ? "stopped" : "waited" }],
          details: { interrupted }
        };
      }
    };
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
