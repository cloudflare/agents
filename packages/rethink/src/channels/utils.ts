import type { UIMessageChunk } from "ai";

export function textFromChunk(chunk: UIMessageChunk): string {
  if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
    return chunk.delta;
  }
  return "";
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
