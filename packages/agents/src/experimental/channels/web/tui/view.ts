import type {
  Json,
  JsonObject,
  ToolPart,
  TranscriptMessage,
  TurnStatus
} from "../../protocol";
import type { WebChannelClientState } from "../client";

/** What this client did, which the client state does not record. */
export type Local = {
  /** Text of each message this client sent, by event id. */
  sent: ReadonlyMap<string, { messageId: string; text: string }>;
  /** Events sent and not yet acknowledged, oldest first. */
  outbox: readonly Pending[];
  /** When each turn was first seen running, in ms. */
  runningSince: ReadonlyMap<string, number>;
  notices: readonly Notice[];
};

export type Pending = {
  eventId: string;
  label: string;
  /** The tool call or turn the event answers or cancels. */
  target?: string;
};

export type Notice = {
  key: string;
  text: string;
  tone: "info" | "error";
  /** Shown after this message, or at the end. */
  after?: string;
};

export type From = { you: true } | { you: false; name?: string };

export type Block =
  | { kind: "user"; key: string; text: string; from: From }
  | { kind: "system"; key: string; text: string }
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      part: ToolPart;
      /** Set while the call's turn is open. */
      turnId?: string;
      turn?: TurnState;
      /** The turn was started by this client. */
      yours?: boolean;
      /** An answer from this client is waiting for its ack. */
      sending?: boolean;
    }
  | { kind: "attachment"; key: string; label: string }
  | { kind: "notice"; key: string; text: string; tone: Notice["tone"] };

/**
 * Text safe to print: no escape sequences or control characters an agent or
 * participant could use to drive the terminal, and tabs as spaces so widths
 * add up.
 */
export function sanitize(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      .replaceAll("\t", "    ")
      // oxlint-disable-next-line no-control-regex -- CSI sequences
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // oxlint-disable-next-line no-control-regex -- OSC sequences
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
      // oxlint-disable-next-line no-control-regex -- other C0 and C1 controls
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
  );
}

function sanitizeTool(part: ToolPart): ToolPart {
  return {
    ...part,
    toolName: sanitize(part.toolName),
    ...(part.title !== undefined && { title: sanitize(part.title) }),
    ...(part.errorText !== undefined && {
      errorText: sanitize(part.errorText)
    }),
    ...(part.approval && {
      approval: {
        ...part.approval,
        ...(part.approval.reason !== undefined && {
          reason: sanitize(part.approval.reason)
        })
      }
    })
  };
}

export function transcriptBlocks(
  state: WebChannelClientState,
  local: Local
): Block[] {
  const sentIds = new Set([...local.sent.values()].map((s) => s.messageId));
  const notices = new Map<string, Notice[]>();
  for (const n of local.notices) {
    if (n.after !== undefined) {
      notices.set(n.after, [...(notices.get(n.after) ?? []), n]);
    }
  }
  const all: Block[] = [];
  for (const message of state.messages) {
    all.push(...messageBlocks(message, state.turns, sentIds, local));
    for (const n of notices.get(message.id) ?? []) all.push(noticeBlock(n));
  }
  // A tool call shows twice while a live response and the saved message it
  // becomes overlap; keep the later, live one.
  const lastAt = new Map(all.map((b, i) => [b.key, i]));
  const blocks = all.filter((b, i) => lastAt.get(b.key) === i);
  const known = new Set(state.messages.map((m) => m.id));
  for (const n of local.notices) {
    if (n.after === undefined || !known.has(n.after)) {
      blocks.push(noticeBlock(n));
    }
  }
  return blocks;
}

function noticeBlock(notice: Notice): Block {
  return { kind: "notice", ...notice, text: sanitize(notice.text) };
}

