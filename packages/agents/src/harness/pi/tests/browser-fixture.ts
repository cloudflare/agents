import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { DurableObject } from "cloudflare:workers";
import { Browser } from "../../../browser/browser";
import { browserRun } from "../../../browser/providers/browser-run";
import { browserTool } from "../../../browser/tools/pi";
import { Lifecycle } from "../../../lifecycle";
import { createFakeBrowserBinding } from "../../../tests/capabilities/browser";
import { PiHarness } from "../index";
import { fauxModels, TEST_SETTINGS } from "./faux";
import { setWakeTimingForTests } from "../harness";
import { TEST_TIMING } from "./timing";

/** Model code that reads the active tab and returns a screenshot. */
const SCREENSHOT_CODE = `async () => {
  await browser.cdp({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "active" });
  return { type: "browser_screenshot", mediaType: "image/png", data: "aGVsbG8=" };
}`;

/** A 1x1 PNG: code mode's `image()` only shows real images. */
export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * A codemode script that takes a screenshot and shows it, reads a value, and
 * runs code that throws, all through `tools.browser`.
 */
const CODEMODE_SCRIPT = `const shot = await tools.browser({ code: ${JSON.stringify(
  SCREENSHOT_CODE.replace("aGVsbG8=", PNG)
)} });
image(shot.result);
const page = await tools.browser({ code: "async () => ({ title: 'Example' })" });
const failed = await tools.browser({ code: "async () => { throw new Error('boom'); }" });
return { shot: shot.status, title: page.result.title, failed: failed.status, error: failed.error };`;

/**
 * The faux model calls `browser` once for any prompt, or `codemode` with
 * {@link CODEMODE_SCRIPT} for the prompt `codemode`, then answers with how
 * many images and text parts the tool result carried.
 */
function script(context: TranscriptContext): AssistantMessage {
  const messages = context.messages.filter((m) => m.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const kinds = last.content.map((part) => part.type).join(",");
    return fauxAssistantMessage([
      fauxText(`${last.toolName} returned: ${kinds}`)
    ]);
  }
  const asked =
    last?.role !== "user"
      ? ""
      : typeof last.content === "string"
        ? last.content
        : last.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
  const call =
    asked === "codemode"
      ? fauxToolCall("codemode", { code: CODEMODE_SCRIPT })
      : fauxToolCall("browser", { code: SCREENSHOT_CODE });
  return fauxAssistantMessage([call], { stopReason: "toolUse" });
}

/**
 * A pi harness with the persistent browser tool and code mode, over the fake
 * binding.
 */
export class PiBrowserTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  readonly #binding = createFakeBrowserBinding();
  readonly browser = new Browser({
    provider: browserRun(this.#binding.browser)
  });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.registry.install({
        name: "browser",
        tools: [
          browserTool({
            browser: this.browser,
            loader: this.env.LOADER
          })
        ]
      });
      this.registry.install(
        createCodemodeExtension({
          models: false,
          sandbox: createInlineCodemodeSandbox()
        })
      );
      return Harness.open(
        storage,
        {
          models: fauxModels(this.#faux.provider),
          registry: this.registry,
          settings: TEST_SETTINGS,
          onWake
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
