# ThinkHarness extensions

Internal. Nothing here is exported from a package entry point, and no user docs page describes it. Code: `packages/agents/src/harness/think/extensions/`.

## How it works

An extension is a function. ThinkHarness runs it once when it loads it, and the function registers what it wants before it returns:

```ts
const houseRules: ThinkExtension = (ctx) => {
  ctx.tools.transform((tools) => tools.delete("exec"));
  ctx.prompt.transform((prompt) =>
    prompt.set("house_rules", { text: "Answer in British English." })
  );
  ctx.on("beforeToolCall", (call) =>
    call.toolName === "write"
      ? { action: "block", reason: "Read only." }
      : undefined
  );
};
```

A transform is `(draft, build) => void | Promise<void>`, where `build` is `{ session }`. A draft is an ordered map of names to entries (`get`, `has`, `set`, `delete`, `keys`). Setting a name that is already there replaces it in place.

**A build** starts from empty drafts and passes them through every loaded extension in load order. Each extension sees what the ones before it made. The result depends only on what is loaded and in what order, so building again is always safe. ThinkHarness builds where it resolves a session's tools: once per model call, and when a watch starts or a tool answer arrives.

**One build per attempt.** A run builds once, when an attempt starts, and every model call and tool call of that attempt uses that build. A change to the extensions or the options' tools applies from the next turn (or the next attempt after a reset). A call still waiting to run whose tool the attempt's build lacks (it was removed while the call was cut off) is answered with the tool error `Tool "<name>" is no longer available.` An approved call to a tool the build lacks waits instead, as in Think, because it may be a client's tool that the client did not declare again with the answer. A call the model makes to a tool it was never offered is answered by the AI SDK as an invalid call.

**Data crosses, functions stay.** `tools.set(name, tool)` takes an AI SDK tool. The runtime beside the extension keeps the tool object and gives the harness a data entry:

- the tool's data fields as written (description, `type`, `id`, `args`, `providerOptions`, `strict`, `inputExamples`, `recovery`...). A description given as a function is resolved at build, as the AI SDK resolves it when the call has no tool context;
- the input schema as JSON Schema, the same object the AI SDK would send. It is converted once per tool object;
- the name of the extension that set it (its owner), and flags for which functions the owner keeps: `execute`, input validation, `toModelOutput`, `needsApproval`.

The harness turns each entry back into an AI SDK tool whose functions call the owner's handle. A tool whose `execute` is an async generator runs through an async generator that yields what the tool yields, when it yields it, so its preliminary outputs arrive as they did. Any other tool returns a promise: of its one output, or of its outputs when what it returned turns out to stream, as the tool itself would. The AI SDK streams whatever returns an async iterable, so a plain tool must not return one. An output is captured when the tool yields it. A call whose signal is already aborted does not start, and a cancel reaches the call of that session only (call ids are unique only within one model reply). Validation runs the tool's own schema, so zod defaults and transforms apply as before. The AI SDK's `onInputStart`, `onInputDelta` and `onInputAvailable` callbacks are not called, and the runtime warns once per tool that has one.

**The handle** is all the harness holds of an extension: `describe`, `build`, `execute`, `cancel`, `validate`, `modelOutput`, `needsApproval`, `hook`. Every argument and result is structured-clone data. The exception is `execute`'s `onOutput`, which is a function, and Workers RPC passes a function as a stub. The rule for anything added to it: if it cannot be the same in the harness's isolate and across Workers RPC, it is not in the API. The conformance test in `tests/extensions.test.ts` runs one extension directly and through a handle that clones every argument and result, and expects the same entries, outcomes and hook decisions.

**Hooks** run in load order:

| Hook                                                    | How the handlers combine                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `beforeToolCall`                                        | a `run` with a new input passes it on; the first `block` or `substitute` ends the chain |
| `classifyError`                                         | the first class given wins                                                              |
| `onRecovery`                                            | the first `abandon` wins                                                                |
| `afterToolCall`, `onStepFinish`, `onTurnEnd`, `onError` | every handler runs                                                                      |

A handler that throws ends the dispatch with its error, which keeps each ThinkHarness option's contract (a throwing `beforeToolCall` ends the operation `unanswered`). The options' hooks are called as methods of the `hooks` object, as before.

**Remind sections.** A prompt entry may say `whenChanged: "remind"` (with an optional `description` and `maxTokens`). In a session with a context, ThinkHarness adds such an entry as a remind block of that context the first time its label is built, and the block reads the latest build's text. It is in the prompt the context records, and a change to it goes out once, as a reminder after the user message of the turn that noticed it, without rewriting the recorded prompt. A section the build no longer has is removed from the context. A label the context already has (the app's own block) is left out with a warning rather than failing the turn. The texts are kept per context object, so a context made anew after a reset gets its blocks again, and they go with it. In a session without a context there is nowhere to record a remind section, so it is system text, in its place among the other sections.

**ThinkHarness's own parts** are the first two extensions it loads, in process: `context` (the session context's `set_context` and `search_context`), then `options` (the `tools` and `system` options and the hooks above). Client tools are merged after the build, as before: they have no server function. `model`, `onChunk`, `toolApproval` and `beforeTurn` stay options the harness calls itself, because they hand over live objects: a model, every streamed chunk, a configuration that may hold a model.

## Extensions Think loads from source