function messageBlocks(
  message: TranscriptMessage,
  turns: readonly TurnStatus[],
  sentIds: ReadonlySet<string>,
  local: Local
): Block[] {
  const key = (i: number) => `${message.id}:${i}`;
  if (message.role !== "assistant") {
    const text = sanitize(
      message.parts
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("\n")
    );
    const head: Block =
      message.role === "system"
        ? { kind: "system", key: message.id, text }
        : {
            kind: "user",
            key: message.id,
            text,
            from: sentIds.has(message.id)
              ? { you: true }
              : { you: false, ...nameOf(message.metadata) }
          };
    return [head, ...attachments(message)];
  }

  const turn = turnOf(message.id, turns);
  const streaming = turn?.status === "running";
  const last = message.parts.length - 1;
  return message.parts.flatMap((part, i): Block[] => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return [
          {
            kind: part.type,
            key: key(i),
            text: sanitize(part.text),
            streaming: streaming && i === last
          }
        ];
      case "tool":
        return [
          {
            kind: "tool",
            key: `tool:${part.toolCallId}`,
            part: sanitizeTool(part),
            ...(turn && {
              turnId: turn.turnId,
              turn: turn.status === "running" ? "running" : "awaiting",
              yours: local.sent.has(turn.startedBy)
            }),
            ...(local.outbox.some((p) => p.target === part.toolCallId) && {
              sending: true
            })
          }
        ];
      default: {
        const label = attachmentLabel(part);
        return label
          ? [{ kind: "attachment", key: key(i), label: sanitize(label) }]
          : [];
      }
    }
  });
}

function attachments(message: TranscriptMessage): Block[] {
  return message.parts.flatMap((part, i): Block[] => {
    const label = attachmentLabel(part);
    return label
      ? [
          {
            kind: "attachment",
            key: `${message.id}:${i}`,
            label: sanitize(label)
          }
        ]
      : [];
  });
}

function attachmentLabel(part: TranscriptMessage["parts"][number]) {
  switch (part.type) {
    case "file":
      return `file ${part.filename ?? part.mediaType}`;
    case "source-url":
      return `source ${part.title ?? part.url}`;
    case "source-document":
      return `source ${part.title}`;
    case "data":
      return `data ${part.name}`;
    default:
      return undefined;
  }
}

/** The open turn showing or extending this message. */
export function turnOf(
  messageId: string,
  turns: readonly TurnStatus[]
): TurnStatus | undefined {
  return turns.find((turn) =>
    turn.status === "running"
      ? turn.responseId === messageId || turn.extends === messageId
      : turn.status === "settled" && turn.messageIds.includes(messageId)
  );
}

/**
 * A sender name from message metadata, if the agent put one there. There is
 * no sender field on transcript messages.
 */
export function nameOf(metadata: JsonObject | undefined): { name?: string } {
  for (const field of ["sender", "participant", "author", "user"]) {
    const value = metadata?.[field];
    if (typeof value === "string" && value) return { name: sanitize(value) };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { name, id } = value as JsonObject;
      if (typeof name === "string" && name) return { name: sanitize(name) };
      if (typeof id === "string" && id) return { name: sanitize(id) };
    }
  }
  return {};
}

export type Status = {
  connected: boolean;
  /** Ever connected; before that the client is connecting, after reconnecting. */
  seen: boolean;
  you?: string;
  running?: {
    turnId: string;
    yours: boolean;
    seconds?: number;
    cancelling?: boolean;
  };
  queued: { turnId: string; label: string; yours: boolean }[];
  awaiting: number;
  sending: readonly Pending[];
};

