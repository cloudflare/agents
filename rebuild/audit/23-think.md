# 23 — `app/think.ts`: the Think composition root

The rebuilt `Think extends Agent` composes the chat domain services. Like
Agent, it should hold wiring + the overridable configuration surface only.
Everything with behavior lives in a domain module.

## Configuration surface (overridables — the "subclass API")

| Member | Default | Maps to |
| ------ | ------- | ------- |
| `getModel(): ModelClient` | throws | turn engine model |
| `getSystemPrompt(): string` | small careful-assistant default | base prompt when no context blocks |
| `getTools(): ToolSet` | `{}` | registry `user` source |
| `getActions(): Record<string, Action>` | `{}` | ActionService.compile |
| `getSkills(): SkillSource[]` | `[]` | SkillRegistry |
| `configureSession(builder)` | identity | SessionConfig builder (withContext / withCachedPrompt / onCompaction / compactAfter) |
| `configureChannels(): Record<string, ChannelDefinition>` | `{}` | ChannelService |
| `getScheduledTasks(): DeclaredTasks` | `{}` | ScheduledTaskService |
| `getDefaultTimezone()` | undefined | DSL timezone resolution |
| `maxSteps` | 10 | TurnConfig default |
| `sendReasoning` | true | TurnConfig default |
| `chatRecovery` | true | RecoveryPolicy (or `{ maxAttempts, terminalMessage, onExhausted }`) |
| `chatStreamStallTimeoutMs` | 0 (off) | stall watchdog default |
| `contextOverflow` | undefined | OverflowGuard config |
| `classifyChatError` | undefined | OverflowGuard classifier |
| `actionLedgerPendingRetryLeaseMs` | 300_000 | ActionService lease |
| `workspaceTools` | true | include workspace ToolSet |
| `fetchTools` | false | FetchToolConfig |
| hooks | — | `beforeTurn`, `beforeStep`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk`, `onChatResponse(result)`, `onChatError(error, ctx)`, `authorizeTurn`, `authorizeAction`, `repairInterruptedToolPart(part)`, `onChatRecovery(ctx)`, `renderAttachment(att)`, `onAgentToolStart/Finish`, `onProgress` |

`configure(config)` / `getConfig()`: persist an arbitrary JSON config blob
(`cfg:` prefix) — server-private, unlike broadcast `state`.

## Turn orchestration (the one real method: `runTurnInternal`)

All entry points funnel here through the TurnQueue:

```
input → stamp channel → persist user messages (session.appendMessage)
  → assemble: session history (+repair) / frozen system prompt + channel
    instructions + skills catalog + capability block / tools (builtin:
    workspace+session+skills, external, actions, user, client) filtered by
    channel policy
  → actionService.authorizeTurnOnce
  → recovery.runRecoverable(engine.run(...))
  → fan out chunks: accumulator + resumable buffer + connection broadcast
    (cf_agent_use_chat_response frames) + StreamCallback relay when present
  → outcome handling:
      completed  → persist assistant message, session status broadcast,
                   renderAttachment delivery, onChatResponse({ attachments }),
                   message:response event
      suspended  → persist partial with pending tool part (client tool /
                   approval / durable-pause)
      aborted    → persist partial, message:cancel event
      error      → overflowGuard.handleTurnError → retry | terminal
                   (partial persisted; onChatError with stage+classification)
  → auto-continuation check (below)
