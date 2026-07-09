// PROTOTYPE, react to this, do not build on it.
//
// Channels abstraction settled in wayfinder ticket 03 ("Channels abstraction
// design"). Illustrative only: not wired into the package build. Ticket 04
// (tracer bullet) is where this becomes real code in packages/rethink/src.
//
// Builds on prototypes/01-composition-model.ts (Primitive, PrimitiveHost).
//
// Decisions captured:
//   1. Channel = transport only. Policy (instructions, tools, maxTurns) is
//      deferred; may later depend on which channel a turn arrived on.
//   2. Two roles, ChannelIn and ChannelOut. A Primitive may implement either,
//      both, or neither. "Channel" is informal for an object implementing either.
//   3. Inbound: generic neutral envelope + post-construction listener
//      registration (onMessage / unsubscribe). Channel never knows about chat.
//   4. Outbound: generic target + openStream(target) with UIMessageChunk writes,
//      complete, interrupt, and error. No central target union.
//   5. Multiplexing: in-method claim. fetch returns undefined = not mine;
//      onEmail returns claimed.
//   6. Worker->DO: generic host.deliverEmail + fan-out; Email ChannelIn claims.
//   7. WebSocket details are deliberately omitted here. The real implementation
//      should preserve compatibility with the existing Agent websocket frame
//      protocol where possible instead of inventing a toy protocol in this
//      artifact.
//   8. Storage: none required. Opt-in cursors/maps/outboxes later.
//   9. Inner primitives remain plain Primitive with no DO methods and no
//      ChannelIn/Out, the model does not force edge surface on them.

import type { UIMessageChunk } from "ai";

// -----------------------------------------------------------------------------
// Shared message shapes (transport-neutral, transport-typed at the edges)
// -----------------------------------------------------------------------------

/**
 * Neutral inbound envelope.
 *
 * TRaw carries the typed transport payload when the channel can parse it.
 * TReplyTo carries the channel-owned, serializable target for a reply. Transport
 * concepts such as conversation ids and thread ids belong inside TReplyTo/raw,
 * not on this shared envelope.
 */
interface InboundMessage<TRaw = unknown, TReplyTo = unknown> {
  channelId: string;
  from: string;
  body: string;
  attachments?: { id: string; mime?: string; url?: string }[];
  /** Serializable reply target. Often derived from inbound, never required. */
  replyTo?: TReplyTo;
  /** Typed transport payload when the channel has one. */
  raw?: TRaw;
}

interface OutStream {
  write(chunk: UIMessageChunk): void | Promise<void>;
  complete(): void | Promise<void>;
  interrupt(): void | Promise<void>;
  error(err: unknown): void | Promise<void>;
}

// -----------------------------------------------------------------------------
// Roles a Primitive may implement
// -----------------------------------------------------------------------------

type MessageHandler<TRaw = unknown, TReplyTo = unknown> = (
  msg: InboundMessage<TRaw, TReplyTo>
) => void | Promise<void>;

/** Ingress role: accept inbound, claim shared entrypoints, fan out to listeners. */
interface ChannelIn<TRaw = unknown, TReplyTo = unknown> {
  readonly channelId: string;
  onMessage(handler: MessageHandler<TRaw, TReplyTo>): () => void;
  // DO-shaped claim methods live on Primitive (fetch?, webSocketMessage?, ...)
  // and are how the channel claims events. Email uses onEmail? claim return.
}

/** Egress role: progressive delivery to an explicit channel-owned target. */
interface ChannelOut<TTarget = unknown> {
  readonly channelId: string;
  openStream(target: TTarget): OutStream;
}

// Primitive from ticket 01, restated so this file stands alone.
interface Primitive {
  fetch?(
    request: Request
  ): Promise<Response | undefined> | Response | undefined;
  webSocketMessage?(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): void | Promise<void>;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  alarm?(): void | Promise<void>;
  /** Worker-forwarded email. Return true = claimed; false/void = not mine. */
  onEmail?(msg: InboundEmail): boolean | void | Promise<boolean | void>;
}

interface InboundEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
}

// -----------------------------------------------------------------------------
// Outbound helpers
// -----------------------------------------------------------------------------

