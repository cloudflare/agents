# Research notes: Prime Agent, RLMs, Think, and Code Mode

Research date: 2026-08-06.

## Bottom line

Prime Agent is not one technique. It composes four contracts:

1. Large context and useful state live outside the active model window.
2. The model's only built-in interface is a programming environment.
3. Programs can make semantic model calls and admit retained child sessions.
4. A separate refinement path edits versioned harness state—prompt supplements, memories, skills, and subagent specifications.

The local Cloudflare Code Mode SDK is a strong match for contracts 1 and 2 and supplies a durable execution/replay spine. Think and the Agents SDK already supply persistent turns, child facets, idempotent agent-tool runs, recovery, and a durable programmatic-submission queue. Custom Code Mode connectors bridge those capabilities into a single programming tool. What this combination still does not supply is Prime's literal persistent IPython heap or its always-on multi-process session daemon.

## 1. Original Recursive Language Models

The original RLM keeps the corpus or prompt outside the root model context as a variable. The root receives metadata and a short preview, writes code to inspect or transform selected regions, and can call language models programmatically on dynamically constructed slices. Intermediate state remains in the REPL. Completion is environment-backed rather than inferred from ordinary prose.

The core invariants are:

- **External symbolic context:** the complete input is addressable without inserting it into every root prompt.
- **Persistent program state:** useful intermediate values survive root iterations.
- **Programmatic semantic calls:** code chooses the content, count, and concurrency of subcalls.
- **Bounded observations:** large tool/subcall results do not flood the root window.
- **Environment-backed completion:** an answer variable or equivalent protocol determines when work is done.

The experiments are promising but do not support “more recursion is better.” The RLM paper reports large depth-one gains on context-heavy benchmarks and also shows model/prompt sensitivity, pathological trajectories, and worse tail cost. Depth zero—external context plus a REPL but no recursion—already helps several tasks. An independent reproduction likewise reports that deeper recursion can overthink and turn seconds into minutes.

Design consequence here: depth defaults to one; recursion and parallelism are host-enforced budgets; the root must call `kernel.finish`.

Primary sources:

