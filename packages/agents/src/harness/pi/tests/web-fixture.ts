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
import { Lifecycle } from "../../../lifecycle";
import { WebFetchError } from "../../../web/fetch/source";
import { webFetchTool } from "../../../web/fetch/tools/pi";
import { webSearchTool } from "../../../web/search/tools/pi";
import { PiHarness } from "../index";
import { fauxModels, TEST_SETTINGS } from "./faux";
import { setWakeTimingForTests } from "../harness";
import { TEST_TIMING } from "./timing";

/**
 * A codemode script that searches, fetches every result in parallel, reads
 * the long one to its end with `nextOffset`, and catches a failed fetch.
 */
const CODEMODE_SCRIPT = `const found = await tools.web_search({ query: "workers" });
const pages = await Promise.all(found.items.map((item) => tools.web_fetch({ url: item.url })));
let long = pages[1];
const windows = [long.content];
while (long.nextOffset !== null) {
  long = await tools.web_fetch({ url: long.url, offset: long.nextOffset });
  windows.push(long.content);
}
let failed;
try { await tools.web_fetch({ url: "https://example.com/missing" }); } catch (error) { failed = error.message; }
return { query: found.query, titles: pages.map((page) => page.title), first: pages[0].content, windows: windows.length, failed };`;

/** Pages the fake fetch serves, by URL; the long one spans windows. */
const PAGES: Record<string, string> = {
  "https://example.com/short": "Short page.",
  "https://example.com/long": "x".repeat(250)
};

/**
 * The faux model calls `web_search` directly for any prompt, or `codemode`
 * with {@link CODEMODE_SCRIPT} for the prompt `codemode`, then answers with
 * the tool result's text.
 */
function script(context: TranscriptContext): AssistantMessage {
  const messages = context.messages.filter((m) => m.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([fauxText(`${last.toolName} returned`)]);
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
      : fauxToolCall("web_search", { query: "workers" });
  return fauxAssistantMessage([call], { stopReason: "toolUse" });
}

/**
 * A pi harness with `web_search` and `web_fetch` over fake sources, and code
 * mode.
 */
export class PiWebTestObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.registry.install({
        name: "web",
        tools: [
          webSearchTool({
            source: {
              search: async ({ query }) => ({
                items: Object.keys(PAGES).map((url) => ({
                  title: `Page ${url.slice(url.lastIndexOf("/") + 1)}`,
                  url,
                  description: "A page."
                })),
                metadata: { query, requestId: "r", latencyMs: 1 }
              })
            }
          }),
          webFetchTool({
            pageChars: 100,
            source: {
              fetch: async ({ url }) => {
                const content = PAGES[url];
                if (content === undefined) {
                  throw new WebFetchError(`Not found: ${url}`, {
                    status: 404,
                    code: "web_fetch_http_error",
                    url
                  });
                }
                return {
                  url,
                  finalUrl: url,
                  status: 200,
                  contentType: "text/plain",
                  via: "text",
                  content,
                  totalChars: content.length,
                  title: `Page ${url.slice(url.lastIndexOf("/") + 1)}`,
                  headers: {},
                  bytes: content.length,
                  redirects: []
                };
              }
            }
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
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    this.#faux.setResponses(Array.from({ length: 20 }, () => script));
  }

  /** The prompt's answer, and the stored tool result's text parts. */
  async prompt(text: string) {
    const response = await this.harness.prompt(text);
    const toolResult = response.messages
      .map((entry) => entry.model?.[0])
      .find((message) => message?.role === "toolResult");
    const parts =
      toolResult?.role === "toolResult"
        ? toolResult.content.flatMap((part) =>
            part.type === "text" ? [part.text] : []
          )
        : [];
    return { status: response.status, text: response.text, parts };
  }
}
