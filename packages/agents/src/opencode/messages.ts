import type { OCJson, OCMessage, OCPart } from "./types";

type RawMessage = {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly time?: { readonly created?: number };
  };
  readonly parts?: ReadonlyArray<Record<string, unknown>>;
};

type ToolStatus = "pending" | "running" | "completed" | "error";

function toolStatus(state: unknown): ToolStatus {
  const status =
    typeof state === "object" && state !== null && "status" in state
      ? (state as { status?: unknown }).status
      : undefined;
  switch (status) {
    case "running":
    case "completed":
    case "error":
      return status;
    default:
      return "pending";
  }
}

function projectPart(part: Record<string, unknown>): OCPart | undefined {
  switch (part.type) {
    case "text":
      return { type: "text", text: String(part.text ?? "") };
    case "reasoning":
      return { type: "reasoning", text: String(part.text ?? "") };
    case "tool": {
      const state = part.state as Record<string, unknown> | undefined;
      return {
        type: "tool",
        id: String(part.id ?? ""),
        name: String(part.name ?? ""),
        status: toolStatus(state),
        input: (state?.input ?? null) as OCJson,
        output: typeof state?.output === "string" ? state.output : undefined,
        error: typeof state?.error === "string" ? state.error : undefined
      };
    }
    default:
      return undefined;
  }
}

function rawMessages(response: unknown): readonly RawMessage[] {
  if (Array.isArray(response)) return response as RawMessage[];
  if (
    typeof response === "object" &&
    response !== null &&
    "messages" in response &&
    Array.isArray(response.messages)
  ) {
    return response.messages as RawMessage[];
  }
  return [];
}

export function hasOpenCodeOperation(
  response: unknown,
  operationId: string
): boolean {
  const values = Array.isArray(response)
    ? response
    : typeof response === "object" && response !== null
      ? "messages" in response && Array.isArray(response.messages)
        ? response.messages
        : "data" in response && Array.isArray(response.data)
          ? response.data
          : []
      : [];
  const messageId = `msg_${operationId}`;
  return values.some((value) => {
    if (typeof value !== "object" || value === null) return false;
    if ("id" in value && value.id === messageId) return true;
    if (!("info" in value) || typeof value.info !== "object" || !value.info) {
      return false;
    }
    return "id" in value.info && value.info.id === messageId;
  });
}

export function projectMessages(response: unknown): readonly OCMessage[] {
  const messages = rawMessages(response);
  return messages
    .filter(
      (message) =>
        message.info.role === "user" || message.info.role === "assistant"
    )
    .map((message) => ({
      id: message.info.id,
      role: message.info.role as "user" | "assistant",
      parts: (message.parts ?? [])
        .map(projectPart)
        .filter((part): part is OCPart => part !== undefined),
      timestamp: message.info.time?.created ?? 0
    }));
}