- [Recursive Language Models paper](https://arxiv.org/html/2512.24601)
- [Official RLM implementation](https://github.com/alexzhang13/rlm)
- [Minimal reference implementation](https://github.com/alexzhang13/rlm-minimal)
- [Author explanation](https://alexzhang13.github.io/blog/2025/rlm/)
- [Independent reproduction](https://arxiv.org/abs/2603.02615)

## 2. Prime Agent's RLM-native variant

Prime gives the model a persistent IPython kernel as its built-in tool. Python bindings bridge to tools, provider calls, conversation logs, and child-agent admission. The TypeScript host owns credentials, sessions, process lifecycle, and child orchestration.

Two Prime behaviors are easy to misread:

- `await rlm(...)` is admission, not the child answer. The retained child responds later through messages or files.
- Prime's current implementation is not a literal copy of the RLM paper's root loop. It still has normal conversation messages and exposes an append-only conversation log path for programmatic recovery.

This implementation therefore separates:

- `rlm.query`: synchronous, one-turn work in a full Code Mode child agent through Agents' idempotent `runAgentTool`. This is deliberately richer—and slower—than the original depth-one RLM's usual plain leaf-model call.
- `rlm.spawn`: durable asynchronous admission into a named, retained Think child. Follow-ups use the same child's durable submission queue and therefore retain its Session, connector-readable transcript, external inputs, and kernel.

Because `rlm.query` runs inside its parent's Code Mode execution, the child receives smaller generation and sandbox budgets than the outer turn. This leaves headroom for the connector result to cross back to the parent even if generated code starts near the child's deadline.

Prime's process/kernel boundary is described as lifecycle isolation, not a security sandbox. Code Mode's Dynamic Worker is a stronger default for a think-only service: outbound network and parent bindings are disabled, while privileged or durable capabilities exist only behind connector RPC. Standard Worker/Node-compat ambient APIs and an ephemeral virtual filesystem still exist inside the generated worker; they do not expose the host workspace or parent credentials.

Primary sources:

- [Prime Agent launch post](https://www.primeintellect.ai/blog/prime-agent)
- [Prime Agent repository](https://github.com/PrimeIntellect-ai/prime-agent)
- [Prime RLM documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)
- [Prime runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
- [Prime system architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)
- [Actual RLM system prompt](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/prompts/rlm.ts)
- [Python RLM bridge](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/prime-agent-runtime/src/rlm/__init__.py)

### Source drift worth knowing

The launch narrative and current source are not identical:

- The launch post says idle children are evicted after 30 minutes; current source defaults to 90.
- A launch follow-up example passes a `mode` field that the current message binding rejects.
- A launch skill example omits callable/reference metadata required by current validation.

For implementation decisions, current source wins over launch prose.

## 3. Continual Harness

The Continual Harness paper treats the harness as system prompt plus subagents, skills, and memory. Its outer loop reviews recent trajectory and revises those components. The reported work also shows failure modes: capability floors, unused memories, invalid evolved schemas, self-reinforcing false beliefs, regressions, and long loops.

Prime's `/refine` is more guarded than unrestricted source self-modification:

- The base prompt remains immutable.
- Supplemental state is versioned and rollbackable.
- Local/session state is preferred.
- Skill edits must reference installed executable capabilities.
- The refiner can return no changes.

Crucially, Prime records an `expectedOutcome`; it does not automatically demonstrate the outcome on held-out work. Calling that proven “self-improvement” overstates the implementation.

This project follows the guarded interpretation:

- Harness writes exist only during explicit `/refine` turns.
- The model must provide concrete trajectory evidence and an expected result.
- Optimistic revisions prevent stale proposals from overwriting newer state.
- Each transaction retains an audit snapshot and supports monotonic rollback.
- A `skill` can only reference a Code Mode snippet that a developer already promoted from a successful execution.
- No model path can alter TypeScript source or the immutable base prompt.

Primary sources:

- [Continual Harness paper](https://arxiv.org/html/2605.09998)
- [Continual Harness implementation](https://github.com/sethkarten/continual-harness)
- [Prime refinement implementation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/refinement/refinement.ts)
- [Prime harness state](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/prime-agent-runtime/src/rlm/harness.py)

## 4. What the local `./agents` repository establishes

The implementation was derived from the repository's current source rather than a guessed or older API surface. At research time the workspace packages are `@cloudflare/codemode` 0.5.1, `@cloudflare/think` 0.15.1, and `agents` 0.20.1.

Relevant local sources:

- `packages/think/src/think.ts`: turn assembly, `beforeTurn`, `activeTools`, recovery, programmatic submissions, and Think's agent-tool adapter.
- `packages/think/src/tools/execute.ts`: `createExecuteRuntime`, explicit connector-only configuration, and Code Mode result truncation.
- `packages/agents/src/index.ts`: `subAgent`, `runAgentTool`, concurrency, terminal delivery, inspection, and recovery.
- `packages/agents/src/agent-tool-types.ts`: awaited/detached run contracts and lifecycle results.
- `packages/codemode/src/runtime-handle.ts`: model-facing tool, executions, and snippet promotion.
- `packages/codemode/src/runtime.ts`: durable facet storage, connector-call replay, executions, and snippets.
- `packages/codemode/src/executor.ts`: fresh Dynamic Worker execution and `globalOutbound: null` isolation.
- `examples/sandbox-coding-agent/src/server.ts`: the repository's own pattern for using `activeTools` to suppress Think's built-in workspace tools.
- `examples/think-workflows/src/index.ts`: server-only Think routing, Durable Object binding, and migration conventions.

Findings that shaped the design:

- Think merges workspace, session, action, extension, MCP, fetch, skill, and client tools before `beforeTurn`. There is no constructor flag that removes all of them.
- `activeTools` is the supported turn-wide filter. Supplying the canonical Code Mode tool again through `beforeTurn.tools` prevents a client tool with the same name from shadowing it.
- The system instructions must also be replaced. Think's default capability prompt is assembled before inactive tools are filtered and would otherwise advertise capabilities the RLM cannot call.
- `beforeToolCall` is a useful second guard for server-executed tools, but it is not the primary schema filter and cannot intercept a client-side executor. The authenticated HTTP surface does not accept client tools.
- `createExecuteRuntime(this)` is intentionally not used: that convenience overload derives `state.*` from Think's workspace and may derive browser capabilities. The explicit `{ ctx, loader, connectors, globalOutbound: null }` form limits application capabilities to the four RLM namespaces and disables outbound network; ordinary Worker/Node-compat ambient APIs remain available inside the ephemeral generated worker.
- Think Workflow structured-output turns inject a synthetic final-answer tool, so they do not fit a literal one-tool architecture.
- `runAgentTool` is idempotent by `runId` and is an excellent fit for one terminal child turn. Reusing a terminal run ID returns the retained result; it does not create a follow-up turn.
- A named `subAgent` plus Think's `submitMessages`/`inspectSubmission` API is the better fit for a Prime-style retained child with later follow-ups.
- Every fresh Code Mode tool call creates a fresh execution ID. Recursive operation identity must therefore come from the stable external root input plus operation kind and caller key—not the transient execution. A durable operation ledger validates a full argument hash, charges budget once, and retains all source execution IDs as provenance.
- Root HTTP work uses Think's programmatic submission queue too. A caller-supplied request ID maps to a stable input/submission ID, making admission retry-safe and its recovered result pollable after the original response disappears. If a crash leaves the request ledger but no Think submission, polling reconstructs the compact turn from the durable input and resubmits it under the same idempotency key.
- Inputs become connector-visible only when their queued turn actually starts. Per-scope activation sequence prevents an earlier turn from discovering a later admitted input through `context.inputs` or a guessed input ID.
- Persistent-child dispatch uses the child turn ID as both submission ID and idempotency key. A missing child submission is recreated from the parent's durable input copy, while compare-and-swap child-head updates prevent a late status refresh from rolling a newer follow-up backward.
- `kernel.finish` runs before the outer Code Mode tool wrapper receives its result. Each connector binds the execution to the active input on entry and finalizes terminal status through `disposeExecution`, closing the ordinary crash window between connector side effects and outer result bookkeeping.
- Think owns its alarm for schedules, recovery, submissions, fibers, and detached agent tools. Replacing `alarm()` with an application queue would break those contracts; the earlier standalone alarm loop was removed.
- Full task material still needs a separate chunked store. Think intentionally hydrates recent messages for conversation quality, so inserting multi-megabyte corpora as ordinary UI messages defeats the context-variable design.
- The worker entry must export `CodemodeRuntime`, the root Think class, and the child class so facets resolve through `ctx.exports`. Only the root class needs a top-level Durable Object binding and migration.
- Saved snippets are developer-promoted programs that already ran; they are the right executable gate for harness skills.
- Snippet names and the per-session cap are reserved atomically in the parent Durable Object before the Code Mode facet write. Names are immutable, pending reservations count toward the cap, and facet listings reconcile a save-applied/ledger-not-finalized crash without reopening the name.
- A Worker Loader binding is required. Dynamic Workers may require a paid Workers plan.
- Session routes must be protected at the outer Worker boundary. This implementation refuses them unless the `API_TOKEN` secret is configured and presented as a bearer token; the token is never bound into generated-code Workers.

Official documentation:

- [Think package guide](https://github.com/cloudflare/agents/blob/main/packages/think/README.md)
- [Agents as tools](https://github.com/cloudflare/agents/blob/main/packages/agents/docs/agent-tools.md)
- [Think programmatic submissions](https://github.com/cloudflare/agents/blob/main/packages/think/docs/programmatic-submissions.md)
- [Code Mode overview](https://developers.cloudflare.com/agents/tools/codemode/)
- [How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)
- [Code Mode API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
- [Durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/)
- [AI SDK integration](https://developers.cloudflare.com/agents/tools/codemode/ai-sdk/)

## 5. Mapping the systems

| Prime/original concept   | Think + Agents + Code Mode construction                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Context variable         | Chunked read-only `context.inputs`, `context.slice`, and `context.searchInput` over current or prior scope-local inputs in Durable SQLite |
| Persistent REPL values   | Scope-local durable JSON through `kernel.get/set/list/delete`                                                                             |
| Answer variable          | `kernel.finish({ content })`, accepted only after its owning Code Mode execution completes successfully                                   |
| Recursive model call     | `rlm.query` creates an idempotent, awaited `runAgentTool` turn in a Code Mode child; it is not a plain leaf-model call                    |
| Retained child admission | `rlm.spawn` resolves a named Think sub-agent and durably submits a compact pointer turn                                                   |
| Follow-up child work     | Another durable submission in the same child's Think Session, local transcript, input store, and kernel via `rlm.followup`                |
| Conversation log         | Append-only scoped messages with bounded history/search reads                                                                             |
| Execution trajectory     | Code Mode's durable executions plus bounded summaries exposed through `context.executions`                                                |
| Skill                    | Developer-promoted Code Mode snippet plus harness metadata                                                                                |
| Harness refinement       | Explicit write-enabled connector, expected revision, audit snapshot, rollback                                                             |

## 6. Important limitations

### No literal persistent interpreter heap

Durable JSON keeps decisions, indexes, partial reductions, and structured artifacts. It cannot preserve closures, imports, class instances, generators, open resources, or arbitrary object graphs. Exact Prime semantics require a persistent Python service such as Cloudflare Sandbox's interpreter contexts—an additional SDK and a different security/lifecycle design.

Within one Think turn, normal tool-call and tool-result steps remain in the model history. Across turns—and when this RLM deliberately overrides the assembled messages—the model receives a compact pointer prompt and must recover prior work through the connectors. Think still retains the compact UI transcript for recovery and inspection; the dedicated store retains the byte-addressable source material and RLM trajectory.

### Durable Agents orchestration is not Prime's session daemon

Think and Agents persist child facets, agent-tool ledgers, submission records, and recovery state. One-shot query run IDs and persistent child turn IDs are derived from the stable external root input plus operation kind and caller key. The operation ledger rejects changed arguments and prevents a new Code Mode execution from duplicating work. A retained child can accept later turns in the same Session, transcript, input store, and kernel; status is explicitly polled through the connector.

This still does not provide Prime's continuously running multi-process manager, live bidirectional A2A mailbox, automatic parent wake-up when a direct child submission finishes, arbitrary background cron, or a persistent Python process. Think can recover interrupted chat streams and agent-tool runs, but an isolated Code Mode program itself is replayed from its durable connector log rather than resuming an in-memory JavaScript heap.

### Refinement is not automatically evaluated

The harness records model-claimed evidence and an expected outcome. The host enforces one mutation per explicit refinement turn, optimistic revisioning, and rollback, but there is no automatic cadence, four-pass paper loop, separate reviewer, or evaluator. Connector mutations commit when `harness.apply` or `harness.rollback` runs; they are not staged until the enclosing Code Mode execution later calls `kernel.finish`. A failed refinement can therefore leave an audited revision applied. A separate evaluator must compare candidate and control behavior before a change deserves the label “improvement,” and a production system should stage candidate revisions until the whole turn commits.

It is also a guarded registry rather than a fully active Continual Harness: the system prompt receives bounded entry previews, full entries are connector-addressable, and snippet-backed skills and subagent specifications are not automatically installed, invoked, or connected to child admission.

### Search is deliberately small

Input search is a literal substring scan that carries overlap across storage chunk boundaries, not embeddings or a full-text index. This keeps the think agent network-free and dependency-light but should be upgraded for multilingual or semantically diffuse corpora.

### Audit facets, retention, and budgets

Each root or child Think facet owns its own named Code Mode runtime facet. Every model-facing execution also copies a bounded code/result/status record into that agent's RLM SQLite store with its execution ID, input, and mode. Completion and connector inspection query this scoped ledger instead of loading full stored trajectories. A snippet promoted in the root runtime is therefore a root capability; it is not silently installed into every child.

There is currently no automatic garbage collection for external inputs, transcripts, answers, persistent children, submission records, or kernel state, and the example does not expose child cancellation/deletion routes. Those are production lifecycle requirements, not hidden properties of Think or Code Mode.

The authenticated HTTP entry parses the complete JSON request before validating individual field and aggregate limits. Cloudflare's platform request limit is still the outer ceiling, but a multi-tenant production service should enforce an earlier body-size policy appropriate to its plan and workload.

There is also no aggregate token or monetary budget. Call count, depth, model steps, concurrent awaited agent tools, generation time, and sandbox execution time are bounded. `TURN_TIMEOUT_MS` is the root generation and sandbox ceiling; nested child generation and sandbox execution receive smaller fractions to leave room for the outer connector call. Persistent background submissions are durable but still need product-specific total cost and age limits.

## 7. Recommended evaluation before production

Use the same tasks and model across four arms:

1. Ordinary single model call with input in the prompt.
2. Depth-zero Code Mode: external context and kernel, recursive calls disabled.
3. Depth-one synchronous RLM queries.
4. Depth-one plus retained child sessions.

Measure:

- task accuracy and evidence fidelity;
- root input tokens and total child tokens;
- median, p95, and maximum latency/cost;
- recursive calls, code failures, and incomplete `finish` rate;
- answer sensitivity to chunk boundaries and prompt variants;
- child admission recovery under forced isolate termination;
- harness candidate win rate on recurrence and held-out tasks;
- rollback frequency and regression severity.

Do not enable automatic refinement retention until candidates beat the unchanged harness on a meaningful held-out set and remain inside cost/latency budgets.
