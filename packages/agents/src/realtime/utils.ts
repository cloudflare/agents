export const REALTIME_WS_TAG = "realtime_websocket";

export type RealtimeState =
  | "idle"
  | "initializing"
  | "running"
  | "stopping"
  | "stopped";

export type RealtimeWebsocketMessage = {
  type: string;
  version: number;
  identifier: string;
  payload: {
    content_type: string;
    context_id?: string;
    data: string;
  };
};

export function isRealtimeWebsocketMessage(
  msg: unknown
): msg is RealtimeWebsocketMessage {
  const m = msg as RealtimeWebsocketMessage;
  const p = m?.payload;
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in m &&
    typeof m.type === "string" &&
    "version" in m &&
    typeof m.version === "number" &&
    "identifier" in m &&
    typeof m.identifier === "string" &&
    "payload" in m &&
    typeof m.payload === "object" &&
    m.payload !== null &&
    "content_type" in p &&
    typeof p.content_type === "string" &&
    "data" in p &&
    typeof p.data === "string" &&
    (("context_id" in p && typeof p.context_id === "string") ||
      ("context_id" in p && p.context_id === null) ||
      ("context_id" in p && p.context_id === undefined))
  );
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
