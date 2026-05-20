import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";
import puppeteer from "@cloudflare/puppeteer";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";

const SCRIPT_DESCRIPTION = `Run a Puppeteer script against a real browser and return a structured result for QA analysis.

Write an async arrow function in JavaScript (not TypeScript). The \`page\` object is available as a global.

Available methods:
  page.goto(url, options?)         — navigate; waitUntil defaults to "domcontentloaded"
  page.title()                     — get the page <title>
  page.url()                       — get the current URL after redirects
  page.click(selector)             — click an element
  page.type(selector, text)        — type into an input
  page.waitForSelector(selector)   — wait for an element to appear
  page.evaluate(expression)        — evaluate a JS string expression in the browser
  page.getText(selector)           — innerText of the first matching element (or null)
  page.getTexts(selector)          — array of innerText for all matching elements
  page.getAttr(selector, attr)     — attribute value of the first matching element

Note: page.evaluate() takes a string expression, not a function.

The script's return value is JSON-stringified and returned as the tool result.

Example:
async () => {
  await page.goto("https://example.com");
  const title = await page.title();
  const heading = await page.getText("h1");
  const paragraphs = await page.getTexts("p");
  const metaDesc = await page.getAttr("meta[name='description']", "content");
  return { title, heading, paragraphs, metaDesc };
}`;

export class QAAgent extends AIChatAgent<Env> {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6"),
      system: `You are a QA testing agent that evaluates web pages against user-defined criteria.

When asked to check a page:
1. Write a Puppeteer script that extracts the data you need to evaluate the user's criteria. Be thorough — extract titles, headings, body text, meta descriptions, and any other relevant content.
2. Call run_puppeteer_script with your script.
3. Examine the returned data carefully.
4. Make a semantic judgment — NOT exact string matching. Use your understanding of language and context. For example, if asked whether a title is "happy sounding", assess whether the words convey positivity, warmth, or cheerfulness.
5. Give a clear PASS or FAIL verdict, your reasoning, and the specific evidence from the page data.

Think like a human QA reviewer: evaluate the spirit of a requirement, not just the letter.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        run_puppeteer_script: tool({
          description: SCRIPT_DESCRIPTION,
          inputSchema: z.object({
            script: z
              .string()
              .describe(
                "An async arrow function in JavaScript that uses the page object and returns a JSON-serializable value"
              ),
          }),
          execute: async ({ script }) => {
            const browser = await puppeteer.launch(this.env.BROWSER);
            try {
              const page = await browser.newPage();

              const executor = new DynamicWorkerExecutor({
                loader: this.env.LOADER,
                timeout: 30_000,
              });

              const result = await executor.execute(script, [
                {
                  name: "page",
                  fns: {
                    goto: async (url: unknown, opts?: unknown) =>
                      page.goto(
                        url as string,
                        (opts as Parameters<typeof page.goto>[1]) ?? {
                          waitUntil: "domcontentloaded",
                        }
                      ),
                    title: async () => page.title(),
                    url: async () => page.url(),
                    click: async (selector: unknown) =>
                      page.click(selector as string),
                    type: async (selector: unknown, text: unknown) =>
                      page.type(selector as string, text as string),
                    evaluate: async (expression: unknown) =>
                      page.evaluate(expression as string),
                    waitForSelector: async (
                      selector: unknown,
                      opts?: unknown
                    ) =>
                      page.waitForSelector(
                        selector as string,
                        opts as Parameters<typeof page.waitForSelector>[1]
                      ),
                    getText: async (selector: unknown) => {
                      const el = await page.$(selector as string);
                      return el
                        ? el.evaluate(
                            (n: Element) => n.textContent?.trim() ?? null
                          )
                        : null;
                    },
                    getTexts: async (selector: unknown) => {
                      const els = await page.$$(selector as string);
                      return Promise.all(
                        els.map((el) =>
                          el.evaluate(
                            (n: Element) => n.textContent?.trim() ?? ""
                          )
                        )
                      );
                    },
                    getAttr: async (selector: unknown, attr: unknown) => {
                      const el = await page.$(selector as string);
                      return el
                        ? el.evaluate(
                            (n: Element, a: string) => n.getAttribute(a),
                            attr as string
                          )
                        : null;
                    },
                  },
                },
              ]);

              if (result.error) return `Error: ${result.error}`;
              return typeof result.result === "string"
                ? result.result
                : JSON.stringify(result.result, null, 2);
            } finally {
              await browser.close();
            }
          },
        }),
      },
      stopWhen: stepCountIs(10),
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
