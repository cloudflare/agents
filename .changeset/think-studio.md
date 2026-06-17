---
"@cloudflare/think": minor
---

Add a runtime CLI: `think studio` and `think state`.

`think studio [agent] [instance]` launches Think Studio — a bundled local web app that connects (over WebSocket) to any running Think instance, local dev server or deployed Worker. Studio provides streaming chat (with tool calls and inline approve/reject for `needsApproval` tools) plus a read-only inspector showing the agent's identity, connection status, live state, recent history, and a turn/recovery status badge. The CLI serves the prebuilt SPA from a tiny `node:http` static server and opens the browser (`--port`, `--no-open`); the browser talks to the agent directly. `think state <agent> [instance]` prints the agent's identity, live state, and a recent history snapshot (`--json`, `--limit`).

Both commands share connection flags (`--url`, `--host`, `--protocol`, `--token`, `--query`, `--route-prefix`, `--root`), resolve friendly agent ids from the local manifest, and send the token as a query parameter (WebSocket upgrades can't set headers). Chatting in Studio drives a real, persisted turn against the live Durable Object.

The Think Vite plugin also registers an `s` dev-server shortcut (alongside Vite's built-in `r`/`u`/`o`/`c`/`q`) that launches Studio against the running `pnpm dev` server. Disable it with `studioShortcut: false`.
