import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Browser, browserRun } from "../../../browser/browser";
import { browserTool } from "../../../browser/pi";
import { Lifecycle } from "../../../lifecycle";
import { createFakeBrowserBinding } from "../../../tests/capabilities/browser";
import { PiHarness } from "../index";
import { fauxModels, NO_RETRY } from "./faux";
import { setWakeTimingForTests } from "../harness";
import { TEST_TIMING } from "./timing";

/** Model code that reads the active tab and returns a screenshot. */
const SCREENSHOT_CODE = `async () => {
  await cdp.send({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "active" });
  return { type: "browser_screenshot", mediaType: "image/png", data: "aGVsbG8=" };
}`;

/**
 * The faux model calls `browser` once for any prompt, then answers with how
 * many images and text parts the tool result carried.
 */
function script(context: TranscriptContext): AssistantMessage {
  const last = context.messages.filter((m) => m.role !== "system").at(-1);
  if (last?.role === "toolResult") {
    const kinds = last.content.map((part) => part.type).join(",");
    return fauxAssistantMessage([fauxText(`browser returned: ${kinds}`)]);
  }
  return fauxAssistantMessage(
    [fauxToolCall("browser", { code: SCREENSHOT_CODE })],
    { stopReason: "toolUse" }
  );
}

/** A pi harness with the persistent browser tool, over the fake binding. */
export class PiBrowserTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  readonly #binding = createFakeBrowserBinding();
  readonly browser = new Browser({
    provider: browserRun(this.#binding.browser)
  });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "browser",
        tools: [
          browserTool({
            ctx: this.ctx,
            browser: this.browser,
            loader: this.env.LOADER
          })
        ]
      });
      return Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry: this.registry,
          settings: { retry: NO_RETRY }
        },
        context
      );
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.browser)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses(Array.from({ length: 20 }, () => script));
  }

  /**
   * The prompt's answer, and the stored tool result's parts, flattened to
   * plain strings so the RPC return type stays shallow.
   */
  async prompt(text: string) {
    const response = await this.harness.prompt(text);
    const toolResult = response.messages
      .map((entry) => entry.model?.[0])
      .find((message) => message?.role === "toolResult");
    const parts =
      toolResult?.role === "toolResult"
        ? toolResult.content.map((part) =>
            part.type === "image"
              ? `image ${part.mimeType} ${part.data}`
              : `text ${part.text}`
          )
        : [];
    return {
      status: response.status,
      text: response.text,
      parts,
      details: JSON.stringify(
        toolResult?.role === "toolResult" ? toolResult.details : null
      )
    };
  }
}
