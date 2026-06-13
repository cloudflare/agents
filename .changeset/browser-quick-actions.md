---
"agents": patch
"@cloudflare/think": patch
---

Add Browser Run Quick Actions to the browser tools: stateless, one-shot
browsing that needs only the `browser` binding — no Durable Object, loader, or
sandbox. New primitives in `agents/browser` (`browserMarkdown`,
`browserExtract`, `browserLinks`, `browserScrape`, `browserContent`,
`browserSnapshot`, `browserScreenshot`, `browserPdf`, plus `runQuickAction`)
wrap the `quickAction()` binding and unwrap its `{ success, result }` envelope.
A new `createQuickActionTools({ browser })` (from `agents/browser/ai`) returns
AI SDK tools (`browser_markdown`, `browser_extract`, `browser_links`,
`browser_scrape`, opt-in `browser_content`) so an agent can read a page as
Markdown, extract structured data with AI, or list/scrape elements in a single
call. Every result is bounded to `maxChars` (text truncated, oversized
arrays/objects summarized) to protect the context window, and host-only request
options (`cookies`, `authenticate`, `gotoOptions`, `viewport`, …) can be passed
once via `options` for authenticated or JavaScript-heavy pages without exposing
them to the model. `createBrowserTools`/`createBrowserRuntime` now expose these tools alongside the
durable `browser_execute` tool **by default** whenever a `browser` binding is
present (pass `quickActions: false` to opt out), and they resolve `ctx` from the
current Agent via `getCurrentAgent()` so `ctx` no longer has to be passed
explicitly from inside an Agent. Result bounding is shape-stable — arrays stay
arrays (trimmed), so the model sees a consistent type, except when even the
first element overflows the budget, where the result degrades to the
truncated-preview summary rather than a misleading empty array.
`runQuickAction`'s `params` are now typed per action. `@cloudflare/think/tools/browser` re-exports
`createQuickActionTools` and the Quick Action primitives/types so a Think agent
can expose them from `getTools()` with a single import. Quick Actions require a
Worker `compatibility_date` of `2026-03-24`+ and `remote: true` on the browser
binding for local `wrangler dev`.
