# Code Mode RLM

A Vite chat app for a think-only Recursive Language Model built with [`@cloudflare/think`](../../packages/think), the [Agents SDK](../../packages/agents), and [`@cloudflare/codemode`](../../packages/codemode).

The model can call exactly one tool: `codemode`. Generated JavaScript reaches external context, durable notebook state, recursive children, and a guarded continual harness through four connector namespaces. This is inspired by Prime Agent; it is not Prime Agent and does not claim benchmark parity or autonomous self-improvement.

The React frontend is a chat experience over the RLM request protocol. It uses authenticated HTTP admission and polling instead of Think's generic WebSocket chat route, preserving external-input storage, request idempotency, and verified completion. The bearer token stays in browser session storage and is never exposed through a `VITE_*` variable.

## Key pattern

The important boundary is in `beforeTurn`: construct Code Mode explicitly, replace the capability prompt, and activate only the canonical tool.

```ts
const built = createExecuteRuntime({
  ctx: this.ctx,
  loader: this.env.LOADER,
  connectors: [context, kernel, rlm, harness],
  name: "think",
  globalOutbound: null
});

return {
  instructions: rlmSystemPrompt,
  messages: [{ role: "user", content: compactInputPointer }],
  tools: { codemode: built.tool },
  activeTools: ["codemode"],
  toolChoice: { type: "tool", toolName: "codemode" }
};
```

`beforeToolCall` also blocks every other server-side tool. The explicit runtime gives generated code no parent Think workspace, browser/MCP/fetch tools, environment bindings, credentials, host filesystem, durable filesystem, or outbound network. Standard Worker/Node-compat ambient APIs can still exist—including `process`, `Buffer`, and an ephemeral sandbox virtual filesystem—so privileged and persistent effects must cross a connector.

## How it maps to an RLM

| Namespace   | Role                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `context.*` | Search and slice current or prior external inputs and bounded transcript records.                  |
| `kernel.*`  | Persist JSON notebook values and call the environment-backed `finish` protocol.                    |
| `rlm.*`     | Await a one-shot child, admit a retained child, submit follow-ups, and inspect bounded results.    |
| `harness.*` | Read versioned prompt/memory/skill/sub-agent supplements; write only in explicit refinement turns. |

Large task material is chunked in Durable Object SQLite rather than inserted into model messages. Code Mode runs each program in a fresh isolated Worker, so `kernel.*` supplies semantic persistence—not a literal IPython heap.

`rlm.query` uses an idempotent `runAgentTool` child turn. `rlm.spawn` and `rlm.followup` use a named Think child plus its durable submission queue. Retained children preserve their own external inputs, transcript, Session, Code Mode facet, and kernel. Depth is capped at one.

Every recursive mutation requires a short caller key. Its durable operation identity is derived from the active external input, operation kind, child when relevant, and key. A separate argument hash rejects key reuse with different data. Code Mode execution IDs are retained only as provenance, so a recovered turn can reissue a program without duplicating child work or budget charges.

Completion is valid only when all of these agree:

- `kernel.finish({ content })` stored an answer for the active input;
- Code Mode reached `completed`;
- the execution ledger binds that execution to the active scope, input, and mode.

Code Mode’s terminal connector lifecycle finalizes this binding before the outer tool wrapper returns. The API serves the stored answer, never unverified assistant prose.

## Run locally

Requires Node.js 24+, pnpm, a Cloudflare account with Workers AI, and Dynamic Workers access.

```bash
pnpm install
cp .env.example .env
# Set API_TOKEN in .env, then enter the same value in the app.
export RLM_API_TOKEN='replace-with-your-local-token'
pnpm dev
```

Open the URL printed by Vite, choose a durable session name, and enter the local `API_TOKEN`. The composer accepts a normal chat task plus optional large context. Only one turn is admitted at a time so the UI can preserve conversational ordering; it displays `admitted` and `running` honestly rather than simulating token streaming before the verified answer exists.

Root turns are durable asynchronous submissions. Supply a stable `requestId`; retrying the same request is safe, while changed arguments are rejected.

```bash
curl -sS http://localhost:8787/sessions/demo/think \
  -H "authorization: Bearer $RLM_API_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "requestId": "research-001",
    "task": "Compare the claims and give an evidence-led conclusion.",
    "context": "Large source material goes here."
  }'

curl -sS \
  'http://localhost:8787/sessions/demo/requests?requestId=research-001' \
  -H "authorization: Bearer $RLM_API_TOKEN"
```

Admission returns HTTP 202 with `admitted` or `running`; polling eventually returns `completed` plus the durable answer, or `error`. `material` is an alias for `context`; task plus material may contain up to 20 million characters.

Session names are routing keys, not credentials. Every session route requires the bearer token, and the Worker intentionally does not expose Think’s generic WebSocket route because it would bypass external-input admission.

This is a single-operator example: the same token authorizes task submission and administrative refinement, rollback, and snippet promotion. A multi-user production service must add per-tenant session authorization and separate control-plane roles or credentials for administrative routes.

For deployment:

```bash
pnpm wrangler secret put API_TOKEN
pnpm deploy
```

## API

| Method         | Path                                   | Purpose                                               |
| -------------- | -------------------------------------- | ----------------------------------------------------- |
| `POST`         | `/sessions/:id/think`                  | Idempotently admit a root RLM request.                |
| `POST`         | `/sessions/:id/refine`                 | Admit an explicit harness-refinement request.         |
| `GET`          | `/sessions/:id/requests?requestId=...` | Poll a durable root request.                          |
| `GET`          | `/sessions/:id`                        | Inspect model, limits, children, and harness summary. |
| `GET`          | `/sessions/:id/history`                | Read bounded external transcript records.             |
| `GET`          | `/sessions/:id/children`               | Refresh retained child handles.                       |
| `GET`          | `/sessions/:id/executions`             | Inspect bounded Code Mode execution summaries.        |
| `GET` / `POST` | `/sessions/:id/snippets`               | List or developer-promote successful programs.        |
| `GET`          | `/sessions/:id/harness`                | Inspect harness state and revisions.                  |
| `POST`         | `/sessions/:id/rollback`               | Restore an earlier entry snapshot as a new revision.  |

`/refine` can create versioned `prompt`, `memory`, `skill`, and `subagent` supplements. The immutable base prompt cannot be edited, and executable skills must reference a developer-promoted Code Mode snippet. Snippet names are durably reserved before promotion and are immutable: changed programs use a new versioned name. A session can retain at most 20 promoted or reserved snippets; an ambiguous failed promotion conservatively keeps its name and slot reserved. API listings return bounded metadata rather than source code. Refinement is explicit and rollbackable, but this example does not run held-out evaluation or stage connector mutations until end-of-turn; see the limitations in [RESEARCH.md](./RESEARCH.md).

Defaults live in [`wrangler.jsonc`](./wrangler.jsonc): 12 model steps, depth one, eight new recursive operations per root input, four concurrent agent-tool runs, and a 180-second outer turn budget. The executor and children receive smaller fractions so the parent retains completion headroom. Production use still needs aggregate token/cost budgets and retention policies.

## Verify

```bash
pnpm run types
pnpm test
pnpm run typecheck
pnpm run build
pnpm exec wrangler deploy --dry-run
```

From the repository root, run `pnpm run check`.

For the contributor-facing architecture, read [`design/codemode-rlm.md`](../../design/codemode-rlm.md). For the source research and fidelity limits, read [RESEARCH.md](./RESEARCH.md). Related examples: [`codemode`](../codemode), [`agents-as-tools`](../agents-as-tools), and [`think-workflows`](../think-workflows).
