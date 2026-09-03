Status: proposed

# Keep model providers native to each harness

## The problem

The Agents SDK is adding more than one agent harness. `PiHarness` runs pi's
agent loop. `CodexHarness` runs a Codex-derived loop. Both need model providers,
but they do not need the same provider contract in the first release.

An earlier version of this RFC proposed making pi-ai the common provider layer
for every harness and adapting AI SDK models into it. That design could work,
but it introduces a broad compatibility layer before either harness has enough
production use to define it confidently. It also creates difficult questions
about provider metadata, reasoning signatures, custom content, deferred
responses, and which values must be retained in constrained session storage.

The first Codex proof exposed a smaller and immediate problem. Kimi returned four
structured tool calls even though the request included
`parallel_tool_calls: false`. The local adapter rejected the response:

```text
OpenAI-compatible model returned 4 tool calls after parallel calls were disabled
```

That failure does not require a universal provider abstraction. The Codex loop
must preserve all tool calls returned by its model and settle the complete batch.

We should solve the known harness problems without deciding that every harness
must share one model ABI.

## Proposal

Use the provider contract native to each harness for v1:

```text
AI SDK LanguageModelV4                  pi-ai Models and Provider
          |                                      |
          v                                      v
     CodexHarness                            PiHarness
          |                                      |
          v                                      v
  Codex canonical session                  pi canonical session
```

- `CodexHarness` accepts an AI SDK `LanguageModelV4`.
- `PiHarness` accepts pi-ai `Models`, `Provider`, and `Model` values.
- There is no shared model registry or cross-provider adapter.
- Each harness owns a thin codec between its canonical transcript and its
  selected provider contract.
- Each harness stores one canonical transcript through `Sessions`.
- Provider requests are temporary projections and are not stored as another
  transcript.

This is an intentionally narrow decision. We can revisit a shared provider
layer after both harnesses have production evidence.

## CodexHarness model contract

`CodexHarness` accepts `LanguageModelV4` directly:

```ts
import type { LanguageModelV4 } from "@ai-sdk/provider";

export type CodexHarnessConfig = {
  readonly model: LanguageModelV4;
  readonly sessions: Sessions;
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly workspace: Workspace;
};
```

An application can use the existing Workers AI provider:

```ts
import { createWorkersAI } from "workers-ai-provider";

const workersAI = createWorkersAI({
  binding: this.env.AI,
  gateway: { id: "default" }
});

readonly codex = new CodexHarness({
  model: workersAI("@cf/moonshotai/kimi-k2.7-code"),
  sessions: this.sessions,
  tasks: this.tasks,
  streams: this.streams,
  workspace: this.workspace
});
```

The Codex codec maps:

```text
Codex Responses records
  -> LanguageModelV4 prompt and tools
  -> LanguageModelV4.doStream()
  -> LanguageModelV4 stream parts
  -> Codex Responses records
```

The codec owns only the semantic conversion required by Codex:

- instructions and input-item ordering;
- Codex tool specifications;
- text and reasoning events;
- tool-call and tool-result records;
- response and stop behavior;
- usage fields needed by the Codex session.

It does not parse Workers AI, OpenAI, Anthropic, or AI Gateway wire formats.
That remains the AI SDK provider's responsibility.

### Supported LanguageModelV4 subset

The first implementation supports the subset Codex currently needs:

- system, user, assistant, and tool messages;
- text input;
- reasoning text when supplied;
- function tools;
- multiple tool calls;
- text tool results;
- usage;
- finish reasons;
- cancellation and provider errors.

The Codex codec does not persist arbitrary `providerMetadata`, raw chunks,
requests, responses, or headers. A model that requires opaque provider metadata
for later turns is outside the v1 support contract until a concrete integration
proves which bounded field Codex must retain.

V4 is the only supported AI SDK model specification. The codec does not accept a
V3-or-V4 union and does not ship a runtime version adapter. Applications using
older providers upgrade or adapt them before constructing `CodexHarness`.
`workers-ai-provider@4` already implements `LanguageModelV4` and is the tested
Cloudflare path.