```

## Entry points

| API | Semantics |
| --- | --------- |
| `chat(input, callback?, opts?)` | run a turn; with a StreamCallback (sub-agent RPC): `onStart({requestId})` → `onEvent(json chunk)`* → `onDone()` / `onError(msg)` / `onInterrupted?()` (stall-recovery, doc 14) |
| `runTurn({ input, channel?, mode })` | `wait` → TurnResult; `submit` → SubmissionService.submit; `stream` → callback mode |
| `saveMessages(messages)` | append + run turn, wait for completion |
| `submitMessages(messages, opts)` | durable submission (doc 11) |
| `getMessages()` / `clearMessages()` | store + broadcast `cf_agent_chat_clear`, mark pending submissions skipped, cancel running turn |
| `cancelChat(requestId, reason?)` / `cancelAllChats()` | TurnQueue.cancel |
| `continueLastTurn()` | enqueue a continuation turn |
| `pendingApprovals` / `approveExecution` / `rejectExecution` | ActionService; approve → write tool output into persisted message → auto-continue |
| `replyAttachments(requestId?)` | ActionService.attachments |
| `deliverNotice(text, opts?)` | ChannelService |
| `reconcileScheduledTasks()` | ScheduledTaskService.reconcile |
| agent-tool client surface | `startAgentToolRun`, `cancelAgentToolRun`, `inspectAgentToolRun`, `tailAgentToolRun` (readEvents), `clearAgentToolRuns` (doc 19) |

## WebSocket protocol (over Agent's `onUnhandledMessage`)

Frame names keep the original vocabulary:
- in: `cf_agent_use_chat_request { id, messages | input, clientTools?, channel? }`
  → runTurn (admission queue); `cf_agent_chat_clear`;
  `cf_agent_chat_request_cancel { id }`; `cf_agent_stream_resume_request`;
  `cf_agent_stream_resume_ack`; `cf_agent_tool_result { toolCallId, output }`;
  `cf_agent_tool_approval { toolCallId | executionId, approved, reason? }`
- out: `cf_agent_chat_messages` (full sync on connect),
  `cf_agent_use_chat_response { id, chunk, replay? }` (one UiChunk per frame),
  `cf_agent_message_updated`, `cf_agent_chat_clear`,
  `cf_agent_stream_resuming` / `cf_agent_stream_resume_none` /
  `cf_agent_stream_pending`, `cf_agent_chat_recovering { active }`,
  `cf_agent_session { phase, tokenEstimate, tokenThreshold }`.

Resume handshake: on `resume_request`, consult ResumableStreamBuffer:
active stream → `resuming` + replay chunks (`replay: true`) + live continue;
recently settled → `resuming` + replay; none → `resume_none`. On connect also
replay `cf_agent_chat_recovering` if recovery is in flight.

## Client tool results & auto-continuation

- `cf_agent_tool_result`: apply output to the persisted assistant message's
  matching tool part (`input-available → output-available`), broadcast
  `cf_agent_message_updated`, then **auto-continuation**: when every tool part
  of the last assistant message is settled, debounce (~150ms fake-timer
  friendly) and enqueue a continuation turn so the model sees the results.
- `cf_agent_tool_approval` for approval-gated tools: approved → execute
  server-side (or emit to client for client tools) and continue as above;
  rejected → tool part `output-error` ("denied: reason") + continuation.
- Approvals for durable-pause parked executions route to
  `approveExecution`/`rejectExecution`.

## Child-mode (`chat()` relay) specifics
- `onEvent` receives each UiChunk serialized as JSON.
- Cancellation: parent calls `cancelChat(requestId)`.
- Stall-recovery mid-child-turn → `onInterrupted()` then the relay is dropped;
  the continuation (later) settles the run via the delegation reconciliation
  (doc 19).

## Assembly order caution
Channel policy is applied to defaults, `beforeTurn` overrides win, engine
composes `stopWhen` with maxSteps. The capability block + skills catalog are
appended to the (frozen) system prompt per turn, not baked into it.

## Tests (integration over memory adapters + FakeModel)
- text turn end-to-end over a MemoryConnection: request frame → chunk frames →
  messages persisted → `cf_agent_chat_messages` on reconnect.
- resume handshake mid-stream (second connection replays with replay flag).
- client tool: suspension, tool_result frame → message updated → continuation
  turn runs (FakeModel second script).
- approval frame approve + reject paths.
- clearMessages: broadcast + pending submissions skipped + running turn
  cancelled.
- channel policy: declared channel instructions prepended (FakeModel captured
  request), maxTurns cap, beforeTurn override wins.
- recovery e2e: kill mid-turn (FakeModel error after partial), bounded retries,
  terminal message at exhaustion (covered deeper in doc 24).
