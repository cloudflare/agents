# Browser Quick Actions

Read the web with Browser Run [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) — stateless, one-shot browser tasks that need only the `BROWSER` binding (no Durable Object, Worker Loader, sandbox, or CDP session).

Enter a URL and pick an action: render the page to **Markdown**, list its **Links**, **Extract** structured data with AI, capture a **Screenshot**, or **Ask AI** — which hands the same Quick Actions to a model (via Workers AI) as tools and lets it browse to answer your question.

## Run it

```sh
pnpm install
pnpm run start
```

Quick Actions run on the real Browser Run service, so the `BROWSER` binding is configured with `"remote": true`. The Worker's `compatibility_date` must be `2026-03-24` or later (the minimum for `quickAction`); this example uses `2026-06-11`. No API token is needed — the binding handles auth.

## The pattern

Quick Actions are exposed as small helpers on the `agents/browser` entry. Here the agent wraps a few of them as `@callable` methods:

```ts
import { browserMarkdown, browserExtract } from "agents/browser";

export class QuickActionsAgent extends Agent<Env> {
  @callable()
  async toMarkdown(url: string) {
    return browserMarkdown(this.env.BROWSER, { url });
  }

  @callable()
  async extract(url: string, prompt: string) {
    return browserExtract(this.env.BROWSER, { url, prompt });
  }
}
```

To let a model decide when to browse, use the AI SDK tools instead — this is what the **Ask AI** action does (see the `ask` method in `src/server.ts`):

```ts
import { createQuickActionTools } from "agents/browser/ai";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const workersai = createWorkersAI({ binding: this.env.AI });
const tools = createQuickActionTools({ browser: this.env.BROWSER });
// browser_markdown, browser_extract, browser_links, browser_scrape

const { text } = await generateText({
  model: workersai("@cf/moonshotai/kimi-k2.6"),
  prompt: `Page: ${url}\n\nQuestion: ${question}`,
  tools,
  stopWhen: stepCountIs(6)
});
```

## Related examples

- [`browser-live-view`](../browser-live-view) — a stateful CDP agent that hands off to a human via Live View. Use Quick Actions for one-shot reads and `browser_execute` for interactive sessions.