This means support is tested model by model. Workers AI Kimi through
`workers-ai-provider` is the first supported path. An arbitrary
`LanguageModelV4` is structurally accepted, but unsupported content should fail
with a clear conversion error rather than being silently dropped.

### Tool-call batches

The current extracted Codex kernel stores one `pending_call`. It must instead
store an ordered batch.

For every model response, Codex must:

1. preserve all tool calls in provider order;
2. store the assistant response containing the complete batch;
3. assign a stable effect ID to every call;
4. settle every call exactly once;
5. append every result before requesting another model response;
6. keep result ordering deterministic.

The first implementation executes the batch sequentially. This is correct even
when the model emitted the calls together. A later implementation can match
upstream Codex's per-tool concurrency gate.

`parallel_tool_calls` and equivalent provider settings are preferences, not
response cardinality guarantees. Codex must accept multiple calls regardless of
the requested preference.

## PiHarness model contract

`PiHarness` continues using pi-ai natively:

```ts
import { PiHarness } from "agents/harness";
import { createModels, workersAI } from "agents/models/pi-ai";

const models = createModels({
  providers: [workersAI(this.env.AI, { gateway: "default" })]
});

readonly pi = new PiHarness({
  models,
  model: {
    provider: "cloudflare-workers-ai",
    modelId: "@cf/moonshotai/kimi-k2.7-code"
  },
  sessions: this.sessions,
  tasks: this.tasks,
  streams: this.streams
});
```

Applications may register any compatible pi-ai provider in the same registry.
Pi keeps its top-to-bottom integration with pi-ai for:

- provider and model discovery;
- provider authentication;
- message and event types;
- reasoning and tool-call signatures;
- response identities;
- usage and stop reasons;
- deferred handles;
- model-specific compatibility behavior.

`agents/models/pi-ai` remains a Pi-specific package entry. It is not presented
as a model API for Codex or every future harness.

### Port the proven Flue model infrastructure

The first `agents/models/pi-ai` implementation should port the relevant Flue
code instead of designing another pi-ai registry and Cloudflare provider. The
source baseline is `withastro/flue` commit
`832ad2eeaf5e4b07d39749fc669e7ad556238313` under Apache-2.0.

Port these parts:

| Flue source                                              | Agents destination                                | What to retain                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/runtime/providers.ts`              | `packages/agents/src/models/pi-ai/models.ts`      | provider registration, `provider/model` resolution, model diagnostics, and conservative dynamic-model fallback                            |
| `packages/runtime/src/cloudflare/workers-ai-provider.ts` | `packages/agents/src/models/pi-ai/cloudflare.ts`  | pi-ai-native Workers AI and AI Gateway dispatch, wire-family selection, streaming normalization, idle timeout, and unknown model handling |
| `packages/runtime/src/provider-diagnostics.ts`           | `packages/agents/src/models/pi-ai/diagnostics.ts` | allowlisted provider finish reason and Gateway log correlation without raw response retention                                             |
| `packages/vite/src/providers-module.ts`                  | optional Agents Vite integration                  | selective `@earendil-works/pi-ai/providers/<id>` imports when a future build-time provider list exists                                    |

The port is intentionally not a verbatim copy of Flue's runtime architecture.
Agents changes these parts:

- `Models` is supplied at the Durable Object composition root rather than held
  in a module-global service locator.
- `PiHarness` stores canonical entries through `Sessions`, not Flue's
  conversation writer or reducer.
- errors use Agents' error and observability conventions.
- Cloudflare runtime types remain structural at the binding adapter.
- the entry is named `agents/models/pi-ai`, not `cloudflare` or `providers/pi`.
- every ported source file carries the required Apache-2.0 modification notice,
  and the Agents package includes Flue attribution in its third-party notices.

Do not port:

- Flue's agent loop, hooks, session, conversation reducer, or canonical record
  schema;
- its module-global `MutableModels` instance;
- its default registration of every pi-ai provider;
- Vite code generation until Agents has a real build-time provider selection
  feature;
- Flue-specific telemetry, error prose, retry policy, or sandbox behavior.

`agents/models/pi-ai` exports a factory and types, not mutable global state:

```ts
import { createPiModels, createWorkersAIProvider } from "agents/models/pi-ai";

