import type { UIMessageChunk } from "../../src";

export function textDelta(text: string): UIMessageChunk {
  return { type: "text-delta", id: "rethink-tracer", delta: text };
}
