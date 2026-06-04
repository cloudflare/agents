Status: accepted

# Dynamic Browser Scripts: Puppeteer over Playwright

## The problem

`examples/dynamic-playwright` lets an agent write JavaScript browser automation code, run it in a dynamically loaded Worker, inspect the result, then run another script against the same Browser Run session later. This workflow is important to allow the agent to iteratively refine its script. 

For this workflow, reconnecting to the same Browser Run session must expose the existing page. The agent should be able to write one script that navigates or mutates the page, then write a later script that continues from that page state.

## The proposal

Use `@cloudflare/puppeteer` for dynamic browser scripts instead of `@cloudflare/playwright`.

Each dynamic Worker connects to the existing Browser Run session with `puppeteer.connect(env.BROWSER, sessionId)`, selects `await browser.pages()[0]` or creates a page only if none exists, and calls `browser.disconnect()` after the script finishes. The browser session remains alive for the configured Browser Run keep-alive window.

## The alternatives

- Keep `@cloudflare/playwright` and reconnect per dynamic Worker run. Rejected because isolated repros showed each fresh dynamic Worker connection sees `browser.contexts().pages()` as empty and creates a new page target. This is a deliberate playwright design decision, see: https://github.com/microsoft/playwright/issues/4956
- Keep a Playwright `Page` alive inside a Durable Object. Rejected because the page object cannot be passed into the dynamic Worker, and executing arbitrary generated code inside the Durable Object weakens isolation.
- Proxy a Playwright-like page API from the dynamic Worker back to a Durable Object. Rejected for now because it would require building and maintaining a large compatibility surface.

## The decision

Use Puppeteer for dynamic browser scripts. Puppeteer supports disconnecting from a Browser Run session while leaving the page available for later connections, and isolated repros confirmed that two dynamic Worker runs can reuse the same Browser Run page target.

The user-facing script contract remains intentionally small:

```js
export default async ({ page }) => {
  await page.goto("https://example.com");
  return await page.title();
};
```

The `page` object is Puppeteer's `Page`, not Playwright's `Page`.
