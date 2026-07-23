/**
 * Replay Model — composes real AI SDK providers for buffer recovery.
 *
 * Instead of custom SSE parsing, this creates the real provider model
 * (OpenAI, Anthropic, Workers AI) with a `replayFetch` that returns
 * the buffer's response. The provider's own maintained SSE parser
 * handles format conversion to the provider's language model stream parts.
 *
 * This means: if @ai-sdk/openai updates how it parses Responses API
 * SSE, the replay model picks it up automatically. Zero drift.
 *
 * The `createReplayModel` function is provider-agnostic — it accepts
 * a `createModel` factory from the caller. The caller knows which
 * provider to use and how to configure it.
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";

type ReplayLanguageModel = LanguageModelV3 | LanguageModelV4;

/**
 * Create a replay model that reads from the inference buffer and
 * delegates SSE parsing to the real provider's model implementation.
 *
 * @param options.buffer - Service binding to the inference buffer worker
 * @param options.bufferId - Buffer ID to resume from
 * @param options.createModel - Factory that creates the real provider model
 *   with a custom fetch that returns the buffer's response. Example:
 *   ```
 *   createModel: (fetch) => createOpenAI({ apiKey: "replay", fetch })("gpt-5.4")
 *   ```
 *   For providers without a `fetch` option (like Workers AI binding),
 *   create a fake binding whose run() calls the replayFetch.
 */
export function createReplayModel(options: {
  buffer: Fetcher;
  bufferId: string;
  createModel: (replayFetch: typeof fetch) => ReplayLanguageModel;
}): ReplayLanguageModel {
  // Single-use: first doStream replays the buffer. Subsequent calls
  // (from streamText's tool-call step loop) return an empty finish
  // stream so the loop terminates cleanly.
  let replayed = false;

  const replayFetch: typeof fetch = async () => {
    const res = await options.buffer.fetch(
      new Request(`https://buffer/resume?id=${options.bufferId}&from=0`)
    );
    if (!res.ok) {
      throw new Error(
        `Buffer resume failed (${res.status}): ${await res.text().catch(() => "unknown")}`
      );
    }
    return res;
  };

  const innerModel = options.createModel(replayFetch);

  if (innerModel.specificationVersion === "v4") {
    return {
      ...innerModel,

      doGenerate: async () => {
        throw new Error("Replay model is stream-only");
      },

      doStream: async (params: LanguageModelV4CallOptions) => {
        if (replayed) {
          return { stream: createEmptyV4FinishStream() };
        }
        replayed = true;
        return innerModel.doStream(params);
      }
    };
  }

  return {
    ...innerModel,

    doGenerate: async () => {
      throw new Error("Replay model is stream-only");
    },

    doStream: async (params: LanguageModelV3CallOptions) => {
      if (replayed) {
        return { stream: createEmptyFinishStream() };
      }
      replayed = true;
      return innerModel.doStream(params);
    }
  };
}

function createEmptyFinishStream(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined
          }
        }
      });
      controller.close();
    }
  });
}

function createEmptyV4FinishStream(): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined
          }
        }
      });
      controller.close();
    }
  });
}
