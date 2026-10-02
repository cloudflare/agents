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
  | { text: string; delayMs?: number }
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
  /** Model calls so far, with the prompt each saw. */
  readonly prompts: unknown[] = [];

  readonly harness = new AiSdkHarness({
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        this.prompts.push(prompt);
        const reply = this.#script.shift() ?? { text: "(no script)" };
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

  getPromptCount(): number {
    return this.prompts.length;
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

  async state(session: string) {
    const watch = await this.harness.session(session).watch();
    await watch.stop();
    return watch.state;
  }
}
