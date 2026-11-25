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

**ThinkHarness's own parts** are the first two extensions it loads, in process: `context` (the session context's `set_context` and `search_context`), then `options` (the `tools` and `system` options and the hooks above). Client tools are merged after the build, as before: they have no server function. `model`, `onChunk`, `toolApproval` and `beforeTurn` stay options the harness calls itself, because they hand over live objects: a model, every streamed chunk, a configuration that may hold a model.

## Extensions Think loads from source

`Think`'s released extensions (a manifest plus source that evaluates to `{ tools, hooks }`, run in a dynamic Worker through `extensionLoader`) are handles of the same core. Each loaded Worker is a `ReleasedWorkerHandle` (`packages/think/src/extensions/manager.ts`): its tools are fixed at load, offered as `<extension>_<tool>` and described as `[<extension>] <description>`, and run over the Worker's `execute` RPC. The public `ExtensionManager` keeps its methods. `getTools()` is the core's `toolsOf` over the loaded handles' entries, so there is one way to turn entries into tools.

Their hooks are the released ones, a second hook map on the same manager until `Think` runs on ThinkHarness:

| Hook                                                         | Sent                  | How they combine                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeTurn`                                                 | the turn snapshot     | a fold: each extension's serializable `TurnConfig` fields (last write wins; `headers` and `providerOptions` merged) go to the next, which sees the changed `system` and `activeTools` |
| `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk` | that event's snapshot | observe                                                                                                                                                                               |

Each call has the agent's `hookTimeout`. An extension that fails or passes it is logged and skipped. A snapshot is made only when some extension subscribes to the event. A tool of an unloaded extension answers with an error that says it is no longer available.

A manifest's `network` hosts are enforced by `HostBridgeLoopback`, the binding the app already re-exports for host access. The extension Worker's `globalOutbound` is that binding, so every `fetch()` it makes arrives at the bridge's `fetch`. The bridge checks the URL with the web tools' URL policy (`allowedHosts` from the manifest, private and local addresses refused) and answers `403` when it fails. It forwards a request that passes with `redirect: "manual"`, so each redirect hop comes back through the check. Without the re-export, or with an app's own `createHostBinding`, which may serve the host operations alone, nothing is known to enforce the list. The Worker then keeps the agent's network as before, and the manager warns once. An extension with no hosts has no network at all.

A context block's `type` in the manifest is ignored with a warning, once per manager. An extension writes its blocks with `host.setContext()`, which its `context.write` permission governs.

## Guarantees

The core stores nothing: it adds no row, key or job. One thing is durable, and it predates the core. `Think`'s public `ExtensionManager`, when given `storage`, keeps each extension loaded at run time as `ext:<name>` (manifest and source) in the object's storage, deletes it on `unload`, and `restore()` loads them again after a restart. Moving these records into the manager as a capability comes with run-time loading on ThinkHarness.

In memory, per harness:

- the manager: one entry per loaded extension;
- each runtime: the tools it set in its latest build for each session built in this isolate (replaced by that session's next build), the same bound as the harness's per-session context map; converted entries in a `WeakMap` keyed by tool object; the calls running now, removed when each ends.

## Tradeoffs

- A build resolves the `tools` and `system` options where the harness used to resolve only the tools, so a per-session `system` function runs on those builds too. It is expected to be cheap and pure.
- A tool's description given as a function is resolved once per tool object, not once per request.
- A tool call runs on the owner's tools from the session's latest build. Until builds are pinned per turn, a `tools` function that returns different tools between two builds of one turn runs the newer one.

## Measured

20 zod tools, one build plus what the AI SDK does to send them (Node, in process): 0.025 ms when the `tools` option returns the same tool objects each time (0.13 ms before, because the AI SDK converted every schema per request), 0.29 ms against 0.26 ms when it builds new tool objects on every call.
