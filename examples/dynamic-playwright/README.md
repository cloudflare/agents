# Dynamic Puppeteer

Run Puppeteer scripts in dynamically loaded Workers while watching the Browser Run session through Live View.

The app accepts a JavaScript module that default-exports an async function:

```js
export default async ({ page }) => {
  await page.goto("https://example.com");
  return await page.title();
};
```

The host Worker uses a project-scoped `Project` Agent to sync session and Live View state to the browser, plus one `BrowserSession` Durable Object per Browser Run session. Pasted modules are bundled as `src/user.js`; the session Durable Object runs them through a dynamic Worker connected to that session and passes a single persistent Puppeteer `page` into user code.

## Run

```bash
npm install
npm start
```

Open the local Vite URL, create or select a session, paste a script, and click **Run**. New sessions use Browser Run's 10 minute keep-alive window. The iframe shows the session page through Browser Run Live View.

This example uses a remote Browser Run binding. You must be logged in with Wrangler or provide Cloudflare credentials in your environment.

## Key Pattern

```ts
const acquireResponse = await env.BROWSER.fetch(
  "http://fake.host/v1/acquire?keep_alive=600000"
);
const { sessionId } = await acquireResponse.json();
const targetsResponse = await env.BROWSER.fetch(
  `http://fake.host/v1/devtools/browser/${sessionId}/json/list`
);
const targets = await targetsResponse.json();
```

Each page target includes a `devtoolsFrontendUrl` that can be embedded as the Live View iframe URL. The app uses the first non-blank page target and avoids exposing `browser` to user scripts so runs stay focused on a single page.

## Session Lifecycle

New sessions request Browser Run's 10 minute keep-alive timeout. Use **Stop session** to close the session immediately and remove it from the project session list.