const models = createPiModels({
  providers: [
    createWorkersAIProvider({
      binding: this.env.AI,
      gateway: { id: "default" }
    })
  ]
});
```

Applications import additional native pi-ai provider modules explicitly and add
them to the same factory. There is no register-all default, so an application
that uses only Workers AI does not resolve OpenAI, Anthropic, Google, Bedrock, or
other provider SDKs.

## Session storage

Both harnesses use one canonical transcript.

### Pi

Pi entries are stored through the shared `Sessions` capability. The pi-ai
context is derived from those entries. There is no second provider transcript.

### Codex

Codex Responses records are stored through `Sessions`. The
`LanguageModelV4` prompt is derived for each model call and then discarded.
Provider stream parts are converted directly into Codex records.

```text
Codex records in Sessions
        |
        | temporary projection
        v
LanguageModelV4 prompt
        |
        | provider stream
        v
Codex records in Sessions
```

### Storage rule

Persist a value only when it is:

- user-visible transcript content;
- required to settle a durable tool or operation;
- required for the harness's next provider request;
- required for usage accounting or recovery.

Do not persist:

- provider request copies;
- raw provider responses or SSE frames;
- arbitrary provider metadata;
- authorization or response headers;
- duplicate message projections;
- model catalogs;
- reconstructable provider configuration.

Active operation handles belong in the effect journal, not in every transcript
message. They should be removed or compacted after settlement.

## Harness and provider boundaries

A provider performs one model generation. A harness runs the agent loop.

```text
Provider responsibility                Harness responsibility
-----------------------                ----------------------
request serialization                  canonical transcript
network dispatch                       tool execution
wire parsing                           tool batch settlement
text/reasoning/tool events             continuation decisions
usage and finish reason                compaction
provider errors                        durable effects
                                       recovery
