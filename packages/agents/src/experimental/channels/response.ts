import type { StreamJson, StreamWriter } from "../../streams";
import type { ResponseChunk } from "./protocol";

/** A chunk that breaks the response grammar. Nothing was recorded. */
export class ResponseGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseGrammarError";
  }
}

/** Producer handle for one response. */
export type ResponseWriter = {
  readonly id: string;
  /** Records the chunk and wakes readers. Throws if it cannot be recorded. */
  append(chunk: ResponseChunk): void;
  end(): void;
  /**
   * Append every chunk, then end the response. If the source or an append
   * fails, settles the response as interrupted and rejects.
   */
  pipe(chunks: AsyncIterable<ResponseChunk>): Promise<void>;
};

export function responseWriter(writer: StreamWriter): ResponseWriter {
  // Open parts, keyed by kind and id. Text and reasoning ids are separate.
  const open = new Set<string>();

  // Checks the chunk and returns the change it makes to the open parts,
  // applied only once the chunk is recorded.
  function check(chunk: ResponseChunk): (() => void) | undefined {
    const [kind, id, step] = partOf(chunk);
    if (!kind) return undefined;
    const key = `${kind}:${id}`;
    if (step === "start") {
      if (open.has(key)) fail(`${kind} "${id}" is already open`);
      return () => open.add(key);
    }
    if (step !== "close" && !open.has(key)) fail(`${kind} "${id}" is not open`);
    return step === "delta" ? undefined : () => open.delete(key);
  }

  const response: ResponseWriter = {
    id: writer.streamId,
    append(chunk) {
      const apply = check(chunk);
      // SAFETY: ResponseChunk fields are JSON, and undefined optional fields
      // are dropped when the chunk is serialized.
      writer.append(chunk as unknown as StreamJson);
      apply?.();
    },
    end() {
      writer.close();
    },
    async pipe(chunks) {
      try {
        for await (const chunk of chunks) response.append(chunk);
      } catch (error) {
        writer.error("interrupted");
        throw error;
      }
      response.end();
    }
  };
  return response;
}

// `close` ends a part that may never have been started.
type PartStep = "start" | "delta" | "end" | "close";

function partOf(
  chunk: ResponseChunk
): [kind: string, id: string, step: PartStep] | [kind: undefined] {
  switch (chunk.type) {
    case "text-start":
      return ["text", chunk.id, "start"];
    case "text-delta":
      return ["text", chunk.id, "delta"];
    case "text-end":
      return ["text", chunk.id, "end"];
    case "reasoning-start":
      return ["reasoning", chunk.id, "start"];
    case "reasoning-delta":
      return ["reasoning", chunk.id, "delta"];
    case "reasoning-end":
      return ["reasoning", chunk.id, "end"];
    case "tool-input-start":
      return ["tool input", chunk.toolCallId, "start"];
    case "tool-input-delta":
      return ["tool input", chunk.toolCallId, "delta"];
    case "tool-input-available":
    case "tool-input-error":
      return ["tool input", chunk.toolCallId, "close"];
    default:
      return [undefined];
  }
}

function fail(message: string): never {
  throw new ResponseGrammarError(message);
}
