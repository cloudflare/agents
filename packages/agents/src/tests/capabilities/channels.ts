import { DurableObject } from "cloudflare:workers";
import {
  Channels,
  deliverToSurfaces,
  type AgentHarness,
  type Channel,
  type ChannelMessageSurface,
  type DeliveryResult,
  type EventOrigin,
  type GatewayEvent,
  type GatewayOrigin,
  type HarnessSession,
  type HarnessSessions,
  type SessionEvent,
  type SessionInfo,
  type SessionState,
  type SubmitOptions
} from "../../experimental/channels";
import { WebChannel } from "../../experimental/channels/web";
import { email } from "../../experimental/channels/email";
import { Lifecycle } from "../../lifecycle";
import { Streams } from "../../streams";
import { Tasks } from "../../tasks";

type Listener = (events: readonly SessionEvent[]) => Promise<void>;

/** What the harness was asked to do, in order. */
export type HarnessCall =
  | {
      type: "submit";
      session: string;
      input: Parameters<HarnessSession["submit"]>[0];
      options?: SubmitOptions;
    }
  | { type: "abort"; session: string; operationId?: string }
  | { type: "reset"; session: string; handoff?: string };

/**
 * A harness the test plays: it records what Channels asks of it, and the
 * test sends the session events a real harness would. Operations never
 * settle on their own.
 */
class ScriptedHarness implements AgentHarness {
  readonly calls: HarnessCall[] = [];
  reject = false;
  /** What a new watch starts from, per session. */
  readonly states = new Map<string, SessionState>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #sessions = new Map<string, SessionInfo>([
    ["default", { id: "default", busy: false }]
  ]);
  #next = 0;

  readonly sessions: HarnessSessions = {
    create: async () => this.#add({ id: this.#id(), busy: false }),
    fork: async (from) =>
      this.#add({ id: this.#id(), parent: from, busy: false }),
    list: async () => [...this.#sessions.values()]
  };

  session(id = "default"): HarnessSession {
    const call = (record: HarnessCall) => {
      if (this.reject) throw new Error("rejected");
      this.calls.push(record);
    };
    return {
      id,
      submit: async (input, options) => {
        call({
          type: "submit",
          session: id,
          input,
          ...(options && { options })
        });
        const operationId = options?.operationId ?? crypto.randomUUID();
        return { operationId, session: id, accepted: true };
      },
      abort: async (operationId) => {
        call({
          type: "abort",
          session: id,
          ...(operationId !== undefined && { operationId })
        });
        return true;
      },
      wait: () => new Promise(() => {}),
      reset: async (handoff) => {
        call({
          type: "reset",
          session: id,
          ...(handoff !== undefined && { handoff })
        });
      },
      watch: async () => {
        const listeners = this.#listeners.get(id) ?? new Set();
        this.#listeners.set(id, listeners);
        let listener: Listener | undefined;
        let close = () => {};
        const closed = new Promise<void>((resolve) => {
          close = resolve;
        });
        return {
          state: this.states.get(id) ?? { messages: [], pending: [] },
          start: (started) => {
            listener = started;
            listeners.add(started);
          },
          stop: async () => {
            if (listener) listeners.delete(listener);
            close();
          },
          closed
        };
      }
    };
  }

  /** Deliver events to the session's watchers, as the harness would. */
  async emit(session: string, events: SessionEvent[]): Promise<void> {
    for (const listener of this.#listeners.get(session) ?? []) {
      await listener(events);
    }
  }

  #id(): string {
    this.#next += 1;
    return `s${this.#next}`;
  }

  #add(info: SessionInfo): HarnessSession {
    this.#sessions.set(info.id, info);
    return this.session(info.id);
  }
}

/**
 * Channels with the Web Channel over a scripted harness. Tests play the
 * harness through RPC and the participants through WebSockets, connecting
 * with the identity header the gateway would set.
 */
