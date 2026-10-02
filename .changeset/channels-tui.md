---
"agents": patch
---

Add `npx agents tui <url>`, a terminal client for a conversation's Web Channel.

It streams the transcript with highlighted Markdown, collapsible reasoning and tool cards, and shows messages and turns from every surface live. It answers approvals inline, lets a person type a client tool's result, and cancels the running turn with Esc. `--header` adds headers to the WebSocket upgrade, and `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are sent as an Access service token. Its dependencies are bundled into `dist/cli.js`, so installing `agents` adds none.
