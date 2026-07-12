import { AbortedError } from "../../kernel/errors.js";
import { defaultIdSource } from "../../kernel/ids.js";
import type { ModelChunk, ModelClient, ModelRequest } from "../../ports/model.js";

export type FakeTurn =
  | { kind: "text"; text: string; reasoning?: string }
  | { kind: "tool-call"; toolName: string; input: unknown; id?: string }
  | { kind: "error"; error: Error }
  | { kind: "hang" }
  | { kind: "custom"; chunks: ModelChunk[] };

export interface FakeModel extends ModelClient {
  /** Every request this model has been called with, in order. */
  readonly requests: ModelRequest[];
}

function splitInHalf(text: string): [string, string] {
  const cut = Math.max(1, Math.floor(text.length / 2));
  return [text.slice(0, cut), text.slice(cut)];
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError("Model call aborted");
}

/** Waits forever unless/until `signal` aborts, in which case it throws AbortedError. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return; // never settles
    if (signal.aborted) {
      reject(new AbortedError("Model call aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new AbortedError("Model call aborted")), { once: true });
  });
}

async function* turnToChunks(turn: FakeTurn, signal: AbortSignal | undefined): AsyncGenerator<ModelChunk> {
  switch (turn.kind) {
    case "text": {
      if (turn.reasoning) {
        const [first, second] = splitInHalf(turn.reasoning);
        yield { type: "reasoning-delta", text: first };
        checkAborted(signal);
        yield { type: "reasoning-delta", text: second };
        checkAborted(signal);
      }
      const [first, second] = splitInHalf(turn.text);
      yield { type: "text-delta", text: first };
      checkAborted(signal);
      yield { type: "text-delta", text: second };
      checkAborted(signal);
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    case "tool-call": {
      yield {
        type: "tool-call",
        toolCallId: turn.id ?? defaultIdSource.newId("call"),
        toolName: turn.toolName,
        input: turn.input,
      };
      checkAborted(signal);
      yield { type: "finish", finishReason: "tool-calls" };
      return;
    }
    case "error": {
      throw turn.error;
    }
    case "hang": {
      await hangUntilAborted(signal);
      return;
    }
    case "custom": {
      for (const chunk of turn.chunks) {
        checkAborted(signal);
        yield chunk;
      }
      return;
    }
  }
}

export function createFakeModel(script: FakeTurn[] | ((req: ModelRequest, call: number) => FakeTurn)): FakeModel {
  const requests: ModelRequest[] = [];
  let callCount = 0;

  function turnFor(request: ModelRequest): FakeTurn {
    const call = callCount;
    callCount += 1;
    if (typeof script === "function") return script(request, call);
    const turn = script[call];
    if (!turn) throw new Error(`FakeModel: no scripted turn for call ${call}`);
    return turn;
  }

  return {
    requests,
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      requests.push(request);
      checkAborted(request.signal);
      const turn = turnFor(request);
      yield* turnToChunks(turn, request.signal);
    },
  };
}
