# Code Mode RLM

A Vite chat app for a durable Recursive Language Model built with
[`@cloudflare/think`](../../packages/think), the
[Agents SDK](../../packages/agents), and
[`@cloudflare/codemode`](../../packages/codemode).

The model sees one tool: `codemode`. Generated JavaScript treats long context
as a variable, keeps JSON notebook state across calls, delegates to retained
Think agents, and reads a small versioned continual harness. This is inspired
by Prime Agent; it is not Prime Agent and does not claim benchmark parity or
automatic self-improvement.

## The pattern

In abridged form, `beforeTurn()` creates an explicit Code Mode runtime and
replaces Think's tool surface:

```ts
const built = createExecuteRuntime({
  ctx: this.ctx,
  loader: this.env.LOADER,
  connectors: [context, kernel, rlm, harness],
  name: "think",
  globalOutbound: null
});

return {
  instructions: systemPrompt,
  messages: [{ role: "user", content: compactInputPointer }],
  tools: { codemode: built.tool },
  activeTools: ["codemode"],
  toolChoice: { type: "tool", toolName: "codemode" }
};
```

`beforeToolCall()` independently blocks every other tool. The generated Worker
receives no parent credentials, bindings, MCP/browser tools, durable filesystem,
or outbound network.

| Namespace   | Purpose                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| `context.*` | List, search, and slice current or prior causally visible inputs.                 |
| `kernel.*`  | Persist JSON notebook values and call the verified `finish` protocol.             |
| `rlm.*`     | On the root, await a one-shot child or admit/follow up with a retained child.     |
| `harness.*` | On the root, read supplemental guidance; write only in explicit refinement turns. |

Child turns intentionally receive only `context.*` and `kernel.*`. The root
harness guides delegation, while the admitted child prompt defines the
subtask.

Think owns root and child submission queues. Agents owns child facets,
registries, and one-shot agent-tool runs. Code Mode owns generated-code replay
and execution audit. The example keeps only state unique to the RLM: chunked
external inputs, notebook values, answer candidates, recursive operation keys,
and harness revisions.

`kernel.finish()` first stages an answer against the enclosing Code Mode
execution ID. `KernelConnector.disposeExecution()` verifies it only when that
same execution completes, keeps it across a pause, and discards it on terminal
failure. Recursive operation IDs derive from the active input, operation kind,
child when relevant, and caller key, so Code Mode replay does not repeat child
work or budget charges.

## Run locally

Requires Node.js 24+, pnpm, a Cloudflare account with Workers AI, and Dynamic
Workers access.

```bash
pnpm install
pnpm run start
```

Open the Vite URL and choose a durable session name. Local Vite development
does not require authentication. The bypass is guarded by `import.meta.env.DEV`
and is removed from production builds, where `API_TOKEN` remains required.

The chat admits each turn with a stable request ID and polls its durable Think
submission. A reload resumes an ambiguous or running request. The UI does not
fake token streaming: the assistant message appears only after verified
completion.

## Compare it with basic Think

The bundled [ARC-AGI-2 smoke evaluator](./eval/README.md) runs the RLM and a
basic Think control on the same redacted public-evaluation tasks.
It downloads a pinned, mechanically selected three-task subset, keeps test
answers only in the scorer, gives every trial a fresh durable session, and
reports exact-grid accuracy plus latency and recursive-call count.

The baseline is direct Think reasoning over the full redacted puzzle. Its only
active tool is a schema-neutral terminal-answer tool, so both conditions have
an explicit completion protocol without giving the baseline an ARC-specific
helper.

With the development server running, launch the comparison in another terminal:

```bash
pnpm run eval:arc
```

This is a reproducible development comparison, not an official or
contamination-resistant ARC-AGI-2 benchmark score.

### HTTP example

The local session API is also available to curl without a token:

```bash
curl -sS http://localhost:5173/sessions/demo/think \
  -H 'content-type: application/json' \
  --data '{
    "requestId": "research-001",
    "task": "Compare the claims and give an evidence-led conclusion.",
    "context": "Large source material goes here."
  }'

curl -sS \
  'http://localhost:5173/sessions/demo/requests?requestId=research-001'
```

To run an explicit, rollbackable continual-harness review:

```bash
curl -sS http://localhost:5173/sessions/demo/refine \
  -H 'content-type: application/json' \
  --data '{
    "requestId": "refine-001",
    "instructions": "Review recent citation failures and make at most one narrow change."
  }'
```

Task plus context may contain up to 20 million characters. Only one browser
turn is admitted at a time to preserve conversational ordering. In production
this is a single-operator example: every `/sessions/*` route uses one bearer
token. Production multi-tenancy needs per-session authorization, cost limits,
and retention policy.

A refinement may make one idempotent, optimistic harness mutation affecting at
most 12 entries. Rollback is available only inside that explicit refinement
turn and creates a new monotonic revision.

## Verify and deploy

```bash
pnpm run types
pnpm test
pnpm run typecheck
pnpm run build
pnpm exec wrangler deploy --dry-run
```

Deploy with `pnpm wrangler secret put API_TOKEN` followed by `pnpm deploy`.

Read the contributor-facing [design document](../../design/codemode-rlm.md),
the [research and fidelity notes](./RESEARCH.md), and the
[suggested SDK improvements](./SUGGESTED_SDK_CHANGES.md). Related examples:
[`codemode`](../codemode), [`agents-as-tools`](../agents-as-tools), and
[`think-submissions`](../think-submissions).
