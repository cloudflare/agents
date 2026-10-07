/**
 * The harness daemon's core: everything about running an agent inside a
 * container that does not depend on which agent it is.
 *
 * A daemon serves any number of sessions. For each one it keeps a queue of
 * operations, runs them one at a time through an adapter, numbers every
 * frame it produces, and keeps frames until the Durable Object acknowledges
 * them, so a reconnecting object replays exactly what it missed. The
 * adapter is the only agent-specific part: it opens a session (resuming it
 * from state it persisted earlier, possibly in another container), runs one
 * turn at a time, and reports what happens as `ContainerEvent`s.
 *
 * Nothing here touches Node, a socket library or a model SDK. The transport
 * hands the daemon a `DaemonSocket` per connection and feeds it messages;
 * `./runtime` does that over HTTP in a container, and the tests do it over
 * a `WebSocketPair` in Workers.
 *
 * Modelled on the AI SDK's harness bridge (`runBridge`): the runtime owns
 * the transport, sequencing and replay, and an adapter owns only the agent.
 *
 * @experimental The API may change before it stabilizes.
 */

import {
  chunkEntries,
  CLOSE_REPLACED,
  CONTAINER_PROTOCOL_VERSION,
  inputText,
  parseHostMessage,
  type ContainerEvent,
  type ContainerInput,
  type ContainerOutcome,
  type ContainerSettings,
  type ContainerWhenBusy,
  type DaemonFrame,
  type DaemonMessage,
  type DaemonOperation,
  type HostMessage,
  type JsonValue
} from "./protocol";

/** What an adapter is told when its session opens. */
export type AdapterContext = {
  /** The harness session id. */
  readonly session: string;
  readonly settings: ContainerSettings;
  /**
   * Everything this adapter `persist`ed for the session before, possibly in
   * another container, oldest first. Empty for a new session.
   */
  readonly restore: readonly JsonValue[];
  /** Report an event. It belongs to the operation that is running, if any. */
  emit(event: ContainerEvent): void;
  /**
   * Keep resume state. The Durable Object stores the entries and passes all
   * of them back as `restore` when the session opens in a new container.
   */
  persist(entries: readonly JsonValue[]): void;
  /** A diagnostic line, reported as a `log` event. */
  log(level: "info" | "warn" | "error", message: string): void;
};

/** One turn an adapter runs. */
export type AdapterTurn = {
  readonly operationId: string;
  readonly input: ContainerInput;
  /** Aborted when the operation is aborted. Wind down promptly. */
  readonly signal: AbortSignal;
};

/** An open adapter session. Turns are never run concurrently. */
export type AdapterSession = {
  /**
   * Run one turn to completion. A rejection settles the operation
   * `unanswered` with the error's message.
   */
  run(turn: AdapterTurn): Promise<ContainerOutcome>;
  /**
   * Fold input into the running turn. Return false to have it queued as a
   * follow-up instead. Absent when the agent cannot be steered.
   */
  steer?(input: ContainerInput): boolean | Promise<boolean>;
  /** Apply new settings to the open session. */
  configure?(settings: ContainerSettings): void | Promise<void>;
  /** Release the session's resources. */
  close(): Promise<void>;
};

/** An agent, as the daemon runs it. */
export type ContainerAdapter = {
  /** Reported in `hello`, such as `"claude-code"`. */
  readonly id: string;
  readonly version: string;
  /** Free-form capability names, reported in `hello`. */
  readonly capabilities?: readonly string[];
  /** Open (or resume) one session. */
  open(context: AdapterContext): AdapterSession | Promise<AdapterSession>;
};

/** The send side of one connection, supplied by the transport. */
export type DaemonSocket = {
  send(text: string): void;
  close(code: number, reason: string): void;
};

/** The receive side of one connection, driven by the transport. */
export type DaemonConnection = {
  /** A message arrived. */
  receive(text: string): void;
  /** The connection closed. */
  closed(): void;
};

/** `ContainerDaemon`'s options. */
export type ContainerDaemonOptions = {
  readonly adapter: ContainerAdapter;
  /** This container's id, from `CONTAINER_ENV.runtimeId`. */
  readonly runtimeId: string;
  /**
   * Most unacknowledged frames kept per session. Older ones are dropped and
   * the object reconciles from `hello` instead. Default 10_000.
   */
  readonly maxKeptFrames?: number;
};

