import type { OpenCodeJson, OpenCodeMessage, OpenCodePart } from "./types";

export type SettledResult = {
  readonly operationId: string;
  readonly status: "completed" | "aborted" | "failed" | "declined";
  readonly messageId?: string;
  readonly error?: { readonly code: string; readonly message: string };
};

export type RawMessage = {
  readonly id: string;
  readonly type: string;
  readonly time?: { readonly created?: number; readonly completed?: number };
  readonly text?: string;
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly error?: { readonly type?: string; readonly message?: string };
};

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

export function hasOpenCodeOperation(
  response: unknown,
  operationId: string
): boolean {
  const id = messageIdOf(operationId);
  return rawMessages(response).some((message) => message.id === id);
}

export function messageIdOf(operationId: string): string {
  return `msg_${operationId}`;
}

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

export function messageText(
  messages: readonly OpenCodeMessage[],
  messageId: string | undefined
): string {
  const message = messages.find((candidate) => candidate.id === messageId);
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
