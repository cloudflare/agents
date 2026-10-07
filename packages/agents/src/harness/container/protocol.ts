/**
 * The wire between `ContainerHarness` (in a Durable Object) and the harness
 * daemon (in the container). Isomorphic and dependency-free: the daemon
 * imports it in Node, the harness in Workers.
 *
 * One WebSocket per session, dialled by the object through
 * `ctx.container.getTcpPort(port)` at `/sessions/<id>`. The daemon speaks
 * first with `hello`; the object answers with `open` (when the daemon does
 * not hold the session yet) and `replay`, then delivers `prompt`s.
 *
 * Everything the daemon produces for a session is a numbered `frame`. The
 * numbers start at 1 for each session in each container, so a frame is
 * addressed by `(runtimeId, seq)`. The daemon keeps frames until they are
 * acknowledged, so an object that lost its socket (evicted, redeployed)
 * replays what it missed from its cursor. A different `runtimeId` in
 * `hello` means a different container: its numbering starts again, and
 * whatever the old container was doing is gone.
 *
 * @experimental The wire may change before it stabilizes. The object and the image are
 * a matched pair; a version mismatch is reported in `hello`.
 */

/** Bumped on any incompatible change. */
export const CONTAINER_PROTOCOL_VERSION = 1;

/** The daemon answers `200` here once it accepts connections. */
export const CONTAINER_HEALTH_PATH = "/healthz";

/** The session socket: `/sessions/<encoded session id>`. */
export const CONTAINER_SESSION_PATH = "/sessions/";

/** The shared secret the object passes on every request. */
export const CONTAINER_TOKEN_HEADER = "x-cf-harness-token";

/** The environment variables the object starts the container with. */
export const CONTAINER_ENV = {
  /** Shared secret for `CONTAINER_TOKEN_HEADER`. */
  token: "CF_HARNESS_TOKEN",
  /** This container's id. Echoed in `hello`. */
  runtimeId: "CF_HARNESS_RUNTIME_ID",
  /** The port the daemon listens on. */
  port: "CF_HARNESS_PORT"
} as const;

/** WebSocket close code: a newer connection for the session replaced this one. */
export const CLOSE_REPLACED = 4001;

/** WebSocket close code: the request was not authorized. */
export const CLOSE_UNAUTHORIZED = 4003;

/** A JSON value on the wire. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** One part of a prompt. */
export type ContainerInputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      /** IANA media type, such as `image/png`. */
      readonly mediaType: string;
      /** Base64 bytes. */
      readonly data: string;
    };

/** What a prompt carries: plain text, or parts. */
export type ContainerInput = string | readonly ContainerInputPart[];

/** What a submission does when the session is already running. */
export type ContainerWhenBusy = "followUp" | "steer";

/**
 * Per-session settings the object sends the adapter. `model` is the
 * adapter's own model name; `options` is opaque to everything but the
 * adapter.
 */
export type ContainerSettings = {
  readonly model?: string;
  readonly options?: JsonValue;
};

/** One part of a transcript message. */
export type ContainerPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "image";
      readonly mediaType: string;
      readonly data: string;
    }
  | {
      readonly type: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
      readonly state: "running" | "done" | "error";
      readonly output?: JsonValue;
    };

/**
 * A transcript message, in the one format every container adapter
 * produces. An adapter emits a message again, under the same id, to update
 * it (a tool result arriving, for example).
 */
export type ContainerMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly ContainerPart[];
  /** The operation the message belongs to. */
  readonly operationId?: string;
  readonly createdAt: number;
};

/** What an adapter reports while it runs. */
export type ContainerEvent =
  /** Live text for an assistant message that is still being written. */
  | {
      readonly type: "text-delta";
      readonly messageId: string;
      readonly delta: string;
    }
  /** Live reasoning for an assistant message that is still being written. */
  | {
      readonly type: "reasoning-delta";
      readonly messageId: string;
      readonly delta: string;
    }
  /** A finished or updated transcript message. Stored. */
  | { readonly type: "message"; readonly message: ContainerMessage }
  /** Token and cost figures the adapter reports, as the adapter counts them. */
  | {
      readonly type: "usage";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
    }
  /** A diagnostic line. */
  | {
      readonly type: "log";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    }
  /** Anything adapter-specific, passed through untouched. */
  | { readonly type: "raw"; readonly value: JsonValue };

/** How an operation ended, as the daemon reports it. */
export type ContainerOutcome =
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "unanswered"; readonly reason: string };

/** What the daemon knows about one operation it was given. */
export type DaemonOperation =
  | {
      readonly operationId: string;
      readonly status: "queued" | "running";
    }
  | {
      readonly operationId: string;
      readonly status: "settled";
      readonly outcome: ContainerOutcome;
    };