/** Settled operations remembered per session, for `hello`. */
const SETTLED_KEPT = 1_000;

type Operation = {
  readonly id: string;
  readonly input: ContainerInput;
  readonly whenBusy: ContainerWhenBusy;
  state:
    | { readonly tag: "queued" }
    | { readonly tag: "running" }
    | { readonly tag: "settled"; readonly outcome: ContainerOutcome };
};

type Running = {
  readonly id: string;
  /** Operations steered into this turn; they settle with it. */
  readonly folded: string[];
  readonly controller: AbortController;
};

type Opened = {
  readonly generation: number;
  readonly session: AdapterSession;
};

/**
 * The daemon core. One per container process.
 *
 * @experimental The API may change before it stabilizes.
 */
export class ContainerDaemon {
  readonly #adapter: ContainerAdapter;
  readonly #runtimeId: string;
  readonly #maxKeptFrames: number;
  readonly #sessions = new Map<string, DaemonSession>();

  /**
   * @param options - The adapter and this container's id.
   */
  constructor(options: ContainerDaemonOptions) {
    this.#adapter = options.adapter;
    this.#runtimeId = options.runtimeId;
    this.#maxKeptFrames = options.maxKeptFrames ?? 10_000;
  }

  /**
   * Attach a connection for a session. A newer connection replaces an older
   * one, which is closed with `CLOSE_REPLACED`. The daemon sends `hello`
   * at once.
   *
   * @param session - The harness session id.
   * @param socket - The send side.
   * @returns The receive side, for the transport to drive.
   */
  connect(session: string, socket: DaemonSocket): DaemonConnection {
    let state = this.#sessions.get(session);
    if (!state) {
      state = new DaemonSession(
        session,
        this.#adapter,
        this.#runtimeId,
        this.#maxKeptFrames
      );
      this.#sessions.set(session, state);
    }
    return state.attach(socket);
  }

  /** Close every adapter session, as the container shuts down. */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.shutdown()));
  }
}

class DaemonSession {
  readonly #id: string;
  readonly #adapter: ContainerAdapter;
  readonly #runtimeId: string;
  readonly #maxKeptFrames: number;
  #seq = 0;
  #kept: { readonly seq: number; readonly frame: DaemonFrame }[] = [];
  readonly #operations = new Map<string, Operation>();
  readonly #queue: string[] = [];
  #running: Running | undefined;
  #opened: Opened | undefined;
  /** Resume state received for an `open` that has not arrived yet. */
  #restoring: { generation: number; entries: JsonValue[] } | undefined;
  #socket: DaemonSocket | undefined;
  #live = false;
  /** Host messages are handled one at a time, in order. */
  #inbox: Promise<void> = Promise.resolve();

  constructor(
    id: string,
    adapter: ContainerAdapter,
    runtimeId: string,
    maxKeptFrames: number
  ) {
    this.#id = id;
    this.#adapter = adapter;
    this.#runtimeId = runtimeId;
    this.#maxKeptFrames = maxKeptFrames;
  }

