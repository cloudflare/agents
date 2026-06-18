# Browser Live View

A [Think](https://developers.cloudflare.com/agents/) agent that drives a real
Chrome browser over the Chrome DevTools Protocol and **hands off to a human**
when a step needs one — logging in, solving a CAPTCHA, multi-factor auth, or
entering sensitive data — using [Browser Run Live View](https://developers.cloudflare.com/browser-run/features/live-view/).

## What it demonstrates

- The agent's `execute` tool exposes the `cdp.*` connector (a live browser). The
  model calls `cdp.getLiveViewUrl()` to mint a link a human can open to watch and
  control the session in real time.
- The host-side `connector.liveView()` helper, surfaced through a `liveView()`
  callable, drives the **Live browser** panel — it lists the shared session's
  open tabs and their Live View URLs.
- A `reuse`-mode browser session that persists across turns, so a page the agent
  opens stays open while the human acts, and the next turn continues against the
  same tabs and cookies.

The handoff pattern: the agent opens a page → surfaces a Live View link → you
complete the step in the Live browser panel → you tell the agent to continue.

## Running

```bash
pnpm install        # from the repo root
pnpm run start      # from this directory
```

Open the printed URL and try:

- "Open example.com and tell me the page title."
- "Go to a login page and let me sign in, then read my account name."

Then open the **Live browser** panel, complete the step, and reply "continue".

> [!NOTE]
> Live View URLs are minted by the real Browser Run service, so this example
> runs the `browser` (and `AI`) bindings in **remote** mode even during local
> `pnpm run start`. You need a Cloudflare account (`wrangler login`). Live View
> is not available against the local Browser Rendering simulator.

## How it works

`src/server.ts` — a `Think` agent:

```ts
getTools() {
  return {
    // cdp.* (incl. cdp.getLiveViewUrl) from env.BROWSER; reuse = one shared session
    execute: createExecuteTool(this, { session: { mode: "reuse", key: "main" } })
  };
}

@callable()
async liveView() {
  return (await this.#browser().liveView({ mode: "tab" })) ?? null;
}
```

`src/client.tsx` — a chat UI (`useAgent` + `useAgentChat`) plus a Live browser
panel that polls `liveView()` and renders the session as a **tabbed browser**: a
tab strip across the top (labelled by page title, falling back to the hostname
via each target's `pageUrl`) and the selected tab embedded below in a single
iframe. The embedded Live View ships its own back/forward/refresh controls and
URL bar, so the panel just hosts the selected tab and auto-embeds one. The
selection is keyed by stable `targetId`, so the background refresh that re-mints
Live View URLs never reloads the iframe out from under a human mid-task. An
"Open" link is offered as a fallback (some pages block embedding).

The Worker entry re-exports the codemode runtime facet that backs the execute
tool:

```ts
export { CodemodeRuntime } from "agents/browser";
```

## Configuration

`wrangler.jsonc` binds Workers AI (`AI`), Browser Run (`BROWSER`, remote), and a
Worker Loader (`LOADER`) for the sandboxed `execute` tool.

## Related

- [`examples/ai-chat`](../ai-chat/) — browser tools on `AIChatAgent`
- [`examples/assistant`](../assistant/) — Think + `createExecuteTool` with a
  workspace and GitHub auth
- [Browse the Web](../../docs/browse-the-web.md) — the browser tools guide