export class ChannelsHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly harness = new ScriptedHarness();
  readonly channels = Channels.forHarness(this.harness, {
    streams: new Streams({ maxChunkBytes: 1024 }),
    channels: {
      web: new WebChannel()
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.channels.streams)
    .use(this.channels)
    .use(this.channels.websockets);

  /** An event as the gateway would deliver it. */
  receive(
    event: GatewayEvent,
    origin: GatewayOrigin | EventOrigin
  ): Promise<void> {
    return this.channels.receive(event, origin);
  }

  /**
   * `receive`, returning the error message instead of rejecting: a rejection
   * returned over RPC is reported as uncaught by the test pool.
   */
  async tryReceive(
    event: GatewayEvent,
    origin: GatewayOrigin | EventOrigin
  ): Promise<string | undefined> {
    try {
      await this.channels.receive(event, origin);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  getCalls(): HarnessCall[] {
    return this.harness.calls;
  }

  setReject(reject: boolean): void {
    this.harness.reject = reject;
  }

  /** What the next watch of the session starts from. */
  setState(state: SessionState, session = "default"): void {
    this.harness.states.set(session, state);
  }

  emit(events: SessionEvent[], session = "default"): Promise<void> {
    return this.harness.emit(session, events);
  }

  /** The conversation's responses, oldest first. */
  async responses(conversationId = "default"): Promise<string[]> {
    const streams = await this.channels.streams.list({
      tag: `channels:${conversationId}`
    });
    return streams.map((status) => status.streamId);
  }

  /** Run startup again, as a new instance would. */
  async wake(): Promise<void> {
    await this.channels.onStart();
  }

  async readChunks(responseId: string): Promise<unknown[]> {
    const chunks: unknown[] = [];
    for await (const { chunk } of this.channels.streams.read(responseId)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  async responseState(responseId: string): Promise<string | null> {
    return (await this.channels.streams.status(responseId))?.state ?? null;
  }
}

/**
 * The fake Channel's scripts, by object id: in the isolate, not the
 * object's storage, so a reset cannot roll a step of one back.
 */
const fakeScripts = new Map<string, FakePost[]>();

/** What the fake gateway Channel does with the next posts, in order. */
export type FakePost =
  | "ok"
  | "retryable"
  | "refused"
  | "uncertain"
  /** The object resets after the provider saw the post. */
  | "reset"
  /** The object resets before the post left it. */
  | "reset-before-send";

/**
 * Channels whose `fake` Channel is a gateway Channel served inside the
 * agent (`deliverToSurfaces`): it records what each post streamed, and does
 * with each what the test scripted.
 */
export class ChannelsDeliveryObject extends DurableObject<Cloudflare.Env> {
  readonly harness = new ScriptedHarness();
  readonly tasks = new Tasks();

  readonly #fake: Channel = {
    stream: async (surface, chunks): Promise<DeliveryResult> => {
      const id = this.ctx.id.toString();
      const [outcome = "ok", ...rest] = fakeScripts.get(id) ?? [];
      fakeScripts.set(id, rest);
      if (outcome === "reset-before-send") {
        // Nothing has left the object: its writes since its last I/O go.
        this.ctx.abort("reset before the post");
        return new Promise<never>(() => {});
      }
      let text = "";
      for await (const chunk of chunks) {
        if (chunk.type === "text-delta") text += chunk.delta;
      }
      // Kept so they outlive a reset.
      this.ctx.storage.kv.put("posts", [
        ...this.getPosts(),
        { label: surface.label, text, outcome }
      ]);
      switch (outcome) {
        case "ok":
          return { status: "delivered" };
        case "retryable":
          return {
            status: "failed",
            retryable: true,
            error: { code: "RATE_LIMITED", message: "slow down" }
          };
        case "refused":
          return {
            status: "failed",
            retryable: false,
            error: { code: "CHANNEL_NOT_FOUND", message: "no such thread" }
          };
        case "uncertain":
          return {
            status: "uncertain",
            reference: "msg-1",
            error: { code: "STREAM_CUT", message: "cut mid-stream" }
          };
        case "reset":
          // The provider saw the post: a real send waits for the object's
          // writes to be durable first (the output gate), as this sync does.
          await this.ctx.storage.sync();
          this.ctx.abort("reset mid-post");
          return new Promise<never>(() => {});
      }
    }
  };

  readonly channels = Channels.forHarness(this.harness, {
    streams: new Streams({ maxChunkBytes: 1024 }),
    channels: {
      fake: deliverToSurfaces(this.#fake, { tasks: this.tasks }),
      email: deliverToSurfaces(
        email({
          from: "agent@example.com",
          binding: {
            send: async (message) => {
              this.ctx.storage.kv.put("emails", [
                ...this.getEmails(),
                {
                  to: message.to as string | string[],
                  subject: message.subject,
                  text: String(message.text)
                }
              ]);
              return { messageId: "m-1" };
            }
          }
        }),
        { tasks: this.tasks }
      )
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.channels.streams)
    .use(this.channels);

  setScript(script: FakePost[]): void {
    fakeScripts.set(this.ctx.id.toString(), script);
  }

  /** A message from a surface of the fake Channel, as the gateway sends it. */
  receive(event: GatewayEvent, origin: GatewayOrigin): Promise<void> {
    return this.channels.receive(event, origin);
  }

  emit(events: SessionEvent[], session = "default"): Promise<void> {
    return this.harness.emit(session, events);
  }

  /** Posts as the Channel saw them: the surface label and the text. */
  getPosts(): Array<{ label: string; text: string; outcome: FakePost }> {
    return this.ctx.storage.kv.get("posts") ?? [];
  }

  /** What the email Channel sent. */
  getEmails(): Array<{ to: string | string[]; subject: string; text: string }> {
    return this.ctx.storage.kv.get("emails") ?? [];
  }

  /** Deliveries still open (pending or running). */
  openDeliveries(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM cf_agents_task_runs WHERE definition = '__cf_delivery:channels:fake' AND status IN ('pending', 'running')"
      )
      .one().n;
  }

  surfaceOf(label: string): ChannelMessageSurface {
    return {
      version: 1,
      channelKey: "fake",
      address: { thread: label },
      label
    };
  }
}
