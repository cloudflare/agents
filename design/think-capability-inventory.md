# Think — capability inventory

An inventory of what `@cloudflare/think` does, broken into capabilities, sized, with the public surface and shared state each one touches. Input for boundary/interface design; deliberately contains no proposal.

Counts from `packages/think/src/think.ts` at `3172a23`. Line counts are member spans (declaration to next declaration) and include doc comments. Every one of the 390 class members is assigned to exactly one capability; the assignment is a judgement call at the margins, but the mass distribution is not sensitive to those calls.

Related: [think.md](./think.md) · [think-vs-aichat.md](./think-vs-aichat.md) · [rfc-composable-rebuild.md](./rfc-composable-rebuild.md)

---

## Totals

`think.ts` is 15,862 lines:

| Region                                     | Lines  |
| ------------------------------------------ | ------ |
| Module-level types, constants, free helpers | 2,806  |
| Class body (390 members)                    | 13,056 |

The rest of the package is 11,981 lines outside `think.ts` (§ Outside the class).

## Distribution

| Capability               | Lines | Members |
| ------------------------ | ----: | ------: |
| actions / HITL           | 1,758 |      51 |
| chat recovery            | 1,477 |      38 |
| turn entry + admission   | 1,085 |      25 |
| agent-tool runs          |   998 |      33 |
| streaming                |   995 |      14 |
| inference loop           |   922 |      17 |
| submissions              |   863 |      35 |
| websocket protocol       |   777 |      15 |
| boot + config            |   493 |      11 |
| declared tasks           |   456 |      18 |
| extensions               |   441 |      17 |
| transcript store         |   410 |      22 |
| channels + messengers    |   394 |      21 |
| turn state + concurrency |   380 |      19 |
| context + overflow       |   354 |      12 |
| workflow notices         |   264 |       9 |
| model + prompt           |   261 |       6 |
| auto-continuation        |   208 |       8 |
| media eviction           |   159 |       5 |
| transcript repair        |   127 |       5 |
| telemetry                |   118 |       2 |
| skills                   |    92 |       5 |
| codemode                 |    23 |       1 |

Methods over 200 lines: `_prepareInferenceInvocation` (487), `_handleChatRequest` (405), `_streamResult` (394), `_streamResultToRpcCallback` (378), `_runProgrammaticMessagesTurn` (221), `_actionToTool` (201), `constructor` (205).

---

## The LLM call

### `model + prompt` — 261 lines, 6 members

Resolves a model id or `LanguageModel` to a provider instance, finds the Workers AI binding, builds the system prompt.

- **Surface** — `getModel()`, `getSystemPrompt()`, `getAIBinding()`, `resolveModel()`
- **State** — `_defaultProvider`
- **Note** — `_buildThinkCapabilityBlock` is 176 of the 261 lines. It generates prose describing the agent's own tools, skills and actions and injects it into the system prompt, so prompt construction reads the assembled toolset.

### `context + overflow` — 354 lines, 12 members

Converts the transcript into model messages, decides when to compact proactively, classifies context-overflow errors, drives reactive compaction-and-retry.

- **Surface** — `configureSession()`, `onChatError()`, `classifyChatError()`, `contextOverflow`
- **State** — `_proactiveCompactionsThisRun`, `_warnedMissingClassifier`, `_turnModelMessageBaseline`; reads `session`
- **Note** — default overflow classification is regex-over-error-message (`defaultContextOverflowClassifier`, module level). Compaction itself lives in Session.

### `inference loop` — 922 lines, 17 members

The `streamText` call and the agentic step loop around it: assembles the turn's toolset, wires `prepareStep`, applies per-tool-call decisions, fires every turn hook.

