import { DurableObject } from "cloudflare:workers";
import { tool, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type {
  HarnessSession,
  SessionEvent,
  ToolAnswer
} from "../../../experimental/channels/harness";
import { Lifecycle } from "../../../lifecycle";
import { WebSockets } from "../../../websockets/websockets";
import { ThinkChat } from "../chat";
import {
  classifyContextOverflow,
  setWakeTimingForTests,
  SteerNotSupportedError,
  ThinkHarness
} from "../harness";
import type {
  ThinkOperationResult,
  ThinkReceipt,
  ThinkSubmitOptions
} from "../types";

const GATE_RUNS_KEY = "test:gate:runs";
const RELEASE_KEY = "test:gate:release";
const DANGEROUS_RUNS_KEY = "test:dangerous:runs";
const SYSTEM_KEY = "test:system";
const BLOCK_KEY = "test:block";
const ENDED_KEY = "test:ended";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1
  },
  outputTokens: { reasoning: undefined, text: 1, total: 1 }
};

type StreamPart =
  | { type: "stream-start"; warnings: [] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "finish";
      finishReason: { raw: string; unified: "stop" | "tool-calls" };
      logprobs: undefined;
      usage: typeof usage;
    }
  | { type: "error"; error: unknown };

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { raw: reason, unified: reason },
  logprobs: undefined,
  usage
});

function textReply(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop")
  ];
}

function callReply(
  calls: readonly { name: string; input?: unknown }[]
): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.map(
      (call): StreamPart => ({
        type: "tool-call",
        toolCallId: `call-${crypto.randomUUID()}`,
        toolName: call.name,
        input: JSON.stringify(call.input ?? {})
      })
    ),
    finish("tool-calls")
  ];
}

type PromptMessage = { role: string; content: unknown };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : ""
    )
    .join("");
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const result = content.at(-1) as
    | { output?: { type: string; value?: unknown; reason?: string } }
    | undefined;
  const output = result?.output;
  if (!output) return "";
  switch (output.type) {
    case "error-text":
    case "error-json":
      return `error: ${String(output.value)}`;
    case "execution-denied":
      return "denied";
    case "text":
      return String(output.value);
    default:
      return JSON.stringify(output.value);
  }
}