  attach(socket: DaemonSocket): DaemonConnection {
    const previous = this.#socket;
    this.#socket = socket;
    this.#live = false;
    previous?.close(CLOSE_REPLACED, "replaced by a newer connection");
    this.#send(socket, this.#hello());
    return {
      receive: (text) => {
        if (this.#socket !== socket) return;
        const message = parseHostMessage(text);
        if (!message) {
          this.#send(socket, { type: "error", message: "unparseable message" });
          return;
        }
        this.#inbox = this.#inbox
          .then(() => this.#handle(message))
          .catch((error: unknown) => {
            this.#send(socket, { type: "error", message: errorText(error) });
          });
      },
      closed: () => {
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#live = false;
      }
    };
  }

  async shutdown(): Promise<void> {
    this.#running?.controller.abort();
    const opened = this.#opened;
    this.#opened = undefined;
    await opened?.session.close().catch(() => undefined);
  }

  #hello(): DaemonMessage {
    const operations: DaemonOperation[] = [];
    for (const operation of this.#operations.values()) {
      const state = operation.state;
      operations.push(
        state.tag === "settled"
          ? {
              operationId: operation.id,
              status: "settled",
              outcome: state.outcome
            }
          : { operationId: operation.id, status: state.tag }
      );
    }
    return {
      type: "hello",
      protocol: CONTAINER_PROTOCOL_VERSION,
      runtimeId: this.#runtimeId,
      session: this.#id,
      adapter: {
        id: this.#adapter.id,
        version: this.#adapter.version,
        capabilities: [...(this.#adapter.capabilities ?? [])]
      },
      open: this.#opened?.generation ?? null,
      lastSeq: this.#seq,
      operations
    };
  }

  async #handle(message: HostMessage): Promise<void> {
    switch (message.type) {
      case "restore":
        if (this.#restoring?.generation !== message.generation) {
          this.#restoring = { generation: message.generation, entries: [] };
        }
        this.#restoring.entries.push(...message.entries);
        return;
      case "open":
        await this.#open(message);
        return;
      case "replay":
        this.#replay(message.after);
        return;
      case "prompt":
        await this.#prompt(
          message.operationId,
          message.input,
          message.whenBusy
        );
        return;
      case "abort":
        this.#abort(message.operationId);
        return;
      case "configure":
        await this.#opened?.session.configure?.(message.settings);
        return;
      case "ack":
        this.#kept = this.#kept.filter((kept) => kept.seq > message.seq);
        return;
    }
  }

  async #open(message: Extract<HostMessage, { type: "open" }>): Promise<void> {
    const restoring = this.#restoring;
    this.#restoring = undefined;
    if (this.#opened?.generation === message.generation) return;
    const restore =
      restoring?.generation === message.generation
        ? [...restoring.entries, ...message.restore]
        : message.restore;
    if (this.#opened) {
      // A new generation (a reset) replaces the
      // open session. The turn running in it cannot continue.
      this.#running?.controller.abort();
      await this.#opened.session.close().catch(() => undefined);
      this.#opened = undefined;
    }
    const session = await this.#adapter.open({
      session: this.#id,
      settings: message.settings,
      restore,
      emit: (event) =>
        this.#emit({
          kind: "event",
          operationId: this.#running?.id ?? null,
          event
        }),
      persist: (entries) => {
        for (const group of chunkEntries(entries)) {
          this.#emit({ kind: "persist", entries: group });
        }
      },
      log: (level, text) =>
        this.#emit({
          kind: "event",
          operationId: this.#running?.id ?? null,
          event: { type: "log", level, message: text }
        })
    });
    this.#opened = { generation: message.generation, session };
    this.#pump();
  }

  #replay(after: number): void {
    const socket = this.#socket;
    if (!socket) return;
    for (const kept of this.#kept) {
      if (kept.seq > after) {
        this.#send(socket, { type: "frame", seq: kept.seq, frame: kept.frame });
      }
    }
    this.#send(socket, { type: "caught-up", lastSeq: this.#seq });
    this.#live = true;
  }

  async #prompt(
    id: string,
    input: ContainerInput,
    whenBusy: ContainerWhenBusy
  ): Promise<void> {
    if (this.#operations.has(id)) return;
    const operation: Operation = {
      id,
      input,
      whenBusy,
      state: { tag: "queued" }
    };
    this.#operations.set(id, operation);
    this.#forgetOldSettled();
    const running = this.#running;
    const steer = this.#opened?.session.steer;
    if (whenBusy === "steer" && running && steer) {
      const folded = await steer.call(this.#opened?.session, input);
      if (folded && this.#running === running) {
        operation.state = { tag: "running" };
        running.folded.push(id);
        this.#emit({ kind: "start", operationId: id });
        return;
      }
    }
    this.#queue.push(id);
    this.#pump();
  }

  #abort(id: string | undefined): void {
    const ids =
      id === undefined
        ? [...this.#operations.keys()]
        : this.#operations.has(id)
          ? [id]
          : [];
    for (const each of ids) {
      const operation = this.#operations.get(each);
      if (!operation) continue;
      if (operation.state.tag === "queued") {
        const at = this.#queue.indexOf(each);
        if (at >= 0) this.#queue.splice(at, 1);
        this.#settle(operation, { status: "unanswered", reason: "aborted" });
      } else if (operation.state.tag === "running") {
        // A steered operation shares its turn: aborting it aborts the turn.
        this.#running?.controller.abort();
      }
    }
  }

  /** Start the next queued operation, if the session is open and idle. */
  #pump(): void {
    const opened = this.#opened;
    if (this.#running || !opened) return;
    const id = this.#queue.shift();
    if (id === undefined) return;
    const operation = this.#operations.get(id);
    if (!operation || operation.state.tag !== "queued") {
      this.#pump();
      return;
    }
    const running: Running = {
      id,
      folded: [],
      controller: new AbortController()
    };
    this.#running = running;
    operation.state = { tag: "running" };
    this.#emit({ kind: "start", operationId: id });
    void this.#run(opened, operation, running);
  }

  async #run(
    opened: Opened,
    operation: Operation,
    running: Running
  ): Promise<void> {
    let outcome: ContainerOutcome;
    try {
      outcome = await opened.session.run({
        operationId: operation.id,
        input: operation.input,
        signal: running.controller.signal
      });
      if (running.controller.signal.aborted && outcome.status === "done") {
        outcome = { status: "unanswered", reason: "aborted" };
      }
    } catch (error) {
      outcome = {
        status: "unanswered",
        reason: running.controller.signal.aborted ? "aborted" : errorText(error)
      };
    }
    if (this.#running === running) this.#running = undefined;
    this.#settle(operation, outcome);
    for (const folded of running.folded) {
      const each = this.#operations.get(folded);
      if (each) this.#settle(each, outcome);
    }
    this.#pump();
  }

  #settle(operation: Operation, outcome: ContainerOutcome): void {
    if (operation.state.tag === "settled") return;
    operation.state = { tag: "settled", outcome };
    this.#emit({ kind: "settle", operationId: operation.id, outcome });
  }

  #emit(frame: DaemonFrame): void {
    this.#seq += 1;
    const seq = this.#seq;
    this.#kept.push({ seq, frame });
    if (this.#kept.length > this.#maxKeptFrames) {
      this.#kept.splice(0, this.#kept.length - this.#maxKeptFrames);
    }
    const socket = this.#socket;
    if (socket && this.#live) this.#send(socket, { type: "frame", seq, frame });
  }

  #send(socket: DaemonSocket, message: DaemonMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket closed under us. The frame is kept and replayed.
    }
  }

  #forgetOldSettled(): void {
    if (this.#operations.size <= SETTLED_KEPT) return;
    for (const [id, operation] of this.#operations) {
      if (this.#operations.size <= SETTLED_KEPT) return;
      if (operation.state.tag === "settled") this.#operations.delete(id);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A reference adapter that answers `echo: <text>` and needs no model or
 * credentials. Use it for keyless smoke deploys of the whole path and in
 * tests. It persists one entry per turn and counts them back after a
 * restore, so a resumed session visibly remembers its history:
 *
 * - `slow <ms> <text>` waits `ms` before answering, and stops on abort.
 * - `fail <reason>` settles the operation unanswered with `reason`.
 * - anything else is echoed with the turn number: `echo: hi (turn 3)`.
 *
 * @experimental The API may change before it stabilizes.
 */
export const echoAdapter: ContainerAdapter = {
  id: "echo",
  version: "1",
  capabilities: ["steer"],
  open(context) {
    let turns = context.restore.length;
    const steered: string[] = [];
    return {
      async run(turn) {
        const text = inputText(turn.input);
        const slow = /^slow (\d+) ?(.*)$/s.exec(text);
        if (slow) {
          await sleep(Number(slow[1]), turn.signal);
        }
        const failure = /^fail ?(.*)$/s.exec(text);
        if (failure) {
          return { status: "unanswered", reason: failure[1] || "failed" };
        }
        turns += 1;
        const body = slow ? (slow[2] ?? "") : text;
        const extra = steered
          .splice(0)
          .map((s) => ` + ${s}`)
          .join("");
        const answer = `echo: ${body}${extra} (turn ${turns})`;
        const messageId = `${turn.operationId}:assistant`;
        context.emit({ type: "text-delta", messageId, delta: answer });
        context.emit({
          type: "message",
          message: {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text", text: answer }],
            operationId: turn.operationId,
            createdAt: Date.now()
          }
        });
        context.persist([{ turn: turns, text: body }]);
        return { status: "done", text: answer };
      },
      steer(input) {
        steered.push(inputText(input));
        return true;
      },
      async close() {}
    };
  }
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
