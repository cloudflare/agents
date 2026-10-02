import { DurableObject } from "cloudflare:workers";
import {
  Channels,
  type AgentHarness,
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
import { Lifecycle } from "../../lifecycle";
import { Streams } from "../../streams";

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
