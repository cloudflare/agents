# Examples cleanup TODO

Tracked issues from the examples audit. See `AGENTS.md` in this folder for the conventions each example should follow.

## Missing README.md

- [x] `resumable-stream-chat/` — add README
- [ ] `x402/` — add README

## Add frontend + Vite plugin

All examples must be full-stack (frontend + backend). These worker-only examples need a frontend, `index.html`, `vite.config.ts`, and `src/client.tsx` added:

- [ ] `email-agent/` — add frontend demonstrating the email feature
- [ ] `mcp-elicitation/` — add frontend demonstrating MCP elicitation
- [ ] `mcp-server/` — add frontend demonstrating the MCP server
- [ ] `mcp-worker/` — add frontend demonstrating the MCP worker
- [ ] `mcp-worker-authenticated/` — add frontend demonstrating authenticated MCP
- [ ] `x402/` — add frontend demonstrating x402 payments
- [ ] `x402-mcp/` — add frontend demonstrating x402 MCP

## Vite plugin fix

- [ ] `cross-domain/` — add `@cloudflare/vite-plugin` to existing `vite.config.ts` (currently uses `@vitejs/plugin-react` only)

## Type declarations

- [ ] `x402/` — rename `worker-configuration.d.ts` to `env.d.ts`, regenerate with `npx wrangler types`
- [ ] `x402-mcp/` — rename `worker-configuration.d.ts` to `env.d.ts`, regenerate with `npx wrangler types`

## Missing env.d.ts

- [ ] `a2a/` — generate `env.d.ts` with `npx wrangler types`
- [ ] `email-agent/` — generate `env.d.ts` with `npx wrangler types`
- [ ] `mcp-worker-authenticated/` — generate `env.d.ts` with `npx wrangler types`

## Secrets examples

Standardise on `.env` / `.env.example` (not `.dev.vars` / `.dev.vars.example`).

- [ ] `github-webhook/` — rename `.dev.vars.example` to `.env.example`
- [ ] `mcp-client/` — rename `.dev.vars.example` to `.env.example`
- [x] `playground/` — rename `.dev.vars.example` to `.env.example`
- [x] `resumable-stream-chat/` — rename `.dev.vars.example` to `.env.example`
- [x] `tictactoe/` — rename `.dev.vars.example` to `.env.example`

## wrangler.jsonc assets cleanup

Remove unnecessary `"directory"` from assets — the Vite plugin handles the build output directory automatically.

- [ ] `codemode/wrangler.jsonc` — remove `"directory": "public"` from assets
- [ ] `github-webhook/wrangler.jsonc` — remove `"directory": "public"` from assets
- [x] `tictactoe/wrangler.jsonc` — remove `"directory": "public"` from assets
- [ ] `workflows/wrangler.jsonc` — remove `"directory": "public"` from assets
- [ ] `resumable-stream-chat/wrangler.jsonc` — remove `"directory": "dist"` and `"binding": "ASSETS"`, align with standard pattern

## SPA routing

Check which full-stack examples with client-side routing are missing `"not_found_handling": "single-page-application"` in their assets config:

- [ ] `codemode/` — audit whether it needs SPA fallback
- [ ] `github-webhook/` — audit whether it needs SPA fallback
- [x] `tictactoe/` — no client-side routing, not needed
- [ ] `workflows/` — audit whether it needs SPA fallback