- **Surface** — `getTools()`, `beforeTurn()`, `authorizeTurn()`, `beforeStep()`, `beforeToolCall()`, `afterToolCall()`, `onStepEnd()`, `onStepFinish()`, `onChunk()`, `onChatResponse()`, `maxSteps`, `sendReasoning`, `chatStreamStallTimeoutMs`
- **State** — `_activeTurnTools`, `_insideInferenceLoop`, `_insideResponseHook`, `_activeStallTimeoutMs`, `_turnModelMessageBaseline`
- **Note** — `_prepareInferenceInvocation` (487 lines) is the densest coupling point in the package: it reaches into tools, actions, skills, MCP, codemode, extensions, telemetry, channels and the stall watchdog to build one `streamText` argument object.

### `telemetry` — 118 lines, 2 members

Span attributes for the turn — model, usage, finish reason, optionally message and tool payloads.

- **Surface** — `storeMessages`, `storeTools`
- **Note** — two complete parallel implementations (`_turnTelemetry`, `_turnTelemetryV7`) selected by an AI SDK feature probe.

---

## Tools and authority

### `actions / HITL` — 1,758 lines, 51 members

The largest capability. Wraps a declared `action()` into an AI SDK tool that can require approval, deduplicate by idempotency key, park itself durably mid-execution, resume after a restart, attach replies to the transcript, and be approved/rejected out of band.

- **Surface** — `getActions()`, `authorizeAction()`, `describePausedExecution()`, `pendingExecutions()`, `pendingApprovals()`, `approveExecution()`, `rejectExecution()`, `replyAttachments()`, `actionLedgerRetention`, `actionLedgerPendingRetryLeaseMs`, `actionPendingApprovalTtlMs`
- **Tables** — `cf_think_action_ledger`, `cf_think_action_pending_approvals`
- **State** — `_activeTurnActionMetadata`, `_activeTurnAuthorization`, `_activeTurnActionApprovalDescriptors`, `_activeTurnApprovedActionInputs`, `_activeActionLedgerExecutions`, `_activeTurnReplyAttachments`, `_activeTurnReplyAttachmentsRequestId`, `_actionLedgerTableEnsured`, `_actionPendingTableEnsured`
- **Note** — four separable concerns inside one capability: tool compilation (`_actionToTool`, 201), the idempotency ledger (~250), the approval/pause protocol (~500, including transcript annotation and stream-chunk rewriting), the out-of-band approve/reject API (~350). A further ~270 lines of serialization and error-envelope helpers sit at module level (L432–702).

### `skills` — 92 lines, 5 members

Loads skill sources into a `SkillRegistry`, refreshes on fingerprint change, exposes the catalog prompt and activation tools.

- **Surface** — `getSkills()`, `getSkillScriptRunner()`
- **State** — `_skillRegistry`, `_loggedSkillWarnings`, config key `skillsFingerprint`
- **Note** — thin; the engine is `agents/skills`. Already a clean boundary.

### `extensions` — 441 lines, 17 members

Loads user code into separate Worker isolates and pipelines their hooks through the turn (before-turn, tool-call start/finish, step-finish, chunk). Exposes a host bridge so extension code can read/write files, context and messages back in the agent.

- **Surface** — `getExtensions()`, `extensionLoader`, `hookTimeout`
- **State** — `extensionManager`, nine `_host*` bridge methods
- **Note** — plus 1,171 lines in `src/extensions/`. The host bridge is effectively a second, informal public API — extension code sees a different surface than a subclass does.

### `codemode` — 23 lines, 1 member

Resolves the codemode runtime handle so tools can be exposed as a callable TypeScript API instead of individual tool schemas. Almost entirely delegated to `@cloudflare/codemode`.

### `MCP` — 2 config fields

Auto-converts connected MCP server tools into AI SDK tools; optionally blocks the turn until connections are ready.

- **Surface** — `includeMcpTools`, `waitForMcpConnections`
- **Note** — has no module of its own in `think.ts`. Two fields consumed inside `_prepareInferenceInvocation`, all real work in `agents/mcp`. Listed because it is a real capability that is almost invisible in the file.

---

## The transcript

### `transcript store` — 410 lines, 22 members

Keeps an in-memory message cache in sync with Session; sanitizes and size-limits rows before persisting; strips internal parts and reserved metadata in both directions.

