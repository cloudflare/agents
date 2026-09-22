/**
 * A scripted text adapter, so the loop can be driven deterministically.
 *
 * `pi`'s tests get a faux provider from its own library. TanStack has no
 * equivalent, so this file is it: a `TextAdapter` whose `chatStream` replays a
 * canned sequence of AG-UI chunks per round.
 *
 * This is the single most useful piece of the test harness. Six of the seven
 * bugs found while building this example were invisible to `tsc` and only
 * appeared at runtime, and every one of them is reachable from here because
 * the harness already takes its models as an injectable option.
 */
import type { AdapterYieldChunk } from "@tanstack/ai";

/** One scripted model round. */
export type ScriptedRound =
  /** Reply with text and stop: the turn ends. */
  | {
      readonly kind: "text";
      readonly text: string;
      readonly reasoning?: string;
    }
  /** Ask for one or more tool calls, then expect another round. */
  | {
      readonly kind: "tools";
      readonly text?: string;
      readonly reasoning?: string;
      readonly calls: readonly {
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }[];
    }
  /** Fail the round, optionally after an unterminated text stream. */
  | {
      readonly kind: "error";
      readonly message: string;
      readonly partialText?: string;
    };

export type ScriptedModelOptions = {
  readonly rounds: readonly ScriptedRound[];
  /**
   * Replay the last round for ever instead of reporting exhaustion.
   *
   * The compaction summarizer is called an unpredictable number of times, so
   * a test should not have to predict it.
   */
  readonly repeatLast?: boolean;
  /** Token counts reported on RUN_FINISHED. */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly initialCursor?: number;
  readonly onCursor?: (cursor: number) => void | Promise<void>;
};

/**
 * A scripted adapter plus the record of what it was asked.
 *
 * The `calls` log is what makes prompt- and tool-visibility assertions
 * possible: a test can check which tools the model was actually offered,
 * which is how the role-plumbing bug is caught.
 */
export type ScriptedModel = {
  readonly adapter: unknown;
  /** One entry per `chatStream` invocation, in order. */
  readonly calls: ScriptedCall[];
  /** Reset the round cursor, for a second turn in the same object. */
  reset(): void;
};

export type ScriptedCall = {
  readonly systemPrompts: readonly string[];
  readonly toolNames: readonly string[];
  readonly messages: readonly { role: string; content: unknown }[];
};

/**
 * Build a scripted model.
 *
 * Rounds are consumed in order across the whole adapter lifetime, not per
 * turn, so a two-round turn followed by a one-round turn needs three entries.
 * `reset()` rewinds, for tests that want the same script twice.
 */
export function scriptedModel(options: ScriptedModelOptions): ScriptedModel {
  const calls: ScriptedCall[] = [];
  let cursor = options.initialCursor ?? 0;

  const adapter = {
    kind: "text" as const,
    name: "scripted",
    model: "scripted-test-model",
    "~types": {} as never,

    async *chatStream(
      opts: Record<string, unknown>
    ): AsyncIterable<AdapterYieldChunk> {
      calls.push({
        systemPrompts: (opts.systemPrompts as string[] | undefined) ?? [],
        toolNames: ((opts.tools as { name?: string }[] | undefined) ?? []).map(
          (tool) => tool.name ?? "unnamed"
        ),
        messages:
          (opts.messages as { role: string; content: unknown }[] | undefined) ??
          []
      });

      const round =
        options.rounds[cursor] ??
        (options.repeatLast && options.rounds.length > 0
          ? options.rounds[options.rounds.length - 1]
          : {
              kind: "text" as const,
              // Running off the end means the loop iterated more than the
              // test expected. Say so in the reply rather than hanging, so
              // the assertion failure names the real problem.
              text: `scripted model exhausted after ${cursor} rounds`
            });
      cursor++;
      await options.onCursor?.(cursor);

      const runId = `run-${cursor}`;
      yield { type: "RUN_STARTED", runId } as AdapterYieldChunk;

      if (round.kind === "error") {
        if (round.partialText) {
          const messageId = `msg-${cursor}`;
          yield { type: "TEXT_MESSAGE_START", messageId } as AdapterYieldChunk;
          yield {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: round.partialText
          } as AdapterYieldChunk;
        }
        yield {
          type: "RUN_ERROR",
          runId,
          error: { message: round.message },
          message: round.message
        } as AdapterYieldChunk;
        return;
      }

      if (round.reasoning) {
        const messageId = `reasoning-${cursor}`;
        yield {
          type: "REASONING_MESSAGE_START",
          messageId,
          role: "reasoning"
        } as AdapterYieldChunk;
        yield {
          type: "REASONING_MESSAGE_CONTENT",
          messageId,
          delta: round.reasoning
        } as AdapterYieldChunk;
        yield {
          type: "REASONING_MESSAGE_END",
          messageId
        } as AdapterYieldChunk;
      }

      const text = round.text;
      if (text) {
        const messageId = `msg-${cursor}`;
        yield { type: "TEXT_MESSAGE_START", messageId } as AdapterYieldChunk;
        yield {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: text
        } as AdapterYieldChunk;
        yield { type: "TEXT_MESSAGE_END", messageId } as AdapterYieldChunk;
      }

      if (round.kind === "tools") {
        for (const call of round.calls) {
          yield {
            type: "TOOL_CALL_START",
            toolCallId: call.id,
            toolCallName: call.name
          } as AdapterYieldChunk;
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id,
            delta: JSON.stringify(call.input)
          } as AdapterYieldChunk;
          yield {
            type: "TOOL_CALL_END",
            toolCallId: call.id
          } as AdapterYieldChunk;
        }
      }

      yield {
        type: "RUN_FINISHED",
        runId,
        usage: options.usage ?? { inputTokens: 11, outputTokens: 7 }
      } as AdapterYieldChunk;
    },

    async structuredOutput() {
      throw new Error("scripted model does not implement structuredOutput");
    }
  };

  return {
    adapter,
    calls,
    reset() {
      cursor = 0;
    }
  };
}

/**
 * A model map for the harness's `models` option.
 *
 * Every role shares one scripted adapter, so a test asserting "which tools
 * did the explorer see" reads the same `calls` log regardless of role.
 */
export function scriptedModels(model: ScriptedModel) {
  return {
    lead: model.adapter,
    explorer: model.adapter,
    compact: model.adapter
  };
}
