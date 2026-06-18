# Start here

Paste this file into your AI coding agent (Cursor, Claude, Codex, etc.) and ask
it to help you build. It is a guided tour of this Think app and the rules for
changing it safely.

## What this is

A [Think](https://www.npmjs.com/package/@cloudflare/think) agent running on
Cloudflare Workers. Each agent is a **Durable Object** — an addressable,
hibernatable actor with its own SQLite database. You get one durable agent per
user, account, conversation, or task, cheap while idle. Think handles the
agentic loop, message persistence, streaming, tools, and turn recovery for you.

## Layout

```
agents/<name>/agent.ts   # your agent: a class that extends Think
src/client.tsx           # React chat UI (useAgent + useAgentChat)
src/server.ts            # optional custom Worker entry (runs before the router)
wrangler.jsonc           # Worker + Durable Object config
think.d.ts               # GENERATED — types for agents and bindings
env.d.ts                 # GENERATED — types for Wrangler bindings
```

Agents are discovered by convention from `agents/`. The Vite plugin
(`@cloudflare/think/vite`) generates the Worker entry (`virtual:think/entry`) and
routing — there is no hand-written `fetch` boilerplate unless you add
`src/server.ts`.

## Run it

```sh
npm install
npm run dev
```

Open the printed URL. Deploy with `npm run deploy`.

## Common changes

- **Change the model:** edit `getModel()` in the agent. Models come from
  [Workers AI](https://developers.cloudflare.com/workers-ai/models/) via the `AI`
  binding — prefer Workers AI over third-party APIs.
- **Add a tool:** return it from `getTools()` using `tool({ ... })` from `ai`.
  Add `needsApproval` for actions a human should sign off on.
- **Give it memory:** override `configureSession()` and add a `withContext(...)`
  block the model can read and update across turns.
- **Run it proactively:** override `getScheduledTasks()` with
  `defineScheduledTasks({ ... })` for recurring, prompt-driven turns.
- **Accept webhooks / custom routes:** add a `src/server.ts` with a default
  export `{ fetch(request, env, ctx, { router }) }`; return a `Response` to
  handle, or `undefined` to fall through to Think.

## Rules

- After changing agents or Wrangler bindings, run `npm run types` to regenerate
  `think.d.ts` and `env.d.ts`. **Do not edit those files by hand.**
- Export exactly one agent class per convention file (`agents/<name>/agent.ts`).
- Use TypeScript and ES modules only. Never hardcode secrets — use
  `wrangler secret put` or `.dev.vars`.
- Keep using Cloudflare primitives (Durable Objects, Workers AI, KV, D1, R2)
  rather than third-party equivalents.

## Learn more

- Think docs: https://developers.cloudflare.com/agents/
- Other starters: `npm create think -- --template <name>`
  (`basic`, `personal-assistant`, `customer-support`, `coding-agent`,
  `webhook-agent`, `business-workflow`)
