import { DurableObject } from "cloudflare:workers";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { Channels, type OperationResult } from "../../experimental/channels";
import { WebChannel } from "../../experimental/channels/web";
import { AiSdkHarness } from "../../harness/ai-sdk";
import { Lifecycle } from "../../lifecycle";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1
  },
  outputTokens: { reasoning: undefined, text: 1, total: 1 }
};

/** What the scripted model answers with, one entry per model call. */
export type ScriptedReply =
  /** A `held` reply starts only once the test calls `release()`. */
  | { text: string; delayMs?: number; held?: boolean }
  | { call: string; toolCallId: string };

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { raw: reason, unified: reason },
  logprobs: undefined,
  usage
});

function stream(reply: ScriptedReply) {
  if ("call" in reply) {
    return simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: reply.toolCallId,
          toolName: reply.call,
          input: "{}"
        },
        finish("tool-calls")
      ]
    });
  }
  return simulateReadableStream({
    chunkDelayInMs: reply.delayMs ?? 0,
    chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t" },
      { type: "text-delta" as const, id: "t", delta: reply.text },
      { type: "text-end" as const, id: "t" },
      finish("stop")
    ]
  });
}

/**
 * Channels over an AI SDK harness whose model replies from a script. Tests
 * set the script over RPC and talk to the agent through WebSockets.
 */
export class AiSdkHarnessObject extends DurableObject<Cloudflare.Env> {
  #script: ScriptedReply[] = [];
  #release!: () => void;
  readonly #held = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  /** Model calls so far, with the prompt each saw. */
  readonly prompts: unknown[] = [];

  readonly harness = new AiSdkHarness({
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        this.prompts.push(prompt);
        const reply = this.#script.shift() ?? { text: "(no script)" };
        if ("held" in reply && reply.held) await this.#held;
        return { stream: stream(reply) };
      }
    }),
    tools: {
      getLocation: tool({
        description: "Get the user's location",
        inputSchema: z.object({})
      }),
      flipCoin: tool({
        description: "Flip a coin",
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => "Heads"
      }),
      lookUp: tool({
        description: "Look something up",
        inputSchema: z.object({}),
        execute: async () => ({ raw: "full host-side output" }),
        toModelOutput: () => ({ type: "text", value: "shaped for the model" })
      })
    }
  });
  readonly channels = Channels.forHarness(this.harness, {
    channels: { web: new WebChannel() }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.channels.streams)
    .use(this.channels)
    .use(this.channels.websockets);

  setScript(script: ScriptedReply[]): void {
    this.#script = script;
  }

  /** Let a `held` reply start. */
  release(): void {
    this.#release();
  }

  getPromptCount(): number {
    return this.prompts.length;
  }

  /** The prompt the model saw on call `index`, as JSON. */
  getPrompt(index: number): string {
    return JSON.stringify(this.prompts[index]);
  }

  /** Submit straight to the harness, bypassing Channels. */
  async submit(session: string, text: string, operationId: string) {
    return this.harness
      .session(session)
      .submit({ parts: [{ type: "text", text }] }, { operationId });
  }

  wait(session: string, operationId: string): Promise<OperationResult> {
    return this.harness.session(session).wait(operationId);
  }

  /** Wait with a signal aborted before the wait begins. */
  async waitAborted(
    session: string,
    operationId: string
  ): Promise<"rejected" | OperationResult["status"]> {
    try {
      const result = await this.harness
        .session(session)
        .wait(operationId, AbortSignal.abort(new Error("stop")));
      return result.status;
    } catch {
      return "rejected";
    }
  }

  async state(session: string) {
    const watch = await this.harness.session(session).watch();
    await watch.stop();
    return watch.state;
  }
}
