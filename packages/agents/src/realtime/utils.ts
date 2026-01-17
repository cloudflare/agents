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
  const m = msg as any;
  const p = m?.payload as any;
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
    "context_id" in p &&
    typeof p.context_id === "string" &&
    "data" in p &&
    typeof p.data === "string"
  );
}

export function isRealtimeRequest(request: Request): boolean {
  const url = new URL(request.url);
  const split = url.pathname.split("/realtime/");
  console.log(split);
  return split.length >= 2;
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
