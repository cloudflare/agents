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

The harness turns each entry back into an AI SDK tool whose functions call the owner's handle. `execute` runs through an async generator, so a streaming tool's preliminary outputs still arrive before its result. Validation runs the tool's own schema, so zod defaults and transforms apply as before. The AI SDK's `onInputStart`, `onInputDelta` and `onInputAvailable` callbacks are not called, and the runtime warns once per tool that has one.

**The handle** is all the harness holds of an extension: `describe`, `build`, `execute`, `cancel`, `validate`, `modelOutput`, `needsApproval`, `hook`. Every argument and result is structured-clone data. The exception is `execute`'s `onPreliminary`, which is a function, and Workers RPC passes a function as a stub. The rule for anything added to it: if it cannot be the same in the harness's isolate and across Workers RPC, it is not in the API. The conformance test in `tests/extensions.test.ts` runs one extension directly and through a handle that clones every argument and result, and expects the same entries, outcomes and hook decisions.

**Hooks** run in load order:

| Hook                                                    | How the handlers combine                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `beforeToolCall`                                        | a `run` with a new input passes it on; the first `block` or `substitute` ends the chain |
| `classifyError`                                         | the first class given wins                                                              |
| `onRecovery`                                            | the first `abandon` wins                                                                |
| `afterToolCall`, `onStepFinish`, `onTurnEnd`, `onError` | every handler runs                                                                      |

A handler that throws ends the dispatch with its error, which keeps each ThinkHarness option's contract (a throwing `beforeToolCall` ends the operation `unanswered`).

**ThinkHarness's own parts** are the first two extensions it loads, in process: `context` (the session context's `set_context` and `search_context`), then `options` (the `tools` and `system` options and the hooks above). Client tools are merged after the build, as before: they have no server function. `model`, `onChunk`, `toolApproval` and `beforeTurn` stay options the harness calls itself, because they hand over live objects: a model, every streamed chunk, a configuration that may hold a model.

## Guarantees

Nothing is durable. The extensions add no row, key or job.

In memory, per harness:

- the manager: one entry per loaded extension;
- each runtime: the tools it set in its latest build for each session built in this isolate (replaced by that session's next build), the same bound as the harness's per-session context map; converted entries in a `WeakMap` keyed by tool object; the calls running now, removed when each ends.

## Tradeoffs

- A build resolves the `tools` and `system` options where the harness used to resolve only the tools, so a per-session `system` function runs on those builds too. It is expected to be cheap and pure.
- A tool's description given as a function is resolved once per tool object, not once per request.
- A tool call runs on the owner's tools from the session's latest build. Until builds are pinned per turn, a `tools` function that returns different tools between two builds of one turn runs the newer one.

## Measured

20 zod tools, one build plus what the AI SDK does to send them (Node, in process): 0.025 ms when the `tools` option returns the same tool objects each time (0.13 ms before, because the AI SDK converted every schema per request), 0.29 ms against 0.26 ms when it builds new tool objects on every call.