export function status(
  state: WebChannelClientState,
  local: Local,
  now: number,
  seen: boolean
): Status {
  const yours = (turn: TurnStatus) => local.sent.has(turn.startedBy);
  const running = state.turns.find((t) => t.status === "running");
  const since = running && local.runningSince.get(running.turnId);
  return {
    connected: state.connected,
    seen,
    ...(state.you && { you: sanitize(state.you.name ?? state.you.id) }),
    ...(running && {
      running: {
        turnId: running.turnId,
        yours: yours(running),
        ...(local.outbox.some((p) => p.target === running.turnId) && {
          cancelling: true
        }),
        ...(since !== undefined && {
          seconds: Math.max(0, Math.floor((now - since) / 1000))
        })
      }
    }),
    queued: state.turns
      .filter((t) => t.status === "queued")
      .map((t) => ({
        turnId: t.turnId,
        label: sanitize(local.sent.get(t.startedBy)?.text ?? ""),
        yours: yours(t)
      })),
    awaiting: state.turns.filter((t) => t.status === "settled").length,
    sending: local.outbox.map((p) => ({ ...p, label: sanitize(p.label) }))
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Collapsing and selection, owned by the participant at this terminal. */
export type Ui = {
  toolsExpanded: boolean;
  reasoningExpanded: boolean;
  /** Blocks flipped from their kind's default. */
  toggled: ReadonlySet<string>;
  selected?: string;
};

export const initialUi: Ui = {
  toolsExpanded: true,
  reasoningExpanded: false,
  toggled: new Set()
};

type Collapsible = Extract<Block, { kind: "tool" | "reasoning" }>;

export function isCollapsible(block: Block): block is Collapsible {
  return block.kind === "tool" || block.kind === "reasoning";
}

export function isExpanded(block: Collapsible, ui: Ui): boolean {
  const byDefault =
    block.kind === "tool" ? ui.toolsExpanded : ui.reasoningExpanded;
  return ui.toggled.has(block.key) ? !byDefault : byDefault;
}

export function toggleBlock(ui: Ui, key: string): Ui {
  const toggled = new Set(ui.toggled);
  if (!toggled.delete(key)) toggled.add(key);
  return { ...ui, toggled };
}

/** Flips a kind's default and drops that kind's per-block toggles. */
export function toggleAll(
  ui: Ui,
  kind: Collapsible["kind"],
  blocks: readonly Block[]
): Ui {
  const ofKind = new Set(
    blocks.filter((b) => b.kind === kind).map((b) => b.key)
  );
  return {
    ...ui,
    ...(kind === "tool"
      ? { toolsExpanded: !ui.toolsExpanded }
      : { reasoningExpanded: !ui.reasoningExpanded }),
    toggled: new Set([...ui.toggled].filter((key) => !ofKind.has(key)))
  };
}

/**
 * Moves the selection through collapsible blocks. Up from the composer picks
 * the last one; down past the last returns to the composer (undefined).
 */
export function moveSelection(
  blocks: readonly Block[],
  selected: string | undefined,
  direction: "up" | "down"
): string | undefined {
  const keys = blocks.filter(isCollapsible).map((b) => b.key);
  const at = selected === undefined ? -1 : keys.indexOf(selected);
  if (at === -1) return direction === "up" ? keys.at(-1) : undefined;
  if (direction === "up") return keys[Math.max(0, at - 1)];
  return keys[at + 1];
}

export type ToolPhase =
  | "preparing"
  | "running"
  | "approval"
  | "client"
  | "done"
  | "error"
  | "denied"
  | "stopped";

/** An open turn: running, or settled awaiting input (queued counts too). */
export type TurnState = "running" | "awaiting";

/**
 * Where a tool call stands. Approvals and client results are only offered
 * once the turn awaits input, which is when an agent can take them.
 */
export function toolPhase(part: ToolPart, turn?: TurnState): ToolPhase {
  switch (part.state) {
    case "input-streaming":
      return turn === "running" ? "preparing" : "stopped";
    case "input-available":
      if (part.owner !== undefined && !part.providerExecuted) {
        return turn === "awaiting" ? "client" : turn ? "preparing" : "stopped";
      }
      return turn ? "running" : "stopped";
    case "approval-requested":
      return turn === "awaiting" ? "approval" : turn ? "preparing" : "stopped";
    case "approval-responded":
      if (part.approval?.approved === false) return "denied";
      return turn ? "running" : "stopped";
    case "output-available":
      return part.preliminary && turn ? "running" : "done";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
  }
}

/** Tool calls waiting on the participant at this terminal. */
export function prompts(
  blocks: readonly Block[],
  you: string | undefined
): Extract<Block, { kind: "tool" }>[] {
  return blocks.filter(
    (b): b is Extract<Block, { kind: "tool" }> =>
      b.kind === "tool" && !b.sending && needsYou(b, you)
  );
}

export function needsYou(
  block: Extract<Block, { kind: "tool" }>,
  you: string | undefined
): boolean {
  const phase = toolPhase(block.part, block.turn);
  return (
    phase === "approval" ||
    (phase === "client" && you !== undefined && block.part.owner === you)
  );
}

/** A typed client tool result: JSON when it parses, else the text. */
export function parseOutput(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}