`Think`'s released extensions (a manifest plus source that evaluates to `{ tools, hooks }`, run in a dynamic Worker through `extensionLoader`) are handles of the same core. Each loaded Worker is a `ReleasedWorkerHandle` (`packages/think/src/extensions/manager.ts`): its tools are fixed at load, offered as `<extension>_<tool>` and described as `[<extension>] <description>`, and run over the Worker's `execute` RPC. The public `ExtensionManager` keeps its methods. `getTools()` is the core's `toolsOf` over the loaded handles' entries, so there is one way to turn entries into tools.

Their hooks are the released ones, a second hook map on the same manager until `Think` runs on ThinkHarness:

| Hook                                                         | Sent                  | How they combine                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeTurn`                                                 | the turn snapshot     | a fold: each extension's serializable `TurnConfig` fields (last write wins; `headers` and `providerOptions` merged) go to the next, which sees the changed `system` and `activeTools` |
| `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk` | that event's snapshot | observe                                                                                                                                                                               |

Each call has the agent's `hookTimeout`. An extension that fails or passes it is logged and skipped. A snapshot is made only when some extension subscribes to the event. A tool of an unloaded extension answers with an error that says it is no longer available.

A manifest's `network` hosts are enforced by `HostBridgeLoopback`, the binding the app already re-exports for host access. The extension Worker's `globalOutbound` is that binding, so every `fetch()` it makes arrives at the bridge's `fetch`. The bridge checks the URL with the web tools' URL policy (`allowedHosts` from the manifest, private and local addresses refused) and answers `403` when it fails. It forwards a request that passes with `redirect: "manual"`, so each redirect hop comes back through the check. A TCP socket (`connect()`) from the Worker fails, even to a listed host: the bridge has no way to check a socket, so the outbound refuses it. Before the hosts were enforced, such a socket opened to any host. Without the re-export, or with an app's own `createHostBinding`, which may serve the host operations alone, nothing is known to enforce the list. The Worker then keeps the agent's network as before, and the manager warns once. An extension with no hosts has no network at all.

A context block's `type` in the manifest is ignored with a warning, once per manager. An extension writes its blocks with `host.setContext()`, which its `context.write` permission governs.

## The harness-backed Think shell

The shell (`think/src/harness/think.ts`) takes Think's extension members as Think does: `extensionLoader`, `getExtensions()` and `extensionManager`. At start, with a loader, it creates the same released `ExtensionManager`, loads `getExtensions()` and restores what was loaded at run time (its `ext:<name>` rows, as on Think). It also registers each extension's context blocks. The manager's tools join ThinkHarness as one shipped extension, `sandboxed`, after the subclass's own tools. Its released hooks run from the shell's hook options: `beforeTurn` after the subclass's, then the three observers and `onChunk`. `_cfHostBridge` serves `HostBridgeLoopback` over the same host API as Think.

## Telling the model when the tools change

On every model call, ThinkHarness gives the session's context the tools that call offers, each with a hash of its definition as the model sees it (description, input schema, input examples, provider fields), made once per tool object. The context's record for each user message keeps that list (no new row). When a turn's list differs from the previous record's, the model is told once, after that turn's user message: what was added, what is gone (not to be called, earlier description to be disregarded), what changed. A turn with the same tools writes nothing new. A session without a context gets no notice.

## Saying when the prefix changed

Before a model call whose prefix differs from the session's previous call, which loses a provider's prompt cache, ThinkHarness emits a `prefix-changed` session event with its causes:

- `tools`: the names added, removed and changed, from the same comparison the notice uses;
- `system`: a refresh recorded a new system prompt;
- `messages`: history was compacted, or a message was edited or deleted around the harness.

The harness-backed Think forwards it as the `chat:prefix:changed` observability event, on the `chat` channel. It is not named `think:`, because that prefix has no channel of its own. The `Think` class emits it from E4, when its turn runs on ThinkHarness. `tools` and `system` need a context in the session (as the notice does), and compare with what the branch being answered was sent, so a regeneration compares with its own branch. A refresh that a `beforeTurn` `system` replaces isn't reported. `messages` names the operation without checking which branch it touched. A changed block isn't a cause: it goes after the new message, so the prefix holds. The rewrites are kept in memory per session until that session's next call (at most three each), so a rewrite made before an eviction goes unreported. No row and no hashing of the transcript.

## Guarantees

The core stores nothing: it adds no row, key or job. One thing is durable, and it predates the core. `Think`'s public `ExtensionManager`, when given `storage`, keeps each extension loaded at run time as `ext:<name>` (manifest and source) in the object's storage, deletes it on `unload`, and `restore()` loads them again after a restart. Moving these records into the manager as a capability comes with run-time loading on ThinkHarness.

In memory, per harness:

- the manager: one entry per loaded extension;
- each runtime: for each session built in this isolate, the latest tool it set under each name. A later build adds and replaces, and never drops a name, so a turn's tools stay callable after another build (a watch, the next turn) leaves one out. Bounded by the tool names it ever set for the session; converted entries in a `WeakMap` keyed by tool object; the calls running now, removed when each ends.

## Tradeoffs

- A build resolves the `tools` and `system` options where the harness used to resolve only the tools, so a per-session `system` function runs on those builds too. It is expected to be cheap and pure.
- A tool's description given as a function is resolved once per tool object, not once per request.
- A turn's build is pinned per attempt, but a tool's functions are looked up by name, so a `tools` function that returns a different function under the same name between two builds runs the newer one.

## Measured

20 zod tools, one build plus what the AI SDK does to send them (Node, in process): 0.025 ms when the `tools` option returns the same tool objects each time (0.13 ms before, because the AI SDK converted every schema per request), 0.29 ms against 0.26 ms when it builds new tool objects on every call.