- **Surface** — `messages` getter, `getMessages()`, `clearMessages()`, `appendMessageToHistory()`, `updateMessageInHistory()`, `syncMessagesFromStorage()`
- **State** — `session`, `_cachedMessages`, `_lastHydration`, `hydrationByteBudget`
- **Note** — the cache subscribes to Session change events in the constructor. Almost every other capability reads `this.messages` rather than storage, making this cache a de facto shared bus.

### `media eviction` — 159 lines, 5 members

Finds oversized inline media in aged messages and moves it to workspace files so the stored transcript stops growing without bound.

- **Surface** — `mediaEviction`
- **State** — `_mediaEvictionRunning`, `_mediaEvictionScheduled`, `_mediaEvictionObservedOversized`, `_warnedEvictionUnsupported`
- **Note** — plus 253 lines in `media-eviction.ts`. Requires a Session provider implementing `getHistoryRowStats`; silently a no-op otherwise.

### `transcript repair` — 127 lines, 5 members

Finds tool parts left unsettled by an interrupted turn and rewrites them so the next provider call does not reject the transcript.

- **Surface** — `repairInterruptedToolPart()`
- **Note** — provider-specific (`_repairTranscriptForProvider` branches on the model). Runs before every turn and on recovery.

---

## Getting work in

Five entry paths, each with its own admission rules, durability story and recovery path.

### `turn entry + admission` — 1,085 lines, 25 members

The gate every turn passes through. Decides queue vs submit vs execute, normalizes messages, provides the programmatic entry points.

- **Surface** — `chat()`, `runTurn()` (wait/submit/stream), `saveMessages()`, `addMessages()`, `continueLastTurn()`
- **State** — `_turnQueue`, `admittedTurnContext` (AsyncLocalStorage), `_insideInferenceLoop`
- **Note** — the admission decision is the most important control-flow branch in the class and is shared by all five entry paths.

### `websocket protocol` — 777 lines, 15 members

Speaks the `cf_agent_chat_*` wire protocol: request, clear, stream-resume request/ack, message broadcast, idle-connect frame.

- **Surface** — `broadcast()` override
- **State** — `_lastClientTools`, `_lastBody`, `_loggedProtocolWarnings`; persisted config keys `lastClientTools`, `lastBody`
- **Note** — `_handleChatRequest` (405 lines) does protocol parsing, message reconciliation, persistence, admission and turn dispatch in one method.

### `submissions` — 863 lines, 35 members

A durable queue of programmatic turns: accept with an idempotency key, persist, drain one at a time, track status, reconcile anything left running after a restart.

- **Surface** — `submitMessages()`, `inspectSubmission()`, `listSubmissions()`, `cancelSubmission()`, `deleteSubmission()`, `deleteSubmissions()`, `onSubmissionStatus()`
- **Tables** — `cf_think_submissions` (+ 3 indexes)
- **State** — `_submissionTableEnsured`, `_drainingSubmissions`, `_submissionAbortControllers`, `_programmaticStreamErrors`, `submissionRecoveryStaleMs`
- **Note** — ~200 lines are start-up reconciliation deciding whether an interrupted submission is genuinely recoverable; it cross-checks the chat-recovery machinery, so the two capabilities are mutually aware.

### `declared tasks` — 456 lines in class + ~306 module-level, 18 members

Code-defined scheduled tasks. Parses a schedule grammar (`every 5m`, `daily at 09:00`, weekday/weekly), reconciles declarations against stored rows on every boot, fires either a prompt or a handler.

- **Surface** — `getScheduledTasks()`, `getDefaultTimezone()`
- **Tables** — `cf_think_scheduled_tasks`
- **State** — `_declaredScheduledTasksTableEnsured`
- **Note** — carries ~306 module-level lines of schedule parsing and timezone maths (L702–1008), including a DST-safe wall-clock resolver (`findZonedInstant`) that scans minute by minute. Sits on top of `Agent.schedule()` rather than extending it.

