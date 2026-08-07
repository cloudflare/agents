# Suggested SDK changes

This example now uses Think, Agents, and Code Mode as the sources of truth for
their own lifecycle state. The remaining application code highlights five
small framework opportunities. None is required to run the example.

| Priority | Gap                                                                                                | Current workaround                                                                                | Useful API                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Think has no single server-only capability policy.                                                 | Replace instructions/tools, set `activeTools`, force Code Mode, and guard `beforeToolCall`.       | An early allowlist that prevents unused tool classes and client tools from being assembled.                                                       |
| 2        | Code Mode has no first-class verified-result primitive or whole-output transform.                  | Stage by `executionId`, finalize in `disposeExecution`, then wrap the tool only to compact/check. | A result connector plus `transformOutput` for completed, paused, and error envelopes.                                                             |
| 3        | A parent cannot inspect/submit a retained child's Think turn through one framework call.           | Resolve the child, call its public submission/status RPC, and merge the child ID into the view.   | `submitSubAgentTurn` / `inspectSubAgentTurn` helpers built on the existing registry and submission queue.                                         |
| 4        | Existing state/workspace connectors cannot be renamed and restricted to bounded read methods.      | Maintain chunked inputs plus a custom `context` connector and causal activation metadata.         | A named, method-filtered/read-only state connector.                                                                                               |
| 5        | Standard chat admission cannot preserve this example's large-context and verified-result contract. | Maintain a small authenticated POST + poll hook in the Vite client.                               | A `useAgentChat`/routing admission hook for exact request binding, external payload staging, durable receipts, and authoritative terminal output. |

## 1. Server-only Think capabilities

Think assembles workspace, session, action, extension, skill, MCP, fetch, and
client-provided tools before `beforeTurn()`. Current controls are distributed
across several fields and hooks. A policy applied before tool conversion and
capability-prompt generation would make literal one-tool agents easier to
audit:

```ts
override capabilities = {
  allow: ["server:codemode"],
  clientTools: false
};
```

The exact shape matters less than ensuring disallowed tools are never assembled
or advertised. This would replace defensive configuration in `RlmBaseAgent`
and make a standard chat route safe from client tool injection.

## 2. First-class verified results and compact output

`kernel.finish` executes before the enclosing Code Mode program has reached a
terminal state. Code Mode already awaits
`CodemodeConnector.disposeExecution(executionId, status)` on completion, error,
rejection, and rollback, while correctly preserving state across a pause. This
example uses that hook to verify or discard durable answer candidates.

That hook is intentionally a teardown primitive: it may repeat and its errors
are swallowed. The connector therefore has to make result commitment durable
and idempotent itself. Also,
`CreateCodemodeRuntimeOptions.transformResult` reshapes only a successful
program result; it cannot compact paused/error envelopes while retaining the
full runtime audit. A first-class result protocol and whole-output transform
could remove both the candidate plumbing and the small compaction wrapper:

```ts
createExecuteRuntime({
  // ...
  result: verifiedResultConnector({
    stage: kernel.finish,
    commitOn: "completed"
  }),
  transformOutput: (output) => compactForModel(output)
});
```

The durable Code Mode facet should continue storing the complete unchanged
execution. An application-level metadata field would also help inspection
without copying audit rows into the parent.

## 3. Retained child-turn helpers

The existing pieces already provide the hard guarantees:

- `subAgent()` / `listSubAgents()` own the child registry;
- `submitMessages()` owns durable idempotent FIFO admission;
- `inspectSubmission()` owns child-turn status and recovery; and
- `runAgentTool()` owns stable one-shot runs.

A parent-facing convenience view could compose those contracts without asking
every example to publish child RPC methods:

```ts
await this.submitSubAgentTurn(RlmChildAgent, childId, messages, {
  submissionId,
  idempotencyKey: submissionId
});
await this.inspectSubAgentTurn(RlmChildAgent, childId, submissionId);
```

This would simplify `RlmThinkAgent.childStatus/listChildren/readChild` while
keeping the child submission as the only source of truth.

## 4. Filtered context state

`StateConnector` derives methods from a backend but has a fixed namespace and
no read-only/method filter. A named connector exposing only `stat`, bounded
read, glob, and search could hold external context in an existing durable
backend:

```ts
stateConnector(this.ctx, backend, {
  name: "context",
  methods: ["stat", "read", "search"],
  readOnly: true
});
```

The example would still keep request/input identity and the activation sequence
needed for exact replay and causal visibility, but could delete most chunk and
schema plumbing.

## 5. Durable custom chat admission

Using `useAgentChat` directly today would bypass properties this example needs:
20-million-character external payload staging, exact request-data binding,
recovery from an ambiguous POST, bearer authentication at the Worker boundary,
and serving only the verified `kernel.finish` value.

A routing/client hook that admits an external payload and returns a durable
receipt plus authoritative terminal projection would let the UI use the normal
Agents chat stack without weakening those contracts. Think Session history can
replace only the bounded visible transcript; it cannot replace the large input
store or activation visibility rules.

## Existing APIs used directly

The example already removes more code through existing APIs than these
proposals would:

- Think `submitMessages()` and `inspectSubmission()` replace a root request
  state machine and child queue mirror.
- Agents `listSubAgents()` is the retained-child registry; `runAgentTool()` is
  the one-shot query ledger.
- `CodemodeRuntimeHandle` remains the execution audit source of truth; the
  parent does not copy code, calls, logs, results, or statuses.
- Visible history is derived from activated inputs and verified answers rather
  than a second transcript table.
