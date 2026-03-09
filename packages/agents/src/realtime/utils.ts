export const REALTIME_WS_TAG = "realtime_websocket";

export type RealtimeState =
  | "idle"
  | "initializing"
  | "running"
  | "stopping"
  | "stopped";

type RealtimeMessage<TType extends "media" | "event", TPayload> = {
  type: TType;
  version: number;
  identifier: string;
  payload: TPayload;
};

export type RealtimeMediaPayload = {
  content_type: string;
  context_id?: string | null;
  data: string;
  peer_id?: string | null;
};

type RealtimeEventPayloadBase = {
  source: string;
  timestamp?: number;
};

type RealtimeEventPayloadType =
  | {
      event_type: "error";
      message: string;
    }
  | {
      event_type: "warning";
      message: string;
    }
  | {
      event_type: "info";
      message: string;
    }
  | {
      event_type: "custom";
      kind: string;
      data?: unknown;
    };

export type RealtimeMediaMessage = RealtimeMessage<
  "media",
  RealtimeMediaPayload
>;

export type RealtimeRuntimeEventPayload = RealtimeEventPayloadBase &
  RealtimeEventPayloadType;

export type RealtimeRuntimeEventMessage = RealtimeMessage<
  "event",
  RealtimeRuntimeEventPayload
>;

/**
 * Classify a parsed WebSocket message as a realtime media message,
 * a realtime runtime event message, or neither.
 *
 * Returns `"media"` for media frames, `"event"` for runtime event
 * frames, or `null` if the message is not a recognised realtime message.
 */
export function classifyRealtimeMessage(
  msg: unknown
): "media" | "event" | null {
  if (typeof msg !== "object" || msg === null) {
    return null;
  }

  const m = msg as Record<string, unknown>;
  if (
    typeof m.type !== "string" ||
    typeof m.version !== "number" ||
    typeof m.identifier !== "string" ||
    typeof m.payload !== "object" ||
    m.payload === null
  ) {
    return null;
  }

  if (m.type === "event") {
    const p = m.payload as Record<string, unknown>;
    if (typeof p.source !== "string") return null;
    if (
      "timestamp" in p &&
      p.timestamp !== undefined &&
      typeof p.timestamp !== "number"
    ) {
      return null;
    }
    if (typeof p.event_type !== "string") return null;

    switch (p.event_type) {
      case "error":
      case "warning":
      case "info":
        return typeof p.message === "string" ? "event" : null;
      case "custom":
        return typeof p.kind === "string" ? "event" : null;
      default:
        return null;
    }
  }

  if (m.type !== "media") {
    return null;
  }

  // Media message validation
  const p = m.payload as Record<string, unknown>;
  if (typeof p.content_type !== "string" || typeof p.data !== "string") {
    return null;
  }
  if (
    "context_id" in p &&
    p.context_id !== undefined &&
    p.context_id !== null &&
    typeof p.context_id !== "string"
  ) {
    return null;
  }
  if (
    "peer_id" in p &&
    p.peer_id !== undefined &&
    p.peer_id !== null &&
    typeof p.peer_id !== "string"
  ) {
    return null;
  }

  return "media";
}

/**
 * Type guard for realtime media websocket messages.
 */
export function isRealtimeMediaMessage(
  msg: unknown
): msg is RealtimeMediaMessage {
  return classifyRealtimeMessage(msg) === "media";
}

/**
 * Type guard for realtime runtime event websocket messages.
 */
export function isRealtimeRuntimeEventMessage(
  msg: unknown
): msg is RealtimeRuntimeEventMessage {
  return classifyRealtimeMessage(msg) === "event";
}

export function isRealtimeRequest(request: Request): boolean {
  const url = new URL(request.url);
  const split = url.pathname.split("/realtime/");
  return split.length >= 2;
}

export type SpeakResponseText =
  | string
  | ReadableStream<Uint8Array>
  | (AsyncIterable<string> & ReadableStream<string>);

export async function* resolveTextStream(
  text: SpeakResponseText
): AsyncGenerator<string> {
  if (typeof text === "string") {
    if (text) yield text;
    return;
  }

  if (text instanceof ReadableStream) {
    const reader = (text as ReadableStream<string | Uint8Array>).getReader();
    const first = await reader.read();
    if (first.done || first.value === undefined) return;

    if (typeof first.value === "string") {
      if (first.value) yield first.value;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (typeof value === "string" && value) yield value;
      }
    } else {
      const peeked = first.value as Uint8Array;
      const combined = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(peeked);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value as Uint8Array);
          }
          controller.close();
        }
      });
      for await (const chunk of processNDJSONStream(combined.getReader())) {
        if (chunk.response) {
          yield chunk.response;
        } else if (chunk.choices && chunk.choices.length > 0) {
          const choice = chunk.choices[0];
          if (choice.delta?.content && choice.delta?.role === "assistant") {
            yield choice.delta.content;
          }
        }
      }
    }
    return;
  }

  if (Symbol.asyncIterator in text) {
    for await (const chunk of text as AsyncIterable<string>) {
      if (typeof chunk === "string" && chunk) yield chunk;
    }
  }
}

export async function* processNDJSONStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  leftOverBuffer = ""
) {
  const decoder = new TextDecoder();
  let buffer = leftOverBuffer;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        if (line.startsWith("data: ")) {
          const jsonLine = line.slice(6).trim();
          if (jsonLine === "[DONE]") {
            return;
          }
          yield JSON.parse(jsonLine);
        }
      }
    }
  }

  if (buffer.trim()) {
    const lines = buffer.split("\n").filter((line) => line.trim());
    if (lines.length > 1) {
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonLine = line.slice(6).trim();
          if (jsonLine === "[DONE]") {
            return;
          }
          yield JSON.parse(jsonLine);
        }
      }
    } else if (buffer.startsWith("data: ")) {
      const jsonLine = buffer.slice(6).trim();
      if (jsonLine === "[DONE]") {
        return;
      }
      yield JSON.parse(jsonLine);
    }
  }
}