### `channels + messengers` — 394 lines, 21 members

Routes turns to and from external surfaces by stamping a channel onto each message, tracking the active delivery surface, rendering attachments, and pushing unprompted notices out.

- **Surface** — `getMessengers()`, `configureChannels()`, `deliverNotice()`, `renderAttachment()`, `chatWithMessengerContext()`, `bindActiveDeliverySurface()`, `activeChannel`, `activeTurnMetadata`
- **State** — `_activeMessengerContext`, `_activeChannelContext`, `_activeDeliverySurface`, `_messengerRuntime`, `_channels`
- **Note** — plus 2,062 lines in `src/messengers/` and `src/channels/`. Four ambient "active" fields make this the second-largest source of implicit per-turn state after actions.

---

## Getting output out, and staying alive

### `streaming` — 995 lines, 14 members

Turns a model stream into client-visible events, persists chunks for replay on reconnect, captures partial output when a stream is orphaned by an eviction.

- **State** — `_resumableStream`, `_pendingResumeConnections`, `_resumeHandshakeInstance`, `_streamingAssistant`, `_streamProgressCredit`
- **Note** — `_streamResult` (394) and `_streamResultToRpcCallback` (378) are near-parallel implementations of the same pipeline for two output targets. Any change has to land in both.

### `agent-tool runs` — 998 lines, 33 members

The child half of sub-agent orchestration: tracks runs started by a parent, streams chunks and progress milestones back up, formats detached completions/milestones as messages, reconciles runs left stale by a restart.

- **Surface** — `startAgentToolRun()`, `cancelAgentToolRun()`, `inspectAgentToolRun()`, `tailAgentToolRun()`, `getAgentToolChunks()`, `formatAgentToolInput()`, `getAgentToolSummary()`, `formatDetachedCompletion()`, `formatDetachedMilestone()`, `reportProgress()`
- **Tables** — `cf_agent_tool_child_runs`, `cf_agent_tool_milestones`
- **State** — seven `_agentTool*` maps keyed by run id, plus `_agentToolRunsByRequestId`, `_agentToolProgressEmitterInstance`
- **Note** — the parent half lives in `Agent` (`runAgentTool`); `AIChatAgent` carries a third copy of this child-side mirror.

### `workflow notices` — 264 lines, 9 members

A durable outbox for Cloudflare Workflow callbacks, so a workflow completing while the agent is evicted still produces a turn.

- **Tables** — `cf_think_workflow_notifications` (+ index)
- **State** — `_workflowNotificationTableEnsured`, `_drainingWorkflowNotifications`
- **Note** — plus 293 lines in `workflows.ts`. Structurally the same drain-and-recover loop as submissions, written separately.

### `auto-continuation` — 208 lines, 8 members

After a turn ends with unresolved client tool calls, decides whether to fire another turn — including when no client connection is present.

- **State** — `_continuation`, `_autoContinuation` (controller types from `agents/chat`)
- **Note** — interacts with admission, turn state and recovery: a continuation can be armed, deferred, re-armed for a batch, or fired connectionless.

### `turn state + concurrency` — 380 lines, 19 members

Aborts, stability probes, serialization of out-of-band interactions. Answers "is this agent quiescent?".

- **Surface** — `waitUntilStable()`, `hasPendingInteraction()`, `cancelChat()`, `cancelAllChats()`, `resetTurnState()`, `messageConcurrency`
- **State** — `_aborts`, `_preStream`, `_submitConcurrency`, `_pendingInteractionPromise`, `_interactionApplyTail`

### `chat recovery` — 1,477 lines, 38 members

Wraps each turn in a durable fiber and, after an interruption, decides what to do: retry the user turn, continue from the partial assistant message, park for a pending approval, reschedule, or seal and give up. Handles stalls, memory-limit resets, recovery-callback failures.