```

Neither `workers-ai-provider` nor pi-ai should execute Codex's tool loop.
Neither `CodexHarness` nor `PiHarness` should parse provider wire formats.

## Relationship to Vercel AI SDK Harnesses

Vercel's `@ai-sdk/harness` follows a similar separation at a different boundary.
Its `HarnessV1` adapter wraps a complete native harness and exposes it as an AI
SDK `Agent`. It does not inject arbitrary AI SDK model providers into Pi or
Codex.

Its useful patterns are:

- an explicit live harness session;
- fresh user input only, without replaying the outer AI SDK transcript;
- separate session resume and active-turn continuation state;
- adapter-owned, schema-validated lifecycle data;
- explicit host-executed versus runtime-executed tools;
- complete tool-step cardinality through `stepToolCallCount`;
- projection of native harness events into a client-facing stream.

We should use those ideas for a future common harness session API. They do not
require a common model provider API.

## Relationship to Flue

Flue validates pi-ai as a strong provider boundary for a pi-based harness. We
retain that alignment in `PiHarness`.

This RFC does not extend the alignment to Codex in v1. Codex uses
`LanguageModelV4` because the Agents repository already has AI SDK providers and
Workers AI integration, and because it avoids a second provider project while
the Codex kernel is still being proven.

If the two harnesses later need the same provider behavior, Flue and pi-ai remain
the strongest evidence for replatforming Codex. We should make that decision
from real unsupported-model cases and storage measurements rather than from a
hypothetical universal contract.

## Tree shaking and package boundaries

No new common provider barrel is introduced.

- Codex imports only `LanguageModelV4` types and the minimal AI SDK provider
  utilities its codec needs.
- Applications choose and import their AI SDK provider, such as
  `workers-ai-provider`.
- Pi imports pi-ai through `agents/models/pi-ai` and the harness's existing
  pinned pi packages.
- Importing `agents/harness` must not eagerly import
  `workers-ai-provider` or every pi-ai provider family.
- `agents/models/pi-ai` must not import AI SDK.
- The Codex harness entry must not import pi-ai.

Bundle tests verify both directions.

## Testing

### Codex provider tests

Use synthetic `LanguageModelV4` implementations to prove:

- text completion;
- reasoning and text;
- one tool call;
- four tool calls in one step;
- malformed tool input;
- length and error finish reasons;
- provider rejection;
- stream error;
- cancellation;
- unsupported stream parts.

The four-call fixture is the regression for the Kimi failure.

### Codex storage tests

Inspect Sessions and effect rows to prove:

- one canonical copy of each message and tool result;
- four calls create four effects;
- the next model request starts only after four results exist;
- no raw provider request, response, or metadata copy is stored;
- recovery resumes the incomplete batch without repeating settled effects.

### Pi provider tests

Keep pi's provider and durable-harness conformance tests:

- native pi-ai provider streaming;
- Workers AI through the binding;
- model lookup and switching;
- signatures and deferred handles where supported;
- one canonical Sessions transcript;
- eviction and operation recovery.

### Bundle tests

Build and import tests prove:

- Codex does not resolve pi-ai;
- Pi does not resolve AI SDK or `workers-ai-provider`;
- `agents/harness` does not eagerly load either provider stack;
- applications pay only for the harness and provider they import.

### Live tests

The first live matrix is deliberately small:

- Codex with Workers AI Kimi through `workers-ai-provider`;
- Pi with Workers AI through `agents/models/pi-ai`;
- both with tool use and restart recovery.

Add another provider only when there is a product requirement, then document
whether its provider-specific continuity fields fit the selected harness.

## Migration plan

### Phase 0: fix Codex tool batches

Remove the single-call invariant and add the observed four-call regression.
Execute batches sequentially at first.

### Phase 1: replace the local Codex transport

Change `CodexHarness` from the local OpenAI-compatible callback to
`LanguageModelV4`. Keep the Codex transcript and kernel protocol unchanged
except for tool batches.

### Phase 2: use workers-ai-provider

Compose Kimi through the existing Workers AI provider and AI Gateway settings.
Run local and deployed tool-call, storage, and recovery smokes.

### Phase 3: keep Pi native

Land `PiHarness` with its pi-ai Models registry and `agents/models/pi-ai`
Workers AI adapter. Do not route it through Codex's AI SDK model contract.

### Phase 4: gather evidence

Track:

- unsupported provider stream parts;
- provider metadata required for continuation;
- bundle sizes;
- session storage volume;
- duplicated implementation across the two harnesses;
- model setup friction reported by users.

Only then decide whether to replatform Codex on pi-ai, introduce a narrower
shared provider package, or keep the contracts separate.

## Alternatives

### Replatform every harness on pi-ai now

Deferred. pi-ai is a credible long-term provider boundary and is native to Pi
and Flue. Adopting it for Codex now requires a new codec, Cloudflare integration,
package exports, and compatibility policy before the Codex kernel has fixed its
known tool-batch limitation.

### Invent a neutral shared model contract

Rejected. It would duplicate AI SDK and pi-ai message, stream, provider, and
usage types. Both provider ecosystems would need adapters before either harness
could run.

### Adapt AI SDK providers into pi-ai now

Deferred. The portable subset is implementable, but arbitrary AI SDK
`providerMetadata` cannot be retained losslessly within the session storage
budget. We do not need this adapter to ship either harness.

### Adapt pi-ai providers into LanguageModelV4

Deferred. It introduces the inverse translation and the same fidelity questions.
Pi already consumes pi-ai directly.

### Use OpenAI Chat Completions directly in Codex

Rejected as the lasting boundary. It makes Codex own provider wire parsing and
limits provider compatibility to one protocol. The local adapter remains only a
spike artifact until the `LanguageModelV4` migration.

### Require all harnesses to accept the same provider type

Rejected for v1. Some harnesses own model transport, while others expose only a
native model name or fixed model. A common harness session API does not imply a
common provider injection API.

## Decision

Proposed for v1:

- `CodexHarness` accepts AI SDK `LanguageModelV4`.
- `PiHarness` accepts pi-ai `Models` and providers.
- Workers AI for Codex uses the existing `workers-ai-provider` package.
- Workers AI for Pi uses `agents/models/pi-ai`.
- Each harness stores one canonical transcript in `Sessions`.
- Provider call projections are temporary and never become a second transcript.
- Arbitrary provider metadata and raw responses are not persisted.
- Codex preserves and settles every tool call returned by a model.
- No common cross-harness provider abstraction or adapter ships in v1.
- Provider convergence is revisited after production evidence from both
  harnesses.
