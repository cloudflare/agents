import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import type { SessionMessage } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import {
  Harness,
  type HarnessDriveContext,
  type HarnessEvent,
  type HarnessInput,
  type HarnessRuntimeMessagePage,
  type HarnessMessagesOptions,
  type HarnessPreview,
  type HarnessPromptPayload,
  type HarnessRuntime,
  type HarnessRuntimeStartContext
} from "../index";

/** The vocabulary the echo runtime adds to the core. */
export type EchoProtocol = {
  event: { type: "echo_permission"; decision: string };
  submit: { kind: "note"; payload: { text: string } };
  result: { echoed: string };
};

function textOf(input: HarnessInput): string {
  return typeof input === "string" ? input : (input.text ?? "");
}

/**
 * A runtime that echoes each prompt back as one assistant message. Prompts
 * starting with `ask` raise a permission request first; prompts starting
 * with `slow` wait until interrupted or a timer fires; `note` submissions
 * are appended to the transcript without a turn.
 */
export class EchoRuntime implements HarnessRuntime<EchoProtocol> {
  readonly id = "in-do:echo";
  readonly capabilities = new Set(["requests", "sessions"] as const);
  #storage: DurableObjectStorage | undefined;

  onStart(ctx: HarnessRuntimeStartContext): void {
    this.#storage = ctx.storage;
  }

  async drive(ctx: HarnessDriveContext<EchoProtocol>): Promise<void> {
    for (;;) {
      // An operation the last isolate left running has no inbox row any
      // more; its kind and payload come from the operation row.
      const active = ctx.active();
      const head =
        active !== null && active.kind !== "adopted"
          ? {
              operationId: active.operationId,
              kind: active.kind,
              payload: active.payload
            }
          : ctx.inbox.peek({ kinds: ["prompt", "note"], limit: 1 })[0];
      if (!head || head.operationId === null || head.payload === null) return;
      const operationId = head.operationId;
      if (head.kind === "note") {
        const note = head.payload as { text: string };
        await ctx.begin(operationId);
        await this.#remember(ctx.sessionId, {
          id: `note:${operationId}`,
          role: "system",
          parts: [{ type: "text", text: note.text }]
        });
        await ctx.settle(operationId, {
          status: "completed",
          stopReason: { type: "end_turn" },
          raw: { echoed: note.text }
        });
        continue;
      }
      const payload = head.payload as unknown as HarnessPromptPayload;
      const text = textOf(payload.input);
      const op = await ctx.begin(operationId);
      await this.#remember(ctx.sessionId, {
        id: `user:${operationId}`,
        role: "user",
        parts: [{ type: "text", text }]
      });
      const messageId = `assistant:${operationId}`;
      op.append({ type: "message_start", messageId, role: "assistant" });
      if (text.startsWith("ask")) {
        const reply = await ctx.ask({
          requestId: `perm:${operationId}`,
          operationId,
          type: "permission",
          action: "Bash",
          resources: [text]
        });
        op.append({
          type: "extension",
          body: {
            type: "echo_permission",
            decision: reply.type === "permission" ? reply.decision : "n/a"
          }
        });
      }
      let interrupted = false;
      if (text.startsWith("slow")) {
        // A fixture only: a real runtime would `ctx.wake()` and return
        // instead of holding the drive pass open on wall time.
        const signal = ctx.interrupted(operationId);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              interrupted = true;
              resolve();
            },
            { once: true }
          );
        });
      }
      op.preview({ type: "text_delta", messageId, delta: `echo: ${text}` });
      const echoed = interrupted ? "(interrupted)" : `echo: ${text}`;
      op.append({
        type: "message_end",
        messageId,
        role: "assistant",
        parts: [{ type: "text", text: echoed }]
      });
      await this.#remember(ctx.sessionId, {
        id: messageId,
        role: "assistant",
        parts: [{ type: "text", text: echoed }]
      });
      await ctx.settle(operationId, {
        status: interrupted ? "aborted" : "completed",
        stopReason: { type: interrupted ? "interrupted" : "end_turn" },
        raw: { echoed }
      });
    }
  }

  async messages(
    sessionId: string,
    _options: HarnessMessagesOptions
  ): Promise<HarnessRuntimeMessagePage> {
    const messages =
      (await this.#storage?.get<SessionMessage[]>(`echo:${sessionId}`)) ?? [];
    return { messages };
  }

  async delete(sessionId: string): Promise<void> {
    await this.#storage?.delete(`echo:${sessionId}`);
  }

  async #remember(sessionId: string, message: SessionMessage): Promise<void> {
    const key = `echo:${sessionId}`;
    const messages = (await this.#storage?.get<SessionMessage[]>(key)) ?? [];
    if (messages.some((known) => known.id === message.id)) return;
    await this.#storage?.put(key, [...messages, message]);
  }
}