/** One numbered thing the daemon produced for a session. */
export type DaemonFrame =
  | { readonly kind: "start"; readonly operationId: string }
  | {
      readonly kind: "event";
      readonly operationId: string | null;
      readonly event: ContainerEvent;
    }
  /**
   * Adapter resume state to keep. The object stores these entries in order
   * and hands all of them back in `open` on a new container.
   */
  | { readonly kind: "persist"; readonly entries: readonly JsonValue[] }
  | {
      readonly kind: "settle";
      readonly operationId: string;
      readonly outcome: ContainerOutcome;
    };

/** The adapter running in the container. */
export type AdapterInfo = {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
};

/** Daemon → object. */
export type DaemonMessage =
  | {
      readonly type: "hello";
      readonly protocol: number;
      readonly runtimeId: string;
      readonly session: string;
      readonly adapter: AdapterInfo;
      /** The generation of the open adapter session, or null if none is open. */
      readonly open: number | null;
      /** The newest frame number for this session in this container. */
      readonly lastSeq: number;
      /** Every operation this container was given for the session. */
      readonly operations: readonly DaemonOperation[];
    }
  | {
      readonly type: "frame";
      readonly seq: number;
      readonly frame: DaemonFrame;
    }
  /** Every kept frame after the `replay` cursor has been sent. */
  | { readonly type: "caught-up"; readonly lastSeq: number }
  | { readonly type: "error"; readonly message: string };

/**
 * Most JSON characters the object puts in one `restore` message, and the
 * daemon in one `persist` frame (a single larger entry travels alone).
 * Keeps every message well inside WebSocket message limits.
 */
export const MAX_CHUNK_CHARS = 256 * 1024;

/** Object → daemon. */
export type HostMessage =
  /**
   * Part of the resume state for the next `open` of `generation`. Sent
   * before that `open`, in order, so no single message grows with the
   * session's history.
   */
  | {
      readonly type: "restore";
      readonly generation: number;
      readonly entries: readonly JsonValue[];
    }
  /**
   * Open the adapter session. Ignored when the same generation is already
   * open; a different generation closes the open one first.
   */
  | {
      readonly type: "open";
      readonly generation: number;
      readonly settings: ContainerSettings;
      /**
       * The last of the entries the adapter persisted for this session,
       * after any sent in `restore` messages for this generation.
       */
      readonly restore: readonly JsonValue[];
    }
  /** Send every kept frame after `after`, then live frames. */
  | { readonly type: "replay"; readonly after: number }
  /** Queue an operation. Idempotent on `operationId`. */
  | {
      readonly type: "prompt";
      readonly operationId: string;
      readonly input: ContainerInput;
      readonly whenBusy: ContainerWhenBusy;
    }
  /** Stop one operation, or every operation of the session. */
  | { readonly type: "abort"; readonly operationId?: string }
  | { readonly type: "configure"; readonly settings: ContainerSettings }
  /** Frames up to `seq` are stored; the daemon may forget them. */
  | { readonly type: "ack"; readonly seq: number };

// ── Parsing ─────────────────────────────────────────────────────────────────
//
// Frames cross a process boundary, so each side parses what it receives.
// The parsers check the envelope and the fields the receiver acts on;
// payloads that are opaque to the receiver (events, persisted entries) are
// passed through as JSON.

type Fields = { readonly [key: string]: unknown };

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJson);
      return Object.values(value).every(isJson);
    default:
      return false;
  }
}

function isOutcome(value: unknown): value is ContainerOutcome {
  if (!isFields(value)) return false;
  if (value.status === "done") return isString(value.text);
  return value.status === "unanswered" && isString(value.reason);
}

function isEvent(value: unknown): value is ContainerEvent {
  if (!isFields(value) || !isString(value.type) || !isJson(value)) return false;
  switch (value.type) {
    case "text-delta":
    case "reasoning-delta":
      return isString(value.messageId) && isString(value.delta);
    case "message":
      return (
        isFields(value.message) &&
        isString(value.message.id) &&
        (value.message.role === "user" || value.message.role === "assistant") &&
        Array.isArray(value.message.parts)
      );
    case "usage":
      return true;
    case "log":
      return isString(value.message);
    case "raw":
      return "value" in value;
    default:
      return false;
  }
}

function isFrame(value: unknown): value is DaemonFrame {
  if (!isFields(value)) return false;
  switch (value.kind) {
    case "start":
      return isString(value.operationId);
    case "event":
      return (
        (value.operationId === null || isString(value.operationId)) &&
        isEvent(value.event)
      );
    case "persist":
      return Array.isArray(value.entries) && value.entries.every(isJson);
    case "settle":
      return isString(value.operationId) && isOutcome(value.outcome);
    default:
      return false;
  }
}