- **Surface** — `onChatRecovery()`, `chatRecovery`, `CHAT_FIBER_NAME`
- **Alarms** — `_chatRecoveryRetry`, `_chatRecoveryContinue` (registered via `_cf_recoveryAlarmCallbacks` so the OOM breaker can find them)
- **State** — `_activeChatRecoveryRootRequestId`, `_chatRecoveryEngineInstance`, `_agentToolStreamProgress`
- **Note** — reaches into nearly every other capability: submissions (marks them interrupted), agent-tool runs (progress as a liveness signal), streaming (orphaned partials), actions (pending approvals park recovery), admission. The capability that most resists being drawn as a box.

### `boot + config` — 493 lines, 11 members

An eleven-phase ordered startup — workspace, session, skills, hydration, extensions, protocol handlers, channels, user `onStart`, task reconcile, durable-work recovery, eviction pass — plus a typed key/value config store with legacy migration.

- **Surface** — `configure()`, `getConfig()`, `getOnStartDegradations()`
- **Tables** — `think_config`
- **State** — `#configCache`, `#configTableReady`, `_onStartDegradations`
- **Note** — implemented by reassigning `this.onStart` to a closure in the constructor. Phases 9–11 are wrapped in `_runBestEffortOnStartStep` so a failure degrades rather than bricking the object.

---

## Outside the class

11,981 lines in the rest of the package.

| Area               | Files                                                       | What it is                                                                                       | Lines |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----: |
| `tools/`           | workspace · fetch · execute · browser · sandbox · extensions | Built-in toolset. `workspace.ts` (1,575) and `fetch.ts` (1,109) carry their own policy layers.    | 3,410 |
| `cli/`             | init · create · studio · connect · inspect · state · target  | The `think` CLI — scaffolding, local studio, remote inspect and state tools.                      | 1,922 |
| `messengers/`      | chat-sdk · delivery · events · telegram                      | External surface adapters and the delivery/event plumbing behind `deliverNotice()`.               | 1,887 |
| `framework/`       | config · discovery · project · codegen · manifest · virtual  | Project-level concerns: config parsing, agent discovery, type/manifest codegen. Build-time.       | 1,727 |
| `extensions/`      | manager · hook-proxy · host-bridge · bridge-provider         | The isolate-loading extension runtime behind the in-class extension hooks.                        | 1,171 |
| `server-entry.ts`  | —                                                            | Worker entry point: routing, request handling, asset serving.                                     |   527 |
| `vite.ts`          | —                                                            | Vite plugin — decorator transform, virtual modules.                                               |   329 |
| `workflows.ts`     | —                                                            | Workflow prompt context and the Think-side workflow surface.                                      |   293 |
| `media-eviction.ts` | —                                                           | The eviction scan and externalization logic.                                                      |   253 |
| `channels/`        | index                                                        | Channel definition normalization.                                                                 |   175 |
| `react.tsx`        | —                                                            | Client hook re-exports.                                                                           |    77 |

---

## Two observations

Offered as input to the boundary conversation, not as conclusions.

**The per-turn state is the real interface problem.** Of the 96 instance fields on `Think`, a large group are ambient per-turn values: `_activeTurnTools`, `_activeTurnActionMetadata`, `_activeTurnAuthorization`, `_activeTurnApprovedActionInputs`, `_activeTurnReplyAttachments`, `_activeChannelContext`, `_activeDeliverySurface`, `_activeMessengerContext`, `_streamingAssistant`, `_turnModelMessageBaseline`, `_activeStallTimeoutMs`, `_activeChatRecoveryRootRequestId`. Each is written by one capability and read by two or three others, with correctness resting on turns being serialized by the turn queue. Any decomposition has to decide whether these become an explicit turn-context value passed between modules or stay ambient — that single decision determines how independently the modules can be tested and swapped.

**Five entry paths, one loop.** WebSocket request, RPC `chat()`, `runTurn()`, durable submissions, declared scheduled tasks, workflow notices and auto-continuation all converge on the same inference loop, but each brought its own admission logic, durability story and recovery path with it. That fan-in — rather than the loop itself — is where most of the 13,000 lines went.