/** Real Durable Object fixture around the shared Harness. */
export class HarnessTestObject extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new Harness<EchoProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: new EchoRuntime(),
    policy: { requestTimeoutMs: 2_000 }
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);

  async run(text: string, sessionId?: string) {
    await this.lifecycle.start();
    const session = this.harness.session(sessionId);
    const receipt = await session.prompt(text);
    const result = await session.wait(receipt.operationId, {
      timeoutMs: 10_000
    });
    return { receipt, result };
  }

  /** Start a slow turn and return once the runtime is running it. */
  async startSlow(text: string) {
    await this.lifecycle.start();
    const session = this.harness.session();
    const receipt = await session.prompt(`slow ${text}`);
    for (let i = 0; i < 50; i++) {
      if ((await session.status()).state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return receipt.operationId;
  }

  async prompt(text: string, operationId?: string, sessionId?: string) {
    await this.lifecycle.start();
    return this.harness
      .session(sessionId)
      .prompt(text, operationId === undefined ? {} : { operationId });
  }

  async wait(operationId: string, sessionId?: string) {
    await this.lifecycle.start();
    return this.harness
      .session(sessionId)
      .wait(operationId, { timeoutMs: 10_000 });
  }

  async note(text: string) {
    await this.lifecycle.start();
    const session = this.harness.session();
    const receipt = await session.submit({ kind: "note", payload: { text } });
    return session.wait(receipt.operationId, { timeoutMs: 10_000 });
  }

  // Results cross the test's RPC boundary: keep them to the fields the
  // tests assert, because the full shapes are too deep for the stub types.
  async interrupt() {
    await this.lifecycle.start();
    const result = await this.harness.session().interrupt();
    return {
      operationId: result.operationId,
      newlyRequested: result.newlyRequested,
      drained: result.drained.map((entry) => entry.operationId)
    };
  }

  async requests() {
    await this.lifecycle.start();
    return (await this.harness.session().requests()).map((request) => ({
      requestId: request.requestId,
      type: request.type
    }));
  }

  async reply(requestId: string, decision: "allow" | "deny") {
    await this.lifecycle.start();
    return this.harness
      .session()
      .reply(requestId, { type: "permission", decision });
  }

  async status(sessionId?: string) {
    await this.lifecycle.start();
    const status = await this.harness.session(sessionId).status();
    return {
      state: status.state,
      pendingRequests: [...status.pendingRequests],
      queuedOperations: status.queuedOperations,
      cursor: status.cursor,
      capabilities: [...status.capabilities]
    };
  }

  async messages(sessionId?: string) {
    await this.lifecycle.start();
    return (await this.harness.session(sessionId).messages()).messages.map(
      (message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("")
    );
  }

  /** Every frame seq of the session's durable log, in replay order. */
  async seqs(sessionId?: string) {
    await this.lifecycle.start();
    const seqs: number[] = [];
    const controller = new AbortController();
    for await (const event of this.harness.session(sessionId).events({
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if (!("preview" in event)) seqs.push(event.seq);
    }
    return seqs;
  }

  /** Replay the whole durable log, without tailing. */
  async eventTypes(from?: string, sessionId?: string) {
    await this.lifecycle.start();
    const types: string[] = [];
    const controller = new AbortController();
    const session = this.harness.session(sessionId);
    for await (const event of session.events({
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

  /** Tail live events for one operation, previews included. */
  async tailEvents(text: string) {
    await this.lifecycle.start();
    const session = this.harness.session();
    const controller = new AbortController();
    const seen: (HarnessEvent<EchoProtocol> | HarnessPreview)[] = [];
    const status = await session.status();
    const receipt = await session.prompt(text);
    for await (const event of session.events({
      from: status.cursor,
      previews: true,
      signal: controller.signal
    })) {
      seen.push(event);
      if (
        !("preview" in event) &&
        event.body.type === "operation_settled" &&
        event.operationId === receipt.operationId
      ) {
        controller.abort();
      }
    }
    return seen.map((event) =>
      "preview" in event
        ? `preview:${event.body.type}:${event.body.delta}`
        : event.body.type
    );
  }

  async listSessions(limit?: number, cursor?: string) {
    await this.lifecycle.start();
    return this.harness.sessions.list({
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor })
    });
  }

  async deleteSession(sessionId: string) {
    await this.lifecycle.start();
    await this.harness.sessions.delete(sessionId);
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
