import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";
import puppeteer from "@cloudflare/puppeteer";

export class QAAgent extends AIChatAgent<Env> {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6"),
      system: `You are a QA testing agent that evaluates web pages against user-defined criteria.

When asked to check a page, follow this process:
1. Call run_page_check with the URL and a list of checks that will extract the data you need. Be thorough — extract headings, titles, body text, meta descriptions, and anything else relevant to the user's criteria.
2. Examine the returned data carefully.
3. Make a semantic judgment. You are NOT doing exact string matching — use your understanding of language and context. For example, if asked whether a title is "happy sounding", assess whether the words convey positivity, warmth, or cheerfulness.
4. Give a clear PASS or FAIL verdict, your reasoning, and the specific evidence from the extracted data.

Think like a human QA reviewer evaluating the spirit of a requirement, not just the letter of it.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        run_page_check: tool({
          description:
            "Load a web page with a real browser and extract structured data for QA analysis. Returns the content so you can make a semantic judgment.",
          inputSchema: z.object({
            url: z.string().describe("The URL to load and inspect"),
            checks: z
              .array(
                z.object({
                  type: z
                    .enum([
                      "text",
                      "texts",
                      "attribute",
                      "exists",
                      "count",
                      "title",
                      "url",
                    ])
                    .describe(
                      "text: innerText of first match; texts: innerText of all matches; attribute: element attribute value; exists: whether selector matches; count: number of matches; title: page <title> tag; url: final URL after redirects"
                    ),
                  selector: z
                    .string()
                    .optional()
                    .describe(
                      "CSS selector — required for text, texts, attribute, exists, count"
                    ),
                  attribute: z
                    .string()
                    .optional()
                    .describe('HTML attribute name — required for type "attribute"'),
                  name: z
                    .string()
                    .describe("Key name for this result in the returned data"),
                })
              )
              .describe("The data points to extract from the page"),
          }),
          execute: async ({ url, checks }) => {
            const browser = await puppeteer.launch(this.env.BROWSER);
            try {
              const page = await browser.newPage();
              await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              });

              const data: Record<string, unknown> = {};

              for (const check of checks) {
                try {
                  switch (check.type) {
                    case "title":
                      data[check.name] = await page.title();
                      break;

                    case "url":
                      data[check.name] = page.url();
                      break;

                    case "text": {
                      const el = await page.$(check.selector!);
                      data[check.name] = el
                        ? await el.evaluate(
                            (node) => node.textContent?.trim() ?? null
                          )
                        : null;
                      break;
                    }

                    case "texts": {
                      const els = await page.$$(check.selector!);
                      data[check.name] = await Promise.all(
                        els.map((el) =>
                          el.evaluate((node) => node.textContent?.trim() ?? "")
                        )
                      );
                      break;
                    }

                    case "attribute": {
                      const el = await page.$(check.selector!);
                      data[check.name] = el
                        ? await el.evaluate(
                            (node, attr) => node.getAttribute(attr),
                            check.attribute!
                          )
                        : null;
                      break;
                    }

                    case "exists": {
                      const el = await page.$(check.selector!);
                      data[check.name] = el !== null;
                      break;
                    }

                    case "count": {
                      const els = await page.$$(check.selector!);
                      data[check.name] = els.length;
                      break;
                    }
                  }
                } catch (err) {
                  data[check.name] = { error: String(err) };
                }
              }

              return { url: page.url(), data };
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
