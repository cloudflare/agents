# Dynamic Puppeteer

Run Puppeteer scripts in dynamically loaded Workers while watching the Browser Run session through Live View. The example also includes an AI exploration mode that turns a natural language browser task into a script, explores with tool calls, then tests the submitted script in a fresh session.

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

This example uses remote Browser Run and Workers AI bindings. You must be logged in with Wrangler or provide Cloudflare credentials in your environment.

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

AI exploration is exposed as an Agent RPC method on the project agent:

```ts
const result = await project.call("explore", [
  "Explore https://example.com and write a script that verifies the page title."
]);
```

The RPC creates an exploratory Browser Run session, lets the model call `runExplorationScript` repeatedly against that session, accepts a final script through `submitScript`, then runs the final script once in a new Browser Run session and returns the trace, script, summary, and run result.

## Session Lifecycle

New sessions request Browser Run's 10 minute keep-alive timeout. Use **Stop session** to close the session immediately and remove it from the project session list.