function textFromChunk(chunk: UIMessageChunk): string {
  const candidate = chunk as {
    type?: unknown;
    delta?: unknown;
    text?: unknown;
  };
  if (candidate.type === "text-delta" && typeof candidate.delta === "string") {
    return candidate.delta;
  }
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  return "";
}

function textDelta(text: string): UIMessageChunk {
  return { type: "text-delta", id: "prototype", delta: text } as UIMessageChunk;
}

// -----------------------------------------------------------------------------
// EmailChannel, ChannelIn + ChannelOut + Primitive (Worker-forwarded)
// -----------------------------------------------------------------------------

interface EmailRaw {
  from: string;
  to: string;
  subject: string;
  messageId?: string;
}

interface EmailTarget {
  to: string;
  subject?: string;
  inReplyTo?: string;
}

interface EmailChannelDeps {
  send(to: string, subject: string, body: string): Promise<void>;
  /** Optional: only claim messages addressed to this local-part / recipient. */
  claimTo?: (to: string) => boolean;
}

class EmailChannel
  implements
    Primitive,
    ChannelIn<EmailRaw, EmailTarget>,
    ChannelOut<EmailTarget>
{
  readonly channelId = "email";
  #handlers = new Set<MessageHandler<EmailRaw, EmailTarget>>();

  constructor(
    private _ctx: DurableObjectState,
    private deps: EmailChannelDeps
  ) {}

  onMessage(handler: MessageHandler<EmailRaw, EmailTarget>): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async onEmail(msg: InboundEmail): Promise<boolean> {
    if (this.deps.claimTo && !this.deps.claimTo(msg.to)) return false;
    await this.emit({
      channelId: this.channelId,
      from: msg.from,
      body: msg.body,
      replyTo: {
        to: msg.from,
        subject: `re: ${msg.subject}`,
        inReplyTo: msg.messageId
      },
      raw: {
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        messageId: msg.messageId
      }
    });
    return true;
  }

  openStream(target: EmailTarget): OutStream {
    const chunks: UIMessageChunk[] = [];
    const send = this.deps.send;
    return {
      write(chunk) {
        chunks.push(chunk);
      },
      async complete() {
        await send(
          target.to,
          target.subject ?? "message",
          chunks.map(textFromChunk).join("")
        );
      },
      async interrupt() {
        await send(target.to, target.subject ?? "message", "[interrupted]");
      },
      async error(err) {
        await send(
          target.to,
          target.subject ?? "message",
          err instanceof Error ? err.message : String(err)
        );
      }
    };
  }

  private async emit(
    msg: InboundMessage<EmailRaw, EmailTarget>
  ): Promise<void> {
    await Promise.all([...this.#handlers].map((h) => h(msg)));
  }
}

// -----------------------------------------------------------------------------
// Dedicated webhook channels, not user-configured generic webhook plumbing
// -----------------------------------------------------------------------------

interface SlackWebhookPayload {
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
}

interface SlackTarget {
  channel: string;
  threadTs?: string;
}

interface SlackDeps {
  postMessage(target: SlackTarget, chunks: UIMessageChunk[]): Promise<void>;
}

class SlackWebhookChannel
  implements
    Primitive,
    ChannelIn<SlackWebhookPayload, SlackTarget>,
    ChannelOut<SlackTarget>
{
  readonly channelId = "slack";
  #handlers = new Set<MessageHandler<SlackWebhookPayload, SlackTarget>>();

  constructor(
    private _ctx: DurableObjectState,
    private deps: SlackDeps
  ) {}

  onMessage(
    handler: MessageHandler<SlackWebhookPayload, SlackTarget>
  ): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async fetch(request: Request): Promise<Response | undefined> {
    if (new URL(request.url).pathname !== "/hooks/slack") return undefined;
    const raw = (await request.json()) as SlackWebhookPayload;
    await this.emit({
      channelId: this.channelId,
      from: raw.user,
      body: raw.text,
      replyTo: { channel: raw.channel, threadTs: raw.thread_ts },
      raw
    });
    return new Response("ok");
  }

  openStream(target: SlackTarget): OutStream {
    const chunks: UIMessageChunk[] = [];
    return {
      write(chunk) {
        chunks.push(chunk);
      },
      complete: () => this.deps.postMessage(target, chunks),
      interrupt: () =>
        this.deps.postMessage(target, [textDelta("[interrupted]")]),
      error: (err) =>
        this.deps.postMessage(target, [
          textDelta(err instanceof Error ? err.message : String(err))
        ])
    };
  }

  private async emit(
    msg: InboundMessage<SlackWebhookPayload, SlackTarget>
  ): Promise<void> {
    await Promise.all([...this.#handlers].map((h) => h(msg)));
  }
}

interface TelegramWebhookPayload {
  message: {
    chat: { id: string };
    from?: { id: string };
    text?: string;
    message_thread_id?: string;
  };
}

interface TelegramTarget {
  chatId: string;
  messageThreadId?: string;
}

interface TelegramDeps {
  sendMessage(target: TelegramTarget, chunks: UIMessageChunk[]): Promise<void>;
}

class TelegramWebhookChannel
  implements
    Primitive,
    ChannelIn<TelegramWebhookPayload, TelegramTarget>,
    ChannelOut<TelegramTarget>
{
  readonly channelId = "telegram";
  #handlers = new Set<MessageHandler<TelegramWebhookPayload, TelegramTarget>>();

  constructor(
    private _ctx: DurableObjectState,
    private deps: TelegramDeps
  ) {}

  onMessage(
    handler: MessageHandler<TelegramWebhookPayload, TelegramTarget>
  ): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async fetch(request: Request): Promise<Response | undefined> {
    if (new URL(request.url).pathname !== "/hooks/telegram") return undefined;
    const raw = (await request.json()) as TelegramWebhookPayload;
    const msg = raw.message;
    await this.emit({
      channelId: this.channelId,
      from: msg.from?.id ?? msg.chat.id,
      body: msg.text ?? "",
      replyTo: {
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id
      },
      raw
    });
    return new Response("ok");
  }

  openStream(target: TelegramTarget): OutStream {
    const chunks: UIMessageChunk[] = [];
    return {
      write(chunk) {
        chunks.push(chunk);
      },
      complete: () => this.deps.sendMessage(target, chunks),
      interrupt: () =>
        this.deps.sendMessage(target, [textDelta("[interrupted]")]),
      error: (err) =>
        this.deps.sendMessage(target, [
          textDelta(err instanceof Error ? err.message : String(err))
        ])
    };
  }

  private async emit(
    msg: InboundMessage<TelegramWebhookPayload, TelegramTarget>
  ): Promise<void> {
    await Promise.all([...this.#handlers].map((h) => h(msg)));
  }
}

// -----------------------------------------------------------------------------
// Delivery registration helper
// -----------------------------------------------------------------------------

interface ChannelOutputRegistration {
  channelId: string;
  openStream(target: unknown): OutStream;
}

function output<TTarget>(
  channel: ChannelOut<TTarget>
): ChannelOutputRegistration {
  return {
    channelId: channel.channelId,
    openStream: (target) => channel.openStream(target as TTarget)
  };
}

class ChannelDirectory {
  #outputs = new Map<string, ChannelOutputRegistration>();

  constructor(outputs: ChannelOutputRegistration[]) {
    for (const out of outputs) this.#outputs.set(out.channelId, out);
  }

  listen<TRaw, TReplyTo>(
    input: ChannelIn<TRaw, TReplyTo>,
    handler: (msg: InboundMessage<TRaw, TReplyTo>) => void | Promise<void>
  ): () => void {
    return input.onMessage(handler);
  }

  open(channelId: string, target: unknown): OutStream | undefined {
    return this.#outputs.get(channelId)?.openStream(target);
  }

  reply<TReplyTo>(
    msg: InboundMessage<unknown, TReplyTo>,
    chunks: UIMessageChunk[]
  ): Promise<void> | void {
    if (msg.replyTo === undefined) return;
    const stream = this.open(msg.channelId, msg.replyTo);
    if (!stream) return;
    return (async () => {
      for (const chunk of chunks) await stream.write(chunk);
      await stream.complete();
    })();
  }
}

// -----------------------------------------------------------------------------
// Inner primitive sense-check: no DO methods, no ChannelIn/Out
// -----------------------------------------------------------------------------

/** Example inner primitive: consumed via deps, never reached from the edge. */
class SessionMemory implements Primitive {
  constructor(private ctx: DurableObjectState) {}
  // no fetch, no webSocket*, no alarm, no onEmail
  append(_msg: InboundMessage): void {
    // would write SQL under a namespaced table (namespacing still fog)
    void this.ctx;
  }
}

// -----------------------------------------------------------------------------
// Composition root: Email + Slack + Telegram + inner
// -----------------------------------------------------------------------------

declare abstract class DurableObject<Env = unknown> {
  constructor(ctx: DurableObjectState, env: Env);
  protected ctx: DurableObjectState;
  protected env: Env;
}

// Host fan-out refined for email claim (first claimer wins; others skipped).
abstract class PrimitiveHost<Env = unknown> extends DurableObject<Env> {
  protected abstract build(ctx: DurableObjectState, env: Env): Primitive[];

  #primitives?: Primitive[];
  private get primitives(): Primitive[] {
    this.#primitives ??= this.build(this.ctx, this.env);
    return this.#primitives;
  }

  async fetch(request: Request): Promise<Response> {
    for (const p of this.primitives) {
      const res = await p.fetch?.(request);
      if (res) return res;
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await Promise.all(
      this.primitives.map((p) => p.webSocketMessage?.(ws, message))
    );
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    clean: boolean
  ) {
    await Promise.all(
      this.primitives.map((p) => p.webSocketClose?.(ws, code, reason, clean))
    );
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    await Promise.all(
      this.primitives.map((p) => p.webSocketError?.(ws, error))
    );
  }

  async alarm() {
    await Promise.all(this.primitives.map((p) => p.alarm?.()));
  }

  async deliverEmail(msg: InboundEmail): Promise<void> {
    for (const p of this.primitives) {
      const claimed = await p.onEmail?.(msg);
      if (claimed === true) return; // first claimer wins
    }
  }
}

interface Env {
  EMAIL: { send(to: string, subject: string, body: string): Promise<void> };
  SLACK: { postMessage(target: SlackTarget, text: string): Promise<void> };
  TELEGRAM: {
    sendMessage(target: TelegramTarget, text: string): Promise<void>;
  };
}

class MyAgentDO extends PrimitiveHost<Env> {
  protected build(ctx: DurableObjectState, env: Env): Primitive[] {
    const email = new EmailChannel(ctx, {
      send: (to, subject, body) => env.EMAIL.send(to, subject, body)
    });
    const slack = new SlackWebhookChannel(ctx, {
      postMessage: (target, chunks) =>
        env.SLACK.postMessage(target, chunks.map(textFromChunk).join(""))
    });
    const telegram = new TelegramWebhookChannel(ctx, {
      sendMessage: (target, chunks) =>
        env.TELEGRAM.sendMessage(target, chunks.map(textFromChunk).join(""))
    });
    const session = new SessionMemory(ctx);
    const channels = new ChannelDirectory([
      output(email),
      output(slack),
      output(telegram)
    ]);

    const echo = async (msg: InboundMessage) => {
      session.append(msg);
      await channels.reply(msg, [textDelta(`echo: ${msg.body}`)]);
    };
    channels.listen(email, echo);
    channels.listen(slack, echo);
    channels.listen(telegram, echo);

    // Proactive egress (no inbound envelope): explicit typed target only.
    channels.open("email", { to: "user@example.com", subject: "hello" });

    return [email, slack, telegram, session];
  }
}

export {
  EmailChannel,
  SlackWebhookChannel,
  TelegramWebhookChannel,
  SessionMemory,
  ChannelDirectory,
  PrimitiveHost,
  MyAgentDO
};
export type {
  ChannelIn,
  ChannelOut,
  InboundMessage,
  OutStream,
  Primitive,
  EmailTarget,
  SlackTarget,
  TelegramTarget
};
