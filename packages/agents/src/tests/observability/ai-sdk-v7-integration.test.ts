import { AsyncLocalStorage } from "node:async_hooks";
import * as ai from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAISDKWrapper } from "../../observability/ai/wrapper/wrap";
import { withInvocationScope } from "../../observability/tracing/tracer";
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

/** First span recorded for a `gen_ai.operation.name`. */
function spanFor(tracing: RecordingTracer, operation: string) {
  return tracing.spans.find(
    (span) => span.attributes["gen_ai.operation.name"] === operation
  );
}

const wrap = (tracing: RecordingTracer) =>
  createAISDKWrapper(ai, { tracer: tracing });

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

  it("records the same identity attributes from v7 runtime context as from v6 metadata", async () => {
    const model = () =>
      new MockLanguageModelV4({
        modelId: "identity-model",
        provider: "mock-provider",
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { raw: "stop", unified: "stop" as const },
          usage,
          warnings: []
        })
      });

    const v6 = new RecordingTracer();
    await wrap(v6).generateText({
      experimental_telemetry: {
        functionId: "ClassName",
        metadata: { agentName: "booking-agent", tier: "gold" }
      },
      model: model(),
      prompt: "hi"
    } as Parameters<typeof ai.generateText>[0]);

    const v7 = new RecordingTracer();
    await wrap(v7).generateText({
      model: model(),
      prompt: "hi",
      runtimeContext: { agentName: "booking-agent", tier: "gold" },
      telemetry: {
        functionId: "ClassName",
        includeRuntimeContext: { agentName: true, tier: true }
      }
    } as Parameters<typeof ai.generateText>[0]);

    const v6Root = v6.rootSpans[0];
    const v7Root = v7.rootSpans[0];
    expect(v7Root?.attributes["gen_ai.agent.name"]).toBe("booking-agent");
    expect(v7Root?.name).toBe(v6Root?.name);
    // Non-reserved keys keep each major's documented namespace...
    expect(v6Root?.attributes["cloudflare.agents.metadata.tier"]).toBe("gold");
    expect(v7Root?.attributes["cloudflare.agents.runtime_context.tier"]).toBe(
      "gold"
    );
    // ...but everything else, identity included, matches attribute for
    // attribute, so a query written against v6 traces still matches v7 ones.
    const withoutPassthrough = (attributes: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(attributes).filter(
          ([key]) =>
            !key.startsWith("cloudflare.agents.metadata.") &&
            !key.startsWith("cloudflare.agents.runtime_context.")
        )
      );
    expect(withoutPassthrough(v7Root?.attributes ?? {})).toEqual(
      withoutPassthrough(v6Root?.attributes ?? {})
    );
  });

  it("keeps Think turn metadata on its canonical attributes across majors", async () => {
    const model = () =>
      new MockLanguageModelV4({
        modelId: "identity-model",
        provider: "mock-provider",
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { raw: "stop", unified: "stop" as const },
          usage,
          warnings: []
        })
      });
    // The shape Think builds for a v7 turn: identity and turn keys in runtime
    // context, every one of them marked included.
    const turn = {
      agentId: "agent-1",
      "cloudflare.agents.turn.admission": "queue",
      "cloudflare.agents.turn.request_id": "req-1",
      "cloudflare.agents.turn.trigger": "ws-chat",
      conversationId: "conv-1"
    };

    const tracing = new RecordingTracer();
    await wrap(tracing).generateText({
      model: model(),
      prompt: "hi",
      runtimeContext: turn,
      telemetry: {
        functionId: "ProbeAgent",
        includeRuntimeContext: Object.fromEntries(
          Object.keys(turn).map((key) => [key, true])
        )
      }
    } as Parameters<typeof ai.generateText>[0]);

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.turn.admission": "queue",
      "cloudflare.agents.turn.request_id": "req-1",
      "cloudflare.agents.turn.trigger": "ws-chat",
      "gen_ai.agent.id": "agent-1",
      "gen_ai.conversation.id": "conv-1"
    });
    // Identity keys are consumed into gen_ai.* rather than passed through.
    expect(
      tracing.rootSpans[0]?.attributes[
        "cloudflare.agents.runtime_context.agentId"
      ]
    ).toBeUndefined();
  });

  it("keeps runtime context off spans unless the caller includes it", async () => {
    const tracing = new RecordingTracer();
    await wrap(tracing).generateText({
      model: new MockLanguageModelV4({
        modelId: "identity-model",
        provider: "mock-provider",
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          finishReason: { raw: "stop", unified: "stop" as const },
          usage,
          warnings: []
        })
      }),
      prompt: "hi",
      runtimeContext: {
        authToken: "sk-secret",
        tier: "gold",
        userEmail: "alice@example.com"
      },
      telemetry: { functionId: "f", includeRuntimeContext: { tier: true } }
    } as Parameters<typeof ai.generateText>[0]);

    const attributes = tracing.rootSpans[0]?.attributes ?? {};
    expect(attributes["cloudflare.agents.runtime_context.tier"]).toBe("gold");
    expect(
      attributes["cloudflare.agents.runtime_context.authToken"]
    ).toBeUndefined();
    expect(
      attributes["cloudflare.agents.runtime_context.userEmail"]
    ).toBeUndefined();
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

  it("keeps WebSocket spans open for work that completes inside the invocation", async () => {
    const tracing = new RecordingTracer();
    const toolStarted = deferred();
    const continueTool = deferred();
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
        return { stream: ai.simulateReadableStream({ chunks: textChunks() }) };
      }
    });

    await withInvocationScope(async () => {
      const result = createAISDKWrapper(ai, {
        options: { storeTools: true },
        tracer: tracing
      }).streamText({
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
      // Work still in flight inside its own invocation: closing here is what
      // used to discard every finish attribute.
      expect(spanFor(tracing, "invoke_agent")?.ended).toBe(false);
      expect(spanFor(tracing, "execute_tool")?.ended).toBe(false);

      continueTool.resolve();
      await consume;
    });

    // Same attribute set the v6 path records for the same turn — the point of
    // routing both SDK majors through one wrapper.
    const operation = spanFor(tracing, "invoke_agent");
    expect(operation?.ended).toBe(true);
    expect(operation?.attributes).toMatchObject({
      "cloudflare.agents.integration.name": "ai-sdk",
      "cloudflare.agents.operation.name": "streamText",
      "cloudflare.agents.response.finish_reason": "stop",
      "cloudflare.agents.tool.count": 1,
      "cloudflare.agents.usage.total_tokens": 10,
      "gen_ai.provider.name": "mock-provider",
      "gen_ai.request.model": "boundary-model",
      "gen_ai.request.stream": true,
      "gen_ai.usage.input_tokens": 6,
      "gen_ai.usage.output_tokens": 4
    });
    expect(
      operation?.attributes["cloudflare.agents.span.truncated"]
    ).toBeUndefined();

    const tool = spanFor(tracing, "execute_tool");
    expect(tool?.attributes).toMatchObject({
      "gen_ai.tool.call.arguments": JSON.stringify({ value: 21 }),
      "gen_ai.tool.call.id": "double-1",
      "gen_ai.tool.call.result": "42",
      "gen_ai.tool.name": "double",
      "gen_ai.tool.type": "function"
    });

    const chats = tracing.spans.filter(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      expect(chat.ended).toBe(true);
      expect(chat.parent).toBe(operation);
      expect(chat.attributes).toMatchObject({
        "cloudflare.agents.operation.name": "doStream",
        "cloudflare.agents.usage.total_tokens": 5,
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 2
      });
      expect(
        typeof chat.attributes["gen_ai.response.time_to_first_chunk"]
      ).toBe("number");
    }
  });

  it("bounds generateText to its invocation, not just streaming operations", async () => {
    const tracing = new RecordingTracer();
    const release = deferred();
    let escaped: Promise<unknown> | undefined;

    await withInvocationScope(async () => {
      escaped = wrap(tracing).generateText({
        [Symbol.for("cloudflare.agents.ai-sdk.invocation-bounded")]: true,
        model: new MockLanguageModelV4({
          modelId: "slow-model",
          provider: "mock-provider",
          doGenerate: async () => {
            await release.promise;
            return {
              content: [{ type: "text", text: "ok" }],
              finishReason: { raw: "stop", unified: "stop" as const },
              usage,
              warnings: []
            };
          }
        }),
        prompt: "hi"
      } as Parameters<typeof ai.generateText>[0]);
      // The model call is still in flight as the invocation ends.
    });

    const operation = spanFor(tracing, "invoke_agent");
    expect(operation?.ended).toBe(true);
    expect(operation?.attributes["cloudflare.agents.span.truncated"]).toBe(
      true
    );

    release.resolve();
    await escaped;
    // A result arriving after the invocation cannot reopen the span.
    expect(operation?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("marks approval spans decided after the invocation ended", async () => {
    const tracing = new RecordingTracer();
    const decided = deferred<boolean>();
    let escaped: Promise<unknown> | undefined;

    await withInvocationScope(async () => {
      escaped = wrap(tracing).generateText({
        [Symbol.for("cloudflare.agents.ai-sdk.invocation-bounded")]: true,
        model: approvalRequestModel(),
        prompt: "Deploy",
        tools: {
          deploy: ai.tool({
            execute: async () => "deployed",
            inputSchema: z.object({ target: z.string() }),
            // The decision lands after the invocation is over, so the approval
            // spans are opened against a context that is already gone.
            needsApproval: async () => decided.promise
          })
        }
      } as Parameters<typeof ai.generateText>[0]);
    });

    decided.resolve(true);
    await escaped;

    const approval = tracing.spans.find(
      (span) => span.name === "tool_approval deploy"
    );
    // Still recorded, and still says what it decided...
    expect(approval?.attributes["cloudflare.agents.tool.approval.state"]).toBe(
      "requested"
    );
    // ...but not passed off as part of an invocation that had already ended.
    expect(approval?.attributes["cloudflare.agents.span.truncated"]).toBe(true);
    expect(
      approval?.parent?.attributes["cloudflare.agents.span.truncated"]
    ).toBe(true);
  });

  it("marks top-level approval spans decided after the invocation ended", async () => {
    const tracing = new RecordingTracer();
    const decided = deferred<"user-approval">();
    let escaped: Promise<unknown> | undefined;

    await withInvocationScope(async () => {
      escaped = wrap(tracing).generateText({
        [Symbol.for("cloudflare.agents.ai-sdk.invocation-bounded")]: true,
        model: approvalRequestModel(),
        prompt: "Deploy",
        toolApproval: async () => decided.promise,
        tools: {
          deploy: ai.tool({
            execute: async () => "deployed",
            inputSchema: z.object({ target: z.string() })
          })
        }
      } as Parameters<typeof ai.generateText>[0]);
    });

    decided.resolve("user-approval");
    await escaped;

    const approval = tracing.spans.find(
      (span) => span.name === "tool_approval deploy"
    );
    expect(approval?.attributes["cloudflare.agents.tool.approval.state"]).toBe(
      "requested"
    );
    expect(approval?.attributes["cloudflare.agents.span.truncated"]).toBe(true);
    expect(
      approval?.parent?.attributes["cloudflare.agents.span.truncated"]
    ).toBe(true);
  });

  it("leaves approval spans decided inside the invocation unmarked", async () => {
    const tracing = new RecordingTracer();

    await withInvocationScope(async () => {
      await wrap(tracing).generateText({
        [Symbol.for("cloudflare.agents.ai-sdk.invocation-bounded")]: true,
        model: approvalRequestModel(),
        prompt: "Deploy",
        tools: {
          deploy: ai.tool({
            execute: async () => "deployed",
            inputSchema: z.object({ target: z.string() }),
            needsApproval: async () => true
          })
        }
      } as Parameters<typeof ai.generateText>[0]);
    });

    const approval = tracing.spans.find(
      (span) => span.name === "tool_approval deploy"
    );
    expect(approval?.attributes["cloudflare.agents.tool.approval.state"]).toBe(
      "requested"
    );
    expect(
      approval?.attributes["cloudflare.agents.span.truncated"]
    ).toBeUndefined();
  });

  it("truncates WebSocket spans whose work escapes the invocation", async () => {
    const tracing = new RecordingTracer();
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

    // Held outside the scope: returning it would make the scope await the very
    // work that is supposed to escape it.
    let escaped: Promise<void> | undefined;
    await withInvocationScope(async () => {
      const result = wrap(tracing).streamText({
        [Symbol.for("cloudflare.agents.ai-sdk.invocation-bounded")]: true,
        model,
        prompt: "Double 21",
        stopWhen: ai.isStepCount(2),
        tools: {
          double: ai.tool({
            inputSchema: z.object({ value: z.number() }),
            execute: async ({ value }) => value * 2
          })
        }
      } as Parameters<typeof ai.streamText>[0]);
      escaped = (async () => {
        for await (const _part of result.fullStream) {
          // Consume the complete multi-step stream.
        }
      })();

      // The invocation ends while the second model call is still open.
      await secondModelStarted.promise;
    });

    const operation = spanFor(tracing, "invoke_agent");
    const tool = spanFor(tracing, "execute_tool");
    expect(operation?.ended).toBe(true);
    expect(operation?.attributes["cloudflare.agents.span.truncated"]).toBe(
      true
    );
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
    await escaped;
    // Work that lands after the invocation cannot reopen a closed span.
    expect(operation?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
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