/** Real Durable Object fixture: a ThinkHarness over a scripted model. */
export class ThinkHarnessTestObject extends DurableObject<Cloudflare.Env> {
  /** Every model call's prompt, in order, for this isolate. */
  readonly prompts: PromptMessage[][] = [];
  #releaseSlow: () => void = () => {};
  #slowHeld = new Promise<void>((resolve) => {
    this.#releaseSlow = resolve;
  });
  #overflowed = false;

  readonly harness = new ThinkHarness({
    system: "You are a test.",
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        // SAFETY: the mock's prompt is the provider's message list.
        const messages = prompt as unknown as PromptMessage[];
        this.prompts.push(messages);
        return { stream: this.#reply(messages) };
      }
    }),
    tools: {
      multiply: tool({
        description: "Multiply by three",
        inputSchema: z.object({ value: z.number() }),
        execute: async ({ value }) => value * 3
      }),
      gate: tool({
        description: "Wait until released",
        inputSchema: z.object({}),
        execute: () => this.#gate()
      }),
      gate_safe: {
        ...tool({
          description: "Wait until released; safe to rerun",
          inputSchema: z.object({}),
          execute: () => this.#gate()
        }),
        recovery: "rerun"
      },
      dangerous: tool({
        description: "Needs approval",
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => {
          const runs =
            (this.ctx.storage.kv.get<number>(DANGEROUS_RUNS_KEY) ?? 0) + 1;
          this.ctx.storage.kv.put(DANGEROUS_RUNS_KEY, runs);
          return "did the dangerous thing";
        }
      }),
      ask: tool({
        description: "Runs on the client",
        inputSchema: z.object({ question: z.string() })
      })
    },
    recovery: { backoffMs: 10 },
    hooks: {
      classifyError: classifyContextOverflow,
      beforeTurn: () => {
        const system = this.ctx.storage.kv.get<string>(SYSTEM_KEY);
        return system ? { system } : undefined;
      },
      beforeToolCall: ({ toolName }) => {
        const blocked = this.ctx.storage.kv.get<string>(BLOCK_KEY);
        if (blocked === toolName) {
          return { action: "block", reason: "blocked by policy" };
        }
        if (blocked === `substitute:${toolName}`) {
          return { action: "substitute", output: 1000 };
        }
        return undefined;
      },
      onTurnEnd: ({ status }) => {
        const ended = this.ctx.storage.kv.get<string[]>(ENDED_KEY) ?? [];
        this.ctx.storage.kv.put(ENDED_KEY, [...ended, status]);
      }
    },
    configureSession: (session) => {
      session.onCompaction(async (history) => {
        // Everything but the newest message.
        const last = history.at(-2);
        const first = history[0];
        if (!first || !last) return null;
        return {
          summary: "[compacted]",
          fromMessageId: first.id,
          toMessageId: last.id
        };
      });
    }
  });
  readonly webSockets = new WebSockets();
  readonly chat = new ThinkChat({
    harness: this.harness,
    webSockets: this.webSockets
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.webSockets)
    .use(this.chat);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, { heartbeatMs: 1_000 });
  }

  #reply(prompt: PromptMessage[]): ReadableStream<StreamPart> {
    const last = prompt.filter((m) => m.role !== "system").at(-1);
    let parts: StreamPart[];
    if (last?.role === "tool") {
      parts = textReply(`tool said: ${toolResultText(last.content)}`);
    } else if (last?.role === "assistant") {
      parts = textReply("continued");
    } else {
      const text = contentText(last?.content);
      const multiply = /^multiply (\d+)$/.exec(text);
      if (multiply) {
        parts = callReply([
          { name: "multiply", input: { value: Number(multiply[1]) } }
        ]);
      } else if (text === "two tools") {
        parts = callReply([
          { name: "multiply", input: { value: 2 } },
          { name: "multiply", input: { value: 3 } }
        ]);
      } else if (text === "gate" || text === "gate-safe") {
        parts = callReply([{ name: text === "gate" ? "gate" : "gate_safe" }]);
      } else if (text === "approve") {
        parts = callReply([{ name: "dangerous" }]);
      } else if (text === "client") {
        parts = callReply([{ name: "ask", input: { question: "why?" } }]);
      } else if (text === "slow") {
        return this.#slow();
      } else if (text === "fail") {
        parts = [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("model exploded") }
        ];
      } else if (text === "overflow" && !this.#overflowed) {
        this.#overflowed = true;
        parts = [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("context_length_exceeded") }
        ];
      } else {
        parts = textReply(`echo: ${text}`);
      }
    }
    return new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      }
    });
  }

  /** Streams twelve deltas, then holds until `releaseSlow()`. */
  #slow(): ReadableStream<StreamPart> {
    const held = this.#slowHeld;
    return new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        for (let i = 0; i < 12; i++) {
          controller.enqueue({ type: "text-delta", id: "t", delta: "x" });
        }
        await held;
        controller.enqueue({ type: "text-delta", id: "t", delta: " end" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue(finish("stop"));
        controller.close();
      }
    });
  }

  async #gate(): Promise<string> {
    const runs = (this.ctx.storage.kv.get<number>(GATE_RUNS_KEY) ?? 0) + 1;
    this.ctx.storage.kv.put(GATE_RUNS_KEY, runs);
    while (!this.ctx.storage.kv.get(RELEASE_KEY)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `released after ${runs} runs`;
  }

  // ── RPC for the tests ────────────────────────────────────────────────────

  submit(
    text: string,
    options: ThinkSubmitOptions & { session?: string } = {}
  ): Promise<ThinkReceipt> {
    const { session, ...rest } = options;
    return this.harness.session(session).submit(text, rest);
  }

  /** Submit through the shared harness interface, asking to steer. */
  async steer(text: string): Promise<string> {
    const session: HarnessSession = this.harness.session();
    try {
      await session.submit(
        { parts: [{ type: "text", text }] },
        { whenBusy: "steer" }
      );
      return "accepted";
    } catch (error) {
      return error instanceof SteerNotSupportedError ? error._tag : "other";
    }
  }

  answer(answer: ToolAnswer, session?: string): Promise<ThinkReceipt> {
    return this.harness.session(session).submit(answer);
  }

  async prompt(text: string, session?: string) {
    const response = await this.harness.session(session).prompt(text);
    return { ...response, messages: summarize(response.messages) };
  }

  wait(operationId: string, session?: string): Promise<ThinkOperationResult> {
    return this.harness.session(session).wait(operationId);
  }

  async messages(session?: string): Promise<string[]> {
    return summarize(await this.harness.session(session).messages());
  }

  /** Ids of each message, in order. */
  async messageIds(session?: string): Promise<string[]> {
    return (await this.harness.session(session).messages()).map((m) => m.id);
  }

  /** The latest message's tool calls, with their approval ids. */
  async lastToolCalls(): Promise<
    { toolCallId: string; approvalId: string | undefined }[]
  > {
    const last = (await this.harness.session().messages()).at(-1);
    return (last?.parts ?? []).flatMap((part) =>
      "toolCallId" in part
        ? [
            {
              toolCallId: part.toolCallId,
              approvalId:
                "approval" in part && part.approval
                  ? part.approval.id
                  : undefined
            }
          ]
        : []
    );
  }

  pending() {
    return this.harness.pending();
  }

  abort(operationId?: string, session?: string): Promise<boolean> {
    return this.harness.session(session).abort(operationId);
  }

  reset(session?: string): Promise<void> {
    return this.harness.session(session).reset();
  }

  regenerate(): Promise<ThinkReceipt> {
    return this.harness.session().regenerate();
  }

  /** Write through the transcript handle; the event types a listener saw. */
  async writeDirectly(text: string): Promise<string[]> {
    const seen: string[] = [];
    const session = this.harness.session();
    const stop = session.subscribe((event) => {
      seen.push(
        event.type === "message" ? `message:${event.message.id}` : event.type
      );
    });
    await session.transcript.appendMessage({
      id: "direct",
      role: "user",
      parts: [{ type: "text", text }]
    });
    stop();
    return seen;
  }

  async branches(messageId: string): Promise<number> {
    return (await this.harness.session().transcript.getBranches(messageId))
      .length;
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  async fork(from: string): Promise<string> {
    return (await this.harness.sessions.fork(from)).id;
  }

  listSessions() {
    return this.harness.sessions.list();
  }

  /** Resolve once the gate tool has started `runs` times. */
  async gateStarted(runs: number): Promise<number> {
    for (let i = 0; i < 300; i++) {
      const count = this.ctx.storage.kv.get<number>(GATE_RUNS_KEY) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The gate tool never started");
  }

  release(): void {
    this.ctx.storage.kv.put(RELEASE_KEY, true);
  }

  gateRuns(): number {
    return this.ctx.storage.kv.get<number>(GATE_RUNS_KEY) ?? 0;
  }

  dangerousRuns(): number {
    return this.ctx.storage.kv.get<number>(DANGEROUS_RUNS_KEY) ?? 0;
  }

  releaseSlow(): void {
    this.#releaseSlow();
  }

  /** Resolve once a model call's chunks are durable in its stream. */
  async streamed(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const rows = this.ctx.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM cf_agents_stream_blocks"
        )
        .one();
      if (rows.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Nothing was streamed");
  }

  streamRows(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM cf_agents_streams")
      .one().n;
  }

  /** Think's chat(): the chunk types the callback saw, and how it ended. */
  async chatCallback(text: string): Promise<{ types: string[]; end: string }> {
    const types: string[] = [];
    let end = "";
    await this.harness.session().chat(text, {
      onEvent: (json) => {
        types.push((JSON.parse(json) as { type: string }).type);
      },
      onDone: () => {
        end = "done";
      },
      onError: (error) => {
        end = `error: ${error}`;
      }
    });
    return { types, end };
  }

  inspect(operationId: string) {
    return this.harness.session().inspect(operationId);
  }

  setSystem(system: string): void {
    this.ctx.storage.kv.put(SYSTEM_KEY, system);
  }

  setBlock(rule: string): void {
    this.ctx.storage.kv.put(BLOCK_KEY, rule);
  }

  ended(): string[] {
    return this.ctx.storage.kv.get<string[]>(ENDED_KEY) ?? [];
  }

  modelCalls(): number {
    return this.prompts.length;
  }

  lastPromptText(): string {
    const prompt = this.prompts.at(-1) ?? [];
    return prompt.map((m) => `${m.role}:${contentText(m.content)}`).join("|");
  }

  /** Watch a session until an operation settles; the event types seen. */
  async watchUntilSettled(session?: string): Promise<{
    initial: number;
    types: string[];
  }> {
    const watch = await this.harness.session(session).watch();
    const types: string[] = [];
    await new Promise<void>((resolve) => {
      watch.start(async (events: readonly SessionEvent[]) => {
        for (const event of events) {
          types.push(
            event.type === "operation"
              ? `operation:${event.status.status}`
              : event.type
          );
          if (
            event.type === "operation" &&
            (event.status.status === "done" ||
              event.status.status === "unanswered")
          ) {
            resolve();
          }
        }
      });
    });
    await watch.stop();
    return { initial: watch.state.messages.length, types };
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

/** Each message as `role: text`, with its tool calls as `[name state]`. */
function summarize(messages: readonly UIMessage[]): string[] {
  return messages.map((message) => {
    const pieces = message.parts.flatMap((part) => {
      if (part.type === "text") return [part.text];
      if ("toolCallId" in part) {
        const name =
          part.type === "dynamic-tool"
            ? part.toolName
            : part.type.slice("tool-".length);
        return [`[${name} ${part.state}]`];
      }
      return [];
    });
    return `${message.role}: ${pieces.join(" ")}`;
  });
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
};