function isDaemonOperation(value: unknown): value is DaemonOperation {
  if (!isFields(value) || !isString(value.operationId)) return false;
  if (value.status === "queued" || value.status === "running") return true;
  return value.status === "settled" && isOutcome(value.outcome);
}

function isInput(value: unknown): value is ContainerInput {
  if (isString(value)) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        isFields(part) &&
        ((part.type === "text" && isString(part.text)) ||
          (part.type === "image" &&
            isString(part.mediaType) &&
            isString(part.data)))
    )
  );
}

function isSettings(value: unknown): value is ContainerSettings {
  return (
    isFields(value) &&
    (value.model === undefined || isString(value.model)) &&
    (value.options === undefined || isJson(value.options))
  );
}

function decode(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse one message from the daemon.
 *
 * @param text - The raw WebSocket message.
 * @returns The message, or `undefined` when it is not one.
 */
export function parseDaemonMessage(text: string): DaemonMessage | undefined {
  const value = decode(text);
  if (!isFields(value)) return undefined;
  switch (value.type) {
    case "hello":
      if (
        isCount(value.protocol) &&
        isString(value.runtimeId) &&
        isString(value.session) &&
        isFields(value.adapter) &&
        isString(value.adapter.id) &&
        isString(value.adapter.version) &&
        Array.isArray(value.adapter.capabilities) &&
        value.adapter.capabilities.every(isString) &&
        (value.open === null || isCount(value.open)) &&
        isCount(value.lastSeq) &&
        Array.isArray(value.operations) &&
        value.operations.every(isDaemonOperation)
      ) {
        // SAFETY: every field the type names was checked above.
        return value as DaemonMessage;
      }
      return undefined;
    case "frame":
      // SAFETY: seq and frame were checked; the type is exactly these fields.
      return isCount(value.seq) && isFrame(value.frame)
        ? (value as DaemonMessage)
        : undefined;
    case "caught-up":
      return isCount(value.lastSeq)
        ? { type: "caught-up", lastSeq: value.lastSeq }
        : undefined;
    case "error":
      return isString(value.message)
        ? { type: "error", message: value.message }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Parse one message from the object.
 *
 * @param text - The raw WebSocket message.
 * @returns The message, or `undefined` when it is not one.
 */
export function parseHostMessage(text: string): HostMessage | undefined {
  const value = decode(text);
  if (!isFields(value)) return undefined;
  switch (value.type) {
    case "restore":
      return isCount(value.generation) &&
        Array.isArray(value.entries) &&
        value.entries.every(isJson)
        ? {
            type: "restore",
            generation: value.generation,
            entries: value.entries
          }
        : undefined;
    case "open":
      return isCount(value.generation) &&
        isSettings(value.settings) &&
        Array.isArray(value.restore) &&
        value.restore.every(isJson)
        ? {
            type: "open",
            generation: value.generation,
            settings: value.settings,
            restore: value.restore
          }
        : undefined;
    case "replay":
      return isCount(value.after)
        ? { type: "replay", after: value.after }
        : undefined;
    case "prompt":
      return isString(value.operationId) &&
        isInput(value.input) &&
        (value.whenBusy === "followUp" || value.whenBusy === "steer")
        ? {
            type: "prompt",
            operationId: value.operationId,
            input: value.input,
            whenBusy: value.whenBusy
          }
        : undefined;
    case "abort":
      if (value.operationId === undefined) return { type: "abort" };
      return isString(value.operationId)
        ? { type: "abort", operationId: value.operationId }
        : undefined;
    case "configure":
      return isSettings(value.settings)
        ? { type: "configure", settings: value.settings }
        : undefined;
    case "ack":
      return isCount(value.seq) ? { type: "ack", seq: value.seq } : undefined;
    default:
      return undefined;
  }
}

/**
 * The text of an input, with image parts left out.
 *
 * @param input - A prompt's input.
 * @returns Its text.
 */
export function inputText(input: ContainerInput): string {
  if (typeof input === "string") return input;
  return input
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

/**
 * Split entries into groups whose JSON stays under `MAX_CHUNK_CHARS`. An
 * entry larger than that is a group of its own.
 *
 * @param entries - The entries, in order.
 * @returns The groups, in order. Empty for no entries.
 */
export function chunkEntries(entries: readonly JsonValue[]): JsonValue[][] {
  const groups: JsonValue[][] = [];
  let group: JsonValue[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = JSON.stringify(entry).length;
    if (group.length > 0 && size + length > MAX_CHUNK_CHARS) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(entry);
    size += length;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}
