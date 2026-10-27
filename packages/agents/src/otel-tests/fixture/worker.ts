/**
 * The Worker behind `otel-runtime.test.ts`. Each route exercises one kind of
 * OpenTelemetry instrumentation; the test reads the resulting native spans
 * back from Local Explorer.
 */
import { context, SpanKind, trace } from "@opentelemetry/api";
import * as ai from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { experimental_registerOpenTelemetry } from "agents/observability";
import { wrapAISDK } from "agents/observability/ai";

type Env = { readonly KV: KVNamespace };

experimental_registerOpenTelemetry();
const tracer = trace.getTracer("otel-runtime-test");

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
};

function mockModel(env: Env, work = (read: () => Promise<unknown>) => read()) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      await work(() => env.KV.get("model-cache"));
      return {
        content: [{ type: "text", text: "Hello" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: []
      };
    }
  });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/ready":
        return new Response("ready");

      case "/otel": {
        // Plain OTel API: an active span, and a manual span activated later.
        await tracer.startActiveSpan("user span", async (span) => {
          await env.KV.get("user-span");
          span.end();
        });
        const manual = tracer.startSpan("manual span", {
          kind: SpanKind.CLIENT
        });
        await context.with(trace.setSpan(context.active(), manual), () =>
          env.KV.get("manual-span")
        );
        manual.end();
        return new Response("ok");
      }

      case "/ai-telemetry": {
        // AI SDK v6's own OpenTelemetry instrumentation.
        const result = await ai.generateText({
          model: mockModel(env),
          prompt: "Hello",
          experimental_telemetry: {
            isEnabled: true,
            recordInputs: false,
            recordOutputs: false
          }
        });
        return new Response(result.text);
      }

      case "/agent-spans": {
        // Agents SDK spans and OTel spans in one tree, both ways round.
        const { generateText } = wrapAISDK(ai);
        const result = await tracer.startActiveSpan(
          "otel outer",
          async (span) => {
            try {
              return await generateText({
                // An OTel span inside the Agents SDK's `chat` span.
                model: mockModel(env, (read) =>
                  tracer.startActiveSpan("model work", async (inner) => {
                    try {
                      return await read();
                    } finally {
                      inner.end();
                    }
                  })
                ),
                prompt: "Hello",
                experimental_telemetry: { functionId: "weather-agent" }
              });
            } finally {
              span.end();
            }
          }
        );
        return new Response(result.text);
      }

      default:
        return new Response("not found", { status: 404 });
    }
  }
} satisfies ExportedHandler<Env>;
