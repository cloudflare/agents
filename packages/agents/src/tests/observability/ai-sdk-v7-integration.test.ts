import { AsyncLocalStorage } from "node:async_hooks";
import * as ai from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAISDKV6Wrapper } from "../../observability/ai/v6/wrap";
import { deferred, RecordingTracer } from "./recording-tracer";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 3,
    total: 3
  },
  outputTokens: {
    reasoning: undefined,
    text: 2,
    total: 2
  }
};

const wrap = (tracing: RecordingTracer) =>
  createAISDKV6Wrapper(ai, { tracer: tracing });

describe("wrapAISDK with the real AI SDK v7", () => {
  it("keeps model and tool spans under invoke_agent without restoring auth state", async () => {
    const auth = new AsyncLocalStorage<{ token: string }>();
    const tracing = new RecordingTracer();
    const providerTokens: Array<string | undefined> = [];
    let toolToken: string | undefined;
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      modelId: "auth-model",
      provider: "mock-provider",
      doGenerate: async () => {
        providerTokens.push(auth.getStore()?.token);
        modelCall += 1;
        return modelCall === 1
          ? {
              content: [
                {
                  type: "tool-call" as const,
                  input: JSON.stringify({ value: 21 }),
                  toolCallId: "double-1",
                  toolName: "double"
                }
              ],
              finishReason: {
                raw: "tool-calls",
                unified: "tool-calls" as const
              },
              usage,
              warnings: []
            }
          : {
              content: [{ type: "text" as const, text: "42" }],
              finishReason: { raw: "stop", unified: "stop" as const },
              usage,
              warnings: []
            };
      }
    });
    const authIntegration = {
      executeLanguageModelCall<T>({
        execute
      }: {
        execute: () => PromiseLike<T>;
      }) {
        return auth.run({ token: "provider-token" }, execute);
      },
      executeTool<T>({ execute }: { execute: () => PromiseLike<T> }) {
        return auth.run({ token: "tool-token" }, execute);
      }
    };

    const result = await auth.run({ token: "turn-token" }, () =>
      wrap(tracing).generateText({
        model,
        prompt: "Double 21",
        stopWhen: ai.isStepCount(2),
        telemetry: {
          functionId: "tool-agent",
          integrations: [authIntegration]
        },
        tools: {
          double: ai.tool({
            inputSchema: z.object({ value: z.number() }),
            execute: async ({ value }) => {
              toolToken = auth.getStore()?.token;
              return value * 2;
            }
          })
        }
      })
    );

    expect(result.text).toBe("42");
    expect(providerTokens).toEqual(["provider-token", "provider-token"]);
    expect(toolToken).toBe("tool-token");
    expect(auth.getStore()).toBeUndefined();

    const operation = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    const children = tracing.spans.filter((span) =>
      ["chat", "execute_tool"].includes(
        String(span.attributes["gen_ai.operation.name"])
      )
    );
    expect(operation?.name).toBe("invoke_agent tool-agent");
    expect(children).toHaveLength(3);
    expect(children.every((span) => span.parent === operation)).toBe(true);
    expect(tracing.spans.every((span) => span.ended)).toBe(true);
  });

  it("records requested, approved, and denied tool approvals", async () => {
    let executions = 0;
    const deploy = ai.tool({
      inputSchema: z.object({ target: z.string() }),
      needsApproval: true,
      execute: async () => {
        executions += 1;
        return "deployed";
      }
    });
    const requestedTracing = new RecordingTracer();
    const requested = await wrap(requestedTracing).generateText({
      model: approvalRequestModel(),
      prompt: "Deploy",
      tools: { deploy }
    });
    const request = requested.content.find(
      (part) => part.type === "tool-approval-request"
    );
    expect(request).toBeDefined();
    expectApproval(requestedTracing, "requested");

    const messages = (approved: boolean): ai.ModelMessage[] => [
      { role: "user", content: "Deploy" },
      ...requested.response.messages,
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: request!.approvalId,
            approved
          }
        ]
      }
    ];

    const approvedTracing = new RecordingTracer();
    await wrap(approvedTracing).generateText({
      messages: messages(true),
      model: textModel("deployed"),
      tools: { deploy }
    });
    expectApproval(approvedTracing, "approved");

    const deniedTracing = new RecordingTracer();
    await wrap(deniedTracing).generateText({
      messages: messages(false),
      model: textModel("denied"),
      tools: { deploy }
    });
    expectApproval(deniedTracing, "denied");
    expect(executions).toBe(1);
  });

  it.each([
    ["global function", "user-approval", "requested", 0],
    ["tool function", "approved", "approved", 1],
    ["static tool", "denied", "denied", 0]
  ] as const)(
    "records a %s approval policy",
    async (shape, policy, state, expectedExecutions) => {
      const tracing = new RecordingTracer();
      let executions = 0;
      const toolApproval =
        shape === "global function"
          ? () => policy
          : { deploy: shape === "tool function" ? () => policy : policy };
      await wrap(tracing).generateText({
        model: approvalRequestModel(),
        prompt: "Deploy",
        toolApproval,
        tools: {
          deploy: ai.tool({
            inputSchema: z.object({ target: z.string() }),
            execute: async () => {
              executions += 1;
              return "deployed";
            }
          })
        }
      });
      expect(executions).toBe(expectedExecutions);
      expectApproval(tracing, state);
    }
  );

  it("closes WebSocket spans before delayed tool and model work completes", async () => {
    const tracing = new RecordingTracer();
    const toolStarted = deferred();
    const continueTool = deferred();
    const secondModelStarted = deferred();
    const finishSecondModel =
      deferred<Awaited<ReturnType<MockLanguageModelV4["doStream"]>>>();
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      modelId: "boundary-model",
      provider: "mock-provider",
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          return {
            stream: ai.simulateReadableStream({ chunks: toolCallChunks() })
          };
        }
        secondModelStarted.resolve();
        return finishSecondModel.promise;
      }
    });

    const result = wrap(tracing).streamText({
      [Symbol.for("cloudflare.agents.ai-sdk.invocation-bounded")]: true,
      model,
      prompt: "Double 21",
      stopWhen: ai.isStepCount(2),
      tools: {
        double: ai.tool({
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => {
            toolStarted.resolve();
            await continueTool.promise;
            return value * 2;
          }
        })
      }
    } as Parameters<typeof ai.streamText>[0]);
    const consume = (async () => {
      for await (const _part of result.fullStream) {
        // Consume the complete multi-step stream.
      }
    })();

    await toolStarted.promise;
    const operation = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    const tool = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(operation?.ended).toBe(true);
    expect(tool?.ended).toBe(true);

    continueTool.resolve();
    await secondModelStarted.promise;
    const chats = tracing.spans.filter(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chats).toHaveLength(2);
    expect(chats[1]?.ended).toBe(true);
    expect([...chats, tool].every((span) => span?.parent === operation)).toBe(
      true
    );

    finishSecondModel.resolve({
      stream: ai.simulateReadableStream({ chunks: textChunks() })
    });
    await consume;
  });
});

function approvalRequestModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "approval-model",
    provider: "mock-provider",
    doGenerate: {
      content: [
        {
          type: "tool-call",
          input: JSON.stringify({ target: "production" }),
          toolCallId: "deploy-1",
          toolName: "deploy"
        }
      ],
      finishReason: { raw: "tool-calls", unified: "tool-calls" },
      usage,
      warnings: []
    }
  });
}

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "approval-model",
    provider: "mock-provider",
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { raw: "stop", unified: "stop" },
      usage,
      warnings: []
    }
  });
}

function expectApproval(
  tracing: RecordingTracer,
  state: "approved" | "denied" | "requested"
): void {
  const approval = tracing.spans.find(
    (span) => span.name === "tool_approval deploy"
  );
  expect(approval?.attributes).toMatchObject({
    "cloudflare.agents.tool.approval.state": state,
    "gen_ai.tool.call.id": "deploy-1"
  });
  expect(approval?.parent?.attributes["gen_ai.operation.name"]).toBe(
    "execute_tool"
  );
  expect(approval?.parent?.parent?.attributes["gen_ai.operation.name"]).toBe(
    "invoke_agent"
  );
}

function toolCallChunks() {
  return [
    { type: "stream-start" as const, warnings: [] },
    {
      type: "tool-call" as const,
      input: JSON.stringify({ value: 21 }),
      toolCallId: "double-1",
      toolName: "double"
    },
    {
      type: "finish" as const,
      finishReason: { raw: "tool-calls", unified: "tool-calls" as const },
      logprobs: undefined,
      usage
    }
  ];
}

function textChunks() {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text-2" },
    { type: "text-delta" as const, id: "text-2", delta: "42" },
    { type: "text-end" as const, id: "text-2" },
    {
      type: "finish" as const,
      finishReason: { raw: "stop", unified: "stop" as const },
      logprobs: undefined,
      usage
    }
  ];
}
