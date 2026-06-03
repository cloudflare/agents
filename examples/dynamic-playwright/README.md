# Dynamic Playwright

Scratch worker for testing `@cloudflare/playwright` inside dynamically loaded Workers.

The worker accepts a JavaScript async function as the raw request body on any path:

```js
async ({ browser }) => {
  // ...
};
```

The host bundles a dynamic Worker with `@cloudflare/worker-bundler`, loads it with `env.LOADER`, launches a browser from the Browser Rendering binding, and invokes the submitted function with `{ browser }`. `console.log`, `console.warn`, and `console.error` are captured automatically.

## Run

```bash
npm install
npm start
```

In another terminal:

```bash
./scripts/run.sh scripts/cases/01-launch-and-title.js
```

This example uses a remote Browser Rendering binding. You must be logged in with Wrangler or provide Cloudflare credentials in your environment.

## Cases

```bash
./scripts/run-all.sh
```

The cases are small scripts intended for quick iteration. They launch a real browser session, so they may take a few seconds and consume Browser Rendering quota.
