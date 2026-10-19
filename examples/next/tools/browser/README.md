# Browser tool

A pi agent with a container workspace and a browser that stays open between
turns. The browser opens three sites nobody else can reach, on Browser Run
internal hostnames:

| Host               | Serves                                               | Model assigns                       |
| ------------------ | ---------------------------------------------------- | ----------------------------------- |
| `preview.internal` | A dev server in the workspace container              | `{ port }`, 1024 to 65535, not 8080 |
| `files.internal`   | Static files from a workspace folder, such as `dist` | `{ folder }`, under `/workspace/`   |
| `docs.internal`    | `DocsSite`, a Worker entrypoint with build docs      | Nothing: it always serves the same  |

The system prompt only points the model at `http://docs.internal/`. The docs
tell it how to scaffold a Vite app, configure its dev server, what site to
build, and how to preview it.

The example composes:

- `PiHarness` from `agents/harness/pi`, as in [`harnesses/pi`](../../harnesses/pi);
- a `Workspace` from `@cloudflare/computer` with a `ContainerBackend`:
  computerd mounts the workspace at `/workspace` in a Container, and `exec`
  is a Linux shell there;
- a `Browser` from `agents/browser` on Browser Run, with
  `guardrails: { allowedDomains: [] }` and the three internal hosts;
- `browserTool` from `agents/browser/pi`: the model writes CDP code and
  calls `hosts.assign()` to point a host somewhere;
- a Browser panel in the UI: Live View of the browser's tabs and each
  host's current target.

The model is Workers AI `@cf/moonshotai/kimi-k2.7-code`, set in
`src/shared.ts`. It accepts images, so it sees the screenshots the browser
tool returns.

## Run locally

```sh
pnpm install
pnpm run start
```

You need Docker running: the workspace container builds from the
`Dockerfile`. The `AI` and `BROWSER` bindings are remote and may incur
usage. No API keys. If your Wrangler login has more than one account, set
`CLOUDFLARE_ACCOUNT_ID`.

Internal hostnames only work deployed. Locally the browser starts without
them and logs a warning, so the agent can build but not open its sites.
Deploy with:

```sh
pnpm run deploy
```

## What to try

- `Build the site the docs describe, run it on the dev server, and show it to me in your browser.`
- `Now make a production build and show me the built site on files.internal.`
- `In /workspace, run npm create vinext-app@latest vinext-app -- --yes --use-npm --platform node --disable-git. Set up its dev server for preview.internal the way the docs say, start it, and show me the home page.`

The Browser panel beside the chat shows the browser live while the agent
works (on narrow screens, open it from the header). Screenshots the agent
takes show up in the chat.

## Core pattern

```ts
// Browser Run calls back into this Worker through InternalHostRouter.
export { CodemodeRuntime, InternalHostRouter } from "agents/browser";
export { DocsSite } from "./docs-site";

export class BrowserAgent extends withWorkspaceContainer(BrowserAgentBase) {
  readonly browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      guardrails: { allowedDomains: [] }, // internal hosts only
      internalHosts: {
        router: this.ctx.exports.InternalHostRouter,
        hosts: {
          "preview.internal": {
            description: "A dev server in your workspace container.",
            target: z.object({ port: z.number().int().min(1024) }),
            fetch: (request, { port }) =>
              this.getWorkspaceContainer().fetchPort(port, request)
          },
          "files.internal": {
            description: "Static files from a workspace folder.",
            target: filesTarget,
            fetch: (request, { folder }) =>
              serveWorkspaceFolder(this.workspace, request, folder)
          },
          "docs.internal": {
            description: "Your instructions for building things.",
            worker: this.ctx.exports.DocsSite
          }
        }
      }
    })
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.browser) // internal hosts need the Browser on the lifecycle
    .use(this.harness);

  // InternalHostRouter calls this. Agent has it built in.
  fetchInternalHost(message: InternalHostMessage) {
    return this.browser.fetchInternalHost(message);
  }
}
```

The model points a host with `hosts.assign()` in its browser code, then
navigates to the URL it returns. Targets are checked against the schema and
persist across turns, browser restarts, and redeploys.

## Details

- **Plain Durable Object.** `InternalHostRouter` delivers requests by
  calling `fetchInternalHost()` on the owning object. `Agent` has it built
  in; a plain `DurableObject` with `Lifecycle` adds it and passes the message
  to its `Browser`, as `BrowserAgent` does.
- **Dev server sync.** Files the model writes with `write` and `edit` reach
  the container on the next sync. `#fetchPreview` pushes the workspace on
  page loads, so a reload shows the latest files.
- **files.internal needs no container.** `src/files-host.ts` reads the
  Workspace's own files. The container backend ignores `node_modules` and
  `.vite` but syncs `dist`, so a build keeps working after the container
  sleeps.
- **Dev server config.** Internal hosts are plain http on port 80 with no
  WebSockets, so the docs have the model turn off HMR, allow the
  `preview.internal` Host header, listen on `0.0.0.0`, and start the server
  with `setsid nohup` so `exec` returns.
- **Port 8080** is computerd's, so the `preview.internal` schema rejects it.

Pi is MIT licensed; see [`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt).
