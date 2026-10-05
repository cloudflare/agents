import type { OpenCodeJson, OpenCodeMessage, OpenCodePart } from "./types";

/** How OpenCode's messages say one operation ended. */
export type SettledResult = {
  readonly operationId: string;
  readonly status: "completed" | "aborted" | "failed" | "declined";
  readonly messageId?: string;
  readonly error?: { readonly code: string; readonly message: string };
};

/**
 * One OpenCode session message, as `message.list` returns it: a tagged
 * union on `type`. Only the fields the harness reads are named here.
 */
export type RawMessage = {
  readonly id: string;
  readonly type: string;
  readonly time?: { readonly created?: number; readonly completed?: number };
  /** A user message's prompt. */
  readonly text?: string;
  /** An assistant message's parts. */
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  /** Set when an assistant message ended in a provider or runtime error. */
  readonly error?: { readonly type?: string; readonly message?: string };
};

/** The messages in a `message.list` response, oldest first as listed. */
export function rawMessages(response: unknown): readonly RawMessage[] {
  if (Array.isArray(response)) return response as RawMessage[];
  if (
    typeof response === "object" &&
    response !== null &&
    "data" in response &&
    Array.isArray(response.data)
  ) {
    return response.data as RawMessage[];
  }
  return [];
}

type ToolStatus = "pending" | "running" | "completed" | "error";

function toolStatus(status: unknown): ToolStatus {
  switch (status) {
    case "running":
    case "completed":
    case "error":
      return status;
    default:
      return "pending";
  }
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part.type === "text" && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

function projectPart(part: Record<string, unknown>): OpenCodePart | undefined {
  switch (part.type) {
    case "text":
      return { type: "text", text: String(part.text ?? "") };
    case "reasoning":
      return { type: "reasoning", text: String(part.text ?? "") };
    case "tool": {
      const state = (part.state ?? {}) as Record<string, unknown>;
      const error = state.error as { message?: unknown } | undefined;
      return {
        type: "tool",
        id: String(part.id ?? ""),
        name: String(part.name ?? ""),
        status: toolStatus(state.status),
        input: (state.input ?? null) as OpenCodeJson,
        output: contentText(state.content),
        error: typeof error?.message === "string" ? error.message : undefined
      };
    }
    default:
      return undefined;
  }
}

/** The transcript: user prompts and assistant replies, for display. */
export function projectMessages(response: unknown): readonly OpenCodeMessage[] {
  const messages: OpenCodeMessage[] = [];
  for (const message of rawMessages(response)) {
    const timestamp = message.time?.created ?? 0;
    if (message.type === "user") {
      messages.push({
        id: message.id,
        role: "user",
        parts: [{ type: "text", text: message.text ?? "" }],
        timestamp
      });
    } else if (message.type === "assistant") {
      messages.push({
        id: message.id,
        role: "assistant",
        parts: (message.content ?? [])
          .map(projectPart)
          .filter((part): part is OpenCodePart => part !== undefined),
        timestamp
      });
    }
  }
  return messages;
}

/** True when the response holds this operation's prompt. */
export function hasOpenCodeOperation(
  response: unknown,
  operationId: string
): boolean {
  const id = messageIdOf(operationId);
  return rawMessages(response).some((message) => message.id === id);
}

/** The operation's message id in OpenCode. Admission uses the same id. */
export function messageIdOf(operationId: string): string {
  return `msg_${operationId}`;
}

/**
 * Where one operation stands in a session's messages.
 *
 * `"absent"` means OpenCode has never seen it: not in the messages at all.
 * `"active"` means its prompt is there but the reply has not completed.
 * A `result` means the reply completed, and the operation can settle.
 *
 * The reply is the last assistant message between the operation's own user
 * message and the next user message — the boundary that separates one
 * turn's answer from the next prompt's. A turn with tool calls writes one
 * assistant message per step, so the last one holds the answer. With queued
 * follow-ups several of our prompts can sit in the messages at once, so the
 * boundary is what keeps each operation reading only its own reply.
 */
export function inspectOperation(
  response: unknown,
  operationId: string
): "absent" | "active" | { readonly result: SettledResult } {
  const messages = rawMessages(response);
  const index = messages.findIndex(
    (message) => message.id === messageIdOf(operationId)
  );
  if (index < 0) return "absent";
  const nextUser = messages.findIndex(
    (message, messageIndex) => messageIndex > index && message.type === "user"
  );
  const boundary = nextUser < 0 ? messages.length : nextUser;
  const replies = messages
    .slice(index + 1, boundary)
    .filter((message) => message.type === "assistant");
  const reply = replies.at(-1);
  if (!reply?.time?.completed) return "active";
  // A step that called tools completes before the next step starts.
  if (
    nextUser < 0 &&
    reply.content?.some(
      (part) =>
        part.type === "tool" &&
        (part.state as { status?: unknown } | undefined)?.status !==
          "completed" &&
        (part.state as { status?: unknown } | undefined)?.status !== "error"
    )
  ) {
    return "active";
  }
  const error = reply.error;
  return {
    result: {
      operationId,
      status: error ? "failed" : "completed",
      messageId: reply.id,
      error: error
        ? {
            code: error.type ?? "error",
            message: error.message ?? "OpenCode execution failed"
          }
        : undefined
    }
  };
}

type InboxRow = {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly payload?: { readonly text?: unknown };
  readonly time?: { readonly created?: unknown };
  readonly created?: unknown;
};

function inboxRows(response: unknown): readonly InboxRow[] {
  if (Array.isArray(response)) return response as InboxRow[];
  if (typeof response === "object" && response !== null) {
    for (const key of ["data", "items", "messages"] as const) {
      const value = (response as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as InboxRow[];
    }
  }
  return [];
}

/**
 * Our queued prompts in a session's inbox, oldest first.
 *
 * Only `msg_*` user items are ours. Steering text gets a random id, so an
 * `inboxID` with no matching operation is somebody else's and is skipped.
 * `text` comes back because re-sending a prompt needs it: the schema
 * requires `text`, even when the id already exists.
 */
export function inboxOperations(response: unknown): ReadonlyArray<{
  readonly operationId: string;
  readonly inboxId: string;
  readonly text: string;
  readonly submittedAt: number;
}> {
  const rows: Array<{
    operationId: string;
    inboxId: string;
    text: string;
    submittedAt: number;
  }> = [];
  for (const row of inboxRows(response)) {
    const id = typeof row.id === "string" ? row.id : undefined;
    if (!id?.startsWith("msg_")) continue;
    if (row.type !== undefined && row.type !== "user") continue;
    const created =
      typeof row.time?.created === "number"
        ? row.time.created
        : typeof row.created === "number"
          ? row.created
          : 0;
    rows.push({
      operationId: id.slice("msg_".length),
      inboxId: id,
      text: typeof row.payload?.text === "string" ? row.payload.text : "",
      submittedAt: created
    });
  }
  return rows.sort((left, right) => left.submittedAt - right.submittedAt);
}

/** The text of one projected message, for an operation's result. */
export function messageText(
  messages: readonly OpenCodeMessage[],
  messageId: string | undefined
): string {
  const message = messages.find((candidate) => candidate.id === messageId);
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
