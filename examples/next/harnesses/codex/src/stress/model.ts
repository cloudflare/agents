import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";

/** Shape of one synthetic turn: how many rounds and how big each piece is. */
export type StressScenario = {
  /** Model rounds before the final answer. Each round issues tool calls. */
  readonly rounds: number;
  /** Tool calls per round; alternates workspace_write and workspace_read. */
  readonly callsPerRound: number;
  /** Bytes of content each workspace_write carries (and each read returns). */
  readonly toolBytes: number;
  /** Bytes of assistant text in the final answer. */
  readonly answerBytes: number;
  /** Bytes of reasoning emitted per round. */
  readonly reasoningBytes: number;
};

const USAGE = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1
  },
  outputTokens: { reasoning: undefined, text: 1, total: 1 }
};

function filler(bytes: number, seed: string): string {
  if (bytes <= 0) return "";
  const unit = `${seed} lorem ipsum dolor sit amet `;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/**
 * A deterministic LanguageModelV4 that drives the Codex kernel through a
 * configurable number of tool rounds without any network. It streams like a
 * real provider so the harness's V4 codec runs on every call.
 */
export class StressModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "codex-stress";
  readonly modelId = "stress";
  readonly supportedUrls = {};
  scenario: StressScenario = {
    rounds: 1,
    callsPerRound: 2,
    toolBytes: 256,
    answerBytes: 256,
    reasoningBytes: 64
  };
  calls = 0;
  /** Model rounds taken in the current turn; reset by the host per run. */
  round = 0;

  /** Start a new turn: the next call is round 0 again. */
  reset(): void {
    this.round = 0;
  }

  doGenerate(): never {
    throw new Error("StressModel only streams");
  }

  async doStream(_options: LanguageModelV4CallOptions) {
    this.calls += 1;
    const round = this.round++;
    const scenario = this.scenario;
    const parts: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: `stress-${this.calls}` }
    ];
    if (scenario.reasoningBytes > 0) {
      parts.push(
        { type: "reasoning-start", id: "r" },
        {
          type: "reasoning-delta",
          id: "r",
          delta: filler(scenario.reasoningBytes, `round ${round}`)
        },
        { type: "reasoning-end", id: "r" }
      );
    }
    if (round < scenario.rounds) {
      for (let index = 0; index < scenario.callsPerRound; index++) {
        const write = index % 2 === 0;
        const path = `/stress/file-${round}-${Math.floor(index / 2)}.txt`;
        parts.push({
          type: "tool-call",
          toolCallId: `call-${this.calls}-${round}-${index}`,
          toolName: write ? "workspace_write" : "workspace_read",
          input: JSON.stringify(
            write
              ? { path, content: filler(scenario.toolBytes, path) }
              : { path }
          )
        });
      }
      parts.push({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: USAGE
      });
    } else {
      parts.push(
        { type: "text-start", id: "t" },
        {
          type: "text-delta",
          id: "t",
          delta: filler(scenario.answerBytes, "final answer")
        },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE
        }
      );
    }
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        }
      })
    };
  }
}
