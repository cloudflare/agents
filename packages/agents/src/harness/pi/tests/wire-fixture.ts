import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { createAI } from "../../../models/pi-ai";
import { asAi, fakeBinding } from "../../../tests/models/pi-ai/helpers";
import { setWakeTimingForTests } from "../harness";
import { PiHarness } from "../index";
import { TEST_SETTINGS } from "./faux";
import { TEST_TIMING } from "./timing";

/** Time between streamed chunks, so pi publishes each partial on its own. */
const CHUNK_GAP_MS = 60;

/** An SSE `Response` that sends one `data:` event every {@link CHUNK_GAP_MS}. */
function slowSse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\r\n\r\n`));
        await new Promise((resolve) => setTimeout(resolve, CHUNK_GAP_MS));
      }
      controller.close();
    }
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200
  });
}

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return JSON.stringify({
    choices: [{ delta, finish_reason: finish ?? null, index: 0 }],
    id: "chatcmpl-wire",
    model: "@cf/zai-org/glm-4.7-flash",
    object: "chat.completion.chunk",
    usage: null
  });
}

/**
 * A tool call whose argument text gains a `__proto__` member only after pi
 * has committed partials of it, the way a model streams one.
 */
function protoToolCall(): string[] {
  const pieces = [
    '{"city": "London", ',
    '"note": "',
    "x".repeat(40),
    "x".repeat(40),
    '", "__pro',
    'to__": {"pollu',
    'ted": true}}'
  ];
  return [
    chunk({
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: "", name: "getWeather" },
          id: "call_proto",
          index: 0,
          type: "function"
        }
      ]
    }),
    ...pieces.map((piece) =>
      chunk({ tool_calls: [{ function: { arguments: piece }, index: 0 }] })
    ),
    chunk({}, "tool_calls"),
    "[DONE]"
  ];
}

/** The arguments of the streamed `call_proto` in a `pi.live` doc, if any. */
function protoCallArguments(live: unknown): object | undefined {
  const content = (
    live as
      | { generation?: { message?: { content?: readonly unknown[] } } }
      | undefined
  )?.generation?.message?.content;
  for (const part of content ?? []) {
    const call = part as { id?: unknown; arguments?: unknown };
    if (call.id === "call_proto" && typeof call.arguments === "object") {
      return call.arguments ?? undefined;
    }
  }
  return undefined;
}

function answer(text: string): string[] {
  return [
    chunk({ content: text, role: "assistant" }),
    chunk({}, "stop"),
    "[DONE]"
  ];
}

/**
 * A harness on the agents chat-completions wire (`createAI`) over a fake AI
 * binding, so a test drives pi with what that wire streams rather than with
 * pi-ai's faux provider.
 */
export class PiWireTestObject extends DurableObject<Cloudflare.Env> {
  readonly #ai = createAI({
    binding: asAi(
      fakeBinding((_call, index) =>
        slowSse(index === 0 ? protoToolCall() : answer("done"))
      )
    )
  });
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(this.#ai.provider);
      return Harness.open(
        storage,
        { models, registry: createRegistry(), settings: TEST_SETTINGS },
        context
      );
    },
    defaults: { model: this.#ai("@cf/zai-org/glm-4.7-flash") }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
  }

  /**
   * Prompt the root session, watching pi's live view meanwhile. `merged`:
   * whether a partial of the tool call added `__proto__` to arguments an
   * earlier partial already had, which is the merge the test is about.
   */
  async prompt(text: string): Promise<{ status: string; merged: boolean }> {
    const watch = await this.harness.session().watch();
    let earlier = false;
    let merged = false;
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const args = protoCallArguments(call.value.docs["pi.live"]);
      if (args === undefined) return;
      if (Object.hasOwn(args, "__proto__")) merged ||= earlier;
      else if (Object.hasOwn(args, "note")) earlier = true;
    });
    try {
      return { status: (await this.harness.prompt(text)).status, merged };
    } finally {
      await watch.stop();
    }
  }

  /** Whether anything wrote `polluted` onto `Object.prototype` in this isolate. */
  prototypePolluted(): boolean {
    return "polluted" in {};
  }
}
