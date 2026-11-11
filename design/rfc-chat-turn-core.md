# RFC: one turn core for `AIChatAgent` and `Think`

Status: accepted. Phase 1 and the client-request part of Phase 2 are implemented. The rest of Phase 2 and Phases 3 to 5 are the plan.

Related:

- [chat-shared-layer.md](./chat-shared-layer.md) describes what `agents/chat` shares today.
- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) has the extraction map this RFC continues. Its "Tier 2, streaming response loop" and "the Turns effort" are Phases 3 and 4 here.
- [rfc-think-turns.md](./rfc-think-turns.md) defines `TurnSpec` and `_admitTurn`, the starting shape for Phase 2.
- [think-vs-aichat.md](./think-vs-aichat.md) compares the two classes.

## The problem

There are three implementations of "run a chat turn" in this repo:

| Where                                   | How a turn runs                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AIChatAgent` (`packages/ai-chat`)      | The app's `onChatMessage` returns a `Response`. `_reply` reads it, stores and broadcasts chunks, and persists the message. |
| `Think` (`packages/think`)              | `_runInferenceLoop` calls the model. `_streamResult` reads the UI message stream, stores and broadcasts, and persists.     |
| `ThinkHarness` (`agents/harness/think`) | Durable operations. One driver asks `nextAction()` after every step and after an eviction. It shares only leaf helpers.    |

`AIChatAgent` and `Think` share leaf classes in `agents/chat` (`TurnQueue`, `AbortRegistry`, `ContinuationState`, `ResumableStream`, `ChatRecoveryEngine`). The code that ties those classes together is written twice. Each host kept about a dozen private fields for it and its own copy of clear, cancel, the tool-result handler, the continuation turn, the idle and stable waits, and the recovery entry points. The files say so themselves, with "Mirrors `@cloudflare/think`" comments on both sides.

Writing the rules twice has a measured cost. Model-checking the chat runtime (three TLA+ models of the turn flow, recovery and stream resume) found eight races in `AIChatAgent`, fixed in #2860, #2861 and #2865. Each fix was a guard in that tying code. At least three of them applied to `Think` as well, and `Think` got each one only when someone ported it:

- a repeated tool result started a second continuation (ported in #2865)
- a late tool result continued a newer reply (ported in #2865)
- a stop was ignored while a recovery attempt was already running (ported in this change, with a replay that failed first)

The same thing will happen to the next fix unless the rule lives in one place.

It also blocks the move of the `Think` class onto `ThinkHarness`. Today that move has to reproduce two sets of behaviors that differ in ways nobody chose (see [Differences](#differences-the-phases-have-to-settle)). With one core there is one behavior to carry over.

## The proposal

Move the turn loop of `AIChatAgent` and `Think` into `agents/chat`, in phases, each one shippable and each one keeping both test suites green.

The hosts keep what is theirs. `AIChatAgent` keeps `onChatMessage`, the flat transcript and destructive regenerate. `Think` keeps its inference loop, the Session tree, submissions, actions and channels. The core owns the order things happen in.

### Phase 1: turn coordination (implemented)

`ChatTurns` (`packages/agents/src/chat/chat-turns.ts`) owns the state a host needs to run one turn at a time, and the rules across it:

| State                                                    | Rule the core now owns                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `queue` (`TurnQueue`)                                    | `turnResetGuard()`: a turn runs under the generation it was admitted with. After a clear it must not stream or persist.    |
| `aborts` (`AbortRegistry`) and running recovery attempts | `cancel(id)` reaches a queued turn, a running turn, and a recovery attempt registered with `beginRecoveryAttempt(rootId)`. |
| `submits` (`SubmitConcurrencyController`), `preStream`   | `decideSubmit()`, `awaitSubmitTurn()` (superseded and debounce checks at the front of the queue), `settlePreStreamTurn()`. |
| the tool-result apply chain                              | `applyInteraction()`: applies commit one at a time, and only one that settled its call schedules a continuation.           |
| `continuation`, `autoContinuation`                       | `takeContinuation()`: a continuation runs only while the message it answers is still the latest.                           |
| all of the above                                         | `reset()` tears it down in one synchronous step. `waitForIdle()` and `waitUntilStable()` define idle and stable once.      |

Both hosts construct one `ChatTurns` with a small `ChatTurnsHost` (the transcript, two stream flags, `keepAliveWhile`, an id generator, and `fireContinuation`). Their old private fields (`_turnQueue`, `_continuation`, and so on) are aliases of the core's parts, so tests and subclasses that reach for them still work.

`AIChatAgent` is about 220 lines shorter and `Think` about 110, counting the recovery stop `Think` gained. No public API changes.

### Phase 2: one admission path (client requests implemented)

Every way a turn starts should go through one function in the core: a client request, `saveMessages`, `continueLastTurn`, an auto-continuation, a recovery continue or retry, an agent-tool run.

`Think` is most of the way there. `_admitTurn(spec)` takes a `TurnSpec` and every entry path builds one. `AIChatAgent` has `_runExclusiveChatTurn` plus five call sites that each repeat the setup around it. Phase 2 moves `TurnSpec` and `admit()` into `ChatTurns`, with the host supplying `execute`.

The client request handler was the largest piece, and it is done. `ChatTurns.runClientRequest()` owns the sequence both hosts ran: decide concurrency, accept (clear the terminal record, mark the turn pre-stream, create the abort controller), persist the incoming messages, enqueue, run the queued checks, end a request cancelled meanwhile without calling the model, run the turn, and settle. The host passes a `ClientChatRequest` with the steps that differ: how to persist, how to enqueue through its own tracing wrapper, what to run, and which frames to send.

Both continuation turns now start with `takeContinuation()`, which reads the pending continuation when the turn starts.

Still to do in this phase: `saveMessages`, `continueLastTurn`, the retry turn, recovery turns and agent-tool runs each build their own turn around the queue. They should go through one `admit()` in the core, with `TurnSpec` as its input.

### Phase 3: the reply pump

This is the loop itself: take a stream of chunks, build the assistant message, store each chunk for resume, broadcast it, and when the stream ends persist the message and send the terminal frame. Stop early on abort, a stall, a provider error, or a clear.

`_reply` plus `_streamSSEReply` in `AIChatAgent` and `_streamResult` in `Think` do the same steps with different inputs. The recovery RFC already worked out the order of work, and it still holds:

1. Move `AIChatAgent`'s live loop onto `StreamAccumulator`. It hand-rolls `applyChunkToParts` on a shared `_streamingMessage` today. The orphan path already uses the accumulator.
2. Give both hosts one pump in the core that reads `AsyncIterable<UIMessageChunk>`. `AIChatAgent` adapts its `Response` (SSE or plain text) into that. `Think` passes `toUIMessageStream()`.
3. Host hooks cover what differs: where the message is persisted, the early approval persist, replayed provider chunks, `Think`'s overflow retry, the RPC callback sink.

The pump is where the remaining single-host guards live (the reset guard in `_reply`, held terminal frames, the stream-active gate), so this phase is what makes them shared.

### Phase 4: recovery entry points

`_chatRecoveryContinueDetached` and `_chatRecoveryRetryDetached` exist in both hosts with the same skeleton: bail if cancelled, wait until stable, park or reschedule or exhaust on timeout, check the conversation did not move, run the turn, record the outcome. Move the skeleton into `ChatRecoveryEngine`. The hosts keep classify and dispatch, which depend on their storage model.

### Phase 5: line the core up with the harness

`ThinkHarness` and the other harnesses share one interface (`HarnessSession` in `agents/experimental/channels/harness`): `submit` returns an operation, `wait` settles it, `abort` and `reset` stop work, and a tool answer is submitted like any other input. `ThinkHarness` adds `continue` and `regenerate`.

After Phases 2 to 4 the core has one admission function, one pump and one recovery path. Its vocabulary can then be renamed to the harness's (a turn request is an operation, a tool result is an input). At that point moving the `Think` class to `ThinkHarness` is a change of engine behind an interface both already speak, and the behaviors to preserve are written down once.

I have not designed this phase in detail. It depends on what Phases 2 to 4 turn up.

## Differences between the hosts, and what we chose

The two hosts disagreed in places where nobody decided they should. The rule for choosing was the behavior that is hardest to get wrong at the edges, whichever host had it.

| #   | Topic                             | `AIChatAgent` did                                                                | `Think` did                                                           | Chosen                                                                                                    | State                                 |
| --- | --------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| D1  | When the abort signal exists      | From the moment the request is accepted (#2701).                                 | After the incoming messages persist.                                  | From acceptance. No window where a cancel finds nothing to abort.                                         | Done, in `runClientRequest`.          |
| D2  | Cancel while queued               | Sends an `aborted` frame and never calls the model.                              | Started the turn with an aborted signal.                              | Never call the model. It does not depend on the model honoring the abort.                                 | Done, in `runClientRequest`.          |
| D3  | Clear while a turn runs           | The reply checks the generation the turn was admitted with.                      | The reply read the generation when the stream started.                | The admission generation.                                                                                 | Done. Both call `turnResetGuard()`.   |
| D4  | Continuation context              | Reads connection and tools when the continuation turn starts.                    | Captured them when the continuation fired.                            | At turn start. It uses the latest result's tools.                                                         | Done. Both call `takeContinuation()`. |
| D5  | `onChatResponse`                  | Drained after the turn leaves the queue. Lost on a restart.                      | Fired inside the turn, with a durable marker so a restart replays it. | The durable marker, fired after the turn leaves the queue, which is what both classes' docs promise.      | Phase 3. Changes what apps observe.   |
| D6  | Stable wait and dead tool calls   | Recovery ignores a server tool call that died with its isolate. Others count it. | One predicate that ignores them.                                      | One predicate.                                                                                            | Open. See below.                      |
| D7  | Regenerate                        | Deletes the old reply.                                                           | Branches. The old reply stays in the tree.                            | Branch. A regenerate that deletes nothing cannot race a streaming reply or delete another tab's question. | Its own change. See below.            |
| D8  | Tool result with no matching call | Retried the lookup for up to a second.                                           | Looks once.                                                           | Look once. Applies run one at a time, so the retry stalled every result behind it.                        | Done.                                 |

Two more turned up while doing the client request:

| #   | Topic                      | `AIChatAgent` does                                        | `Think` does                                                | Chosen                        | State |
| --- | -------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------- | ----- |
| D9  | Request context            | Stores the request's tools and body when its turn starts. | Stores them when the request is accepted, before it queues. | At turn start, like D4.       | Open. |
| D10 | `skipped` for a stale turn | Sent to the connection that made the request.             | Was broadcast to every connection.                          | To the requesting connection. | Done. |

Notes on the open ones:

- **D5.** `Think` fires the hook inside the turn. Both classes document that the turn lock is released first, so `saveMessages` is safe inside the hook. From the code, `Think` would reject that call with its "cannot be called from inside an active turn" error. No test covers it. The chosen behavior fixes that and keeps the replay after a restart.
- **D6.** `AIChatAgent` keeps the broad predicate as the default for one reason I could not rule out: an app can define a client tool on the server with no `execute` and answer it from `onToolCall` without ever sending a tool schema. The narrow predicate reads client tools from the schemas the client sent, so it would treat that call as dead and stop waiting for the user. Narrowing the default needs a way to know those tools first.
- **D7.** Three things to settle when `AIChatAgent` branches: `maxPersistedMessages` counts stored rows, so hidden branches would count against the limit. Storage grows because old replies are kept. And apps can overwrite the whole transcript (`persistMessages(array)`, assigning `this.messages`), which has no obvious meaning on a tree.
- **D9.** In `Think`, a request waiting in the queue already changed the tools and body that a continuation of the running turn will use.

## Verification

The TLA+ models that found the races describe the tying code, which is now `ChatTurns`. `ChatTurns.tla` maps to `chat-turns.ts` and the two hosts' handlers. Each guard in the core has a variant of the model with the guard removed, and the variant must break its rule. The models are not in the repo yet. If this RFC is accepted I would like to check them in next to the core, so a change to `chat-turns.ts` can be checked the same way a test is run.

The implemented parts are covered by unit tests for `ChatTurns` (`__tests__/chat-turns.test.ts`) and by the host suites. Each behavior `Think` gained has a test that failed first: a stop during a running recovery, and a request cancelled while it waited in the queue. The existing host tests pass unchanged except for one helper that called a removed private method and one that waited out the removed retry.

## The alternatives

**Put `AIChatAgent` and `Think` on `ThinkHarness` now.** This is the destination for `Think`, and the harness design avoids most of these races by construction, because every input is a durable operation in one queue. It is too large a first step. `Think` has features the harness lacks (submissions, actions, channels, extensions, messengers, agent tools), and `AIChatAgent`'s contract (`onChatMessage` returns any `Response`) does not fit a loop that owns the model call. Converging the two classes first makes the later move smaller.

**A shared base class.** `AIChatAgent` and `Think` would extend a common `ChatAgent`. It makes every shared method part of each class's inheritance chain, where subclasses can override it, and it ties the core to `Agent`. `ThinkHarness` is a Lifecycle capability and could never use it. Composition keeps the core usable from a capability.

**Keep porting fixes by hand.** This is what we do now. Three of eight fixes needed a port, and each port was found by looking, not by a failing test.

## The decision

Accepted. Move the turn loop into `agents/chat` in the phases above, and where the hosts differ pick the behavior that is hardest to get wrong, as recorded in the table. D5 and D7 change what `AIChatAgent` apps can observe, so each ships as its own change with a changeset.
