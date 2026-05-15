# Examples cleanup TODO

Tracked issues from the examples audit. See `AGENTS.md` in this folder for the conventions each example should follow.

## Missing README.md

- [x] `resumable-stream-chat/` — add README
- [x] `x402/` — add README

## Add frontend + Vite plugin

Most examples should be full-stack (frontend + backend). Focused server-only MCP examples stay minimal when the server setup is the point:

- [x] `email-agent/` — added a full-stack Email Service demo UI
- [x] `mcp-elicitation/` — restored server-only elicitation example for MCP clients
- [x] `mcp-server/` — restored raw transport server-only example
- [x] `mcp-worker/` — added MCP tool tester frontend
- [x] `mcp-worker-authenticated/` — added info page with endpoint docs
- [x] `x402/` — added React+Kumo frontend with "Fetch & Pay" UI
- [x] `x402-mcp/` — added React+Kumo frontend with tool forms and payment modal

## Vite plugin fix

- [ ] `cross-domain/` — add `@cloudflare/vite-plugin` to existing `vite.config.ts` (currently uses `@vitejs/plugin-react` only)

## Type declarations

- [x] `x402/` — renamed `worker-configuration.d.ts` to `env.d.ts`, regenerated
- [x] `x402-mcp/` — renamed `worker-configuration.d.ts` to `env.d.ts`, regenerated

## Missing env.d.ts

- [ ] `a2a/` — generate `env.d.ts` with `npx wrangler types`
- [x] `email-agent/` — generated `env.d.ts`
- [x] `mcp-worker-authenticated/` — generated `env.d.ts`

## Secrets examples

Standardise on `.env` / `.env.example` (not `.dev.vars` / `.dev.vars.example`).

- [ ] `github-webhook/` — rename `.dev.vars.example` to `.env.example`
- [x] `mcp-client/` — renamed `.dev.vars.example` to `.env.example`
- [x] `playground/` — renamed `.dev.vars.example` to `.env.example`
- [x] `resumable-stream-chat/` — renamed `.dev.vars.example` to `.env.example`
- [x] `tictactoe/` — renamed `.dev.vars.example` to `.env.example`

## SPA routing

Check which full-stack examples with client-side routing are missing `"not_found_handling": "single-page-application"` in their assets config:

- [ ] `codemode/` — audit whether it needs SPA fallback
- [ ] `github-webhook/` — audit whether it needs SPA fallback
- [x] `tictactoe/` — no client-side routing, not needed
- [ ] `workflows/` — audit whether it needs SPA fallback

## Kumo migration

Migrate examples to use Kumo components and Tailwind.

- [x] `mcp/` — migrated from Hello World to full Kumo tool tester
- [x] `mcp-client/` — migrated from custom CSS to Kumo, replaced agentFetch with @callable
- [x] `mcp-worker/` — added Kumo frontend
- [x] `mcp-worker-authenticated/` — added Kumo frontend
- [x] `mcp-elicitation/` — intentionally server-only; elicitation requires an MCP client
- [x] `x402/` — migrated from worker-only to Kumo frontend
- [x] `x402-mcp/` — migrated from inline HTML to React+Kumo, replaced raw WebSocket with useAgent
