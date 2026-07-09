# Primitive catalog prep

Prepared for wayfinder ticket
[`Primitive catalog & boundary map (Agent + Think)`](tickets/02-primitive-catalog-boundary-map.md).

This is research/preparation, not the final resolution. It turns the `Agent` and
`Think` god-class inventories into a candidate primitive catalog that can be
reviewed and tightened before the ticket is closed.

## Constraints from Composition model & registration flow

- Primitive construction shape: plain `(ctx, deps)` objects; `env` is read only
  at the composition root.
- Primitive surface: optional DO-shaped methods such as `fetch`,
  `webSocketMessage`, `webSocketClose`, `webSocketError`, and `alarm`.
- Host shape: author extends a thin, dispatch-only `PrimitiveHost`; no domain
  behavior or state lands on the host.
- Worker shape: generic Worker forwarder plus app-level DO instance addressing;
  the DO-side primitive chain owns per-primitive dispatch.
- Deferred by ticket 01: storage namespacing, Worker-to-DO instance addressing,
  shared alarm storage, WebSocket/channel multiplexing.

## Boundary heuristics

- A primitive should own one durable ledger or one boundary protocol, not both
  unless they are inseparable.
- Physical `alarm()` is not a primitive by itself. It is a shared host entrypoint
  that must dispatch into scheduling, keep-alive, fiber recovery, chat recovery,
  detached agent-tool reconcile, declared tasks, submissions, and outboxes.
- `sql` should be substrate, not a product primitive. Primitives should own their
  tables and depend on a small storage helper rather than inheriting `this.sql`.
- Streaming is not one primitive. RPC streams, chat resumable streams, agent-tool
  tails, and client broadcast/replay have different ownership and storage.
- Channel is the first true edge-facing primitive family: it owns incoming/outgoing
  boundary dispatch and should be the pressure test for ticket 03.
- Most Think features are inner primitives over Session, turn running, tools, and
  streams; only chat protocol/channels expose boundary entrypoints directly.

## Agent candidate catalog

| Primitive                  | Current subsystem(s)                  | Responsibility                                                         | Storage owned/touched                                                       | Entry points / events                                      | Dependencies / boundary notes                                       |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `AgentStateStore`          | State, connection state               | Persist agent state, validate updates, broadcast state protocol frames | `cf_agents_state`; WebSocket attachment flags                               | RPC/callable state updates; WebSocket state messages       | Split durable state from connection-local flags                     |
| `DurableSqlStore`          | SQL helper                            | Parameterized SQLite access and error normalization                    | Shared SQLite substrate                                                     | Internal only                                              | Better treated as substrate dependency than user-facing primitive   |
| `SchemaMigrator`           | Migrations/schema                     | Create and migrate primitive-owned tables                              | Core `cf_agents_*` tables                                                   | Host construction/startup; destroy                         | Should become per-primitive migrations plus a coordinator           |
| `ProtocolRouter`           | WebSocket/HTTP, PartyServer lifecycle | Route HTTP and WebSocket protocol frames; wrap lifecycle hooks         | WebSocket attachments; reads state/tool replay stores                       | `fetch`; `onConnect`; `onMessage`; `onClose`               | Existing Agent relies on PartyServer, rethink should use DO methods |
| `CallableRpcRouter`        | RPC/callable methods                  | Expose decorated methods over protocol messages                        | None directly                                                               | WebSocket `RPC` messages                                   | Depends on protocol router and optional stream responder            |
| `RpcStreamResponder`       | Streaming RPC                         | Send streaming callable chunks over RPC                                | None directly                                                               | WebSocket RPC streaming                                    | Keep separate from chat resumable streams                           |
| `ScheduleStore`            | Scheduling/alarms                     | Durable delayed/date/cron/interval callback rows                       | `cf_agents_schedules`                                                       | Public schedule APIs; `alarm`                              | Needs shared alarm coordinator decision                             |
| `AlarmScheduler`           | Scheduling/alarms                     | Arm physical DO alarm and execute due schedule rows                    | `cf_agents_schedules`; DO alarm slot                                        | `alarm`                                                    | Must coexist with all other alarm consumers                         |
| `KeepAliveLeaseManager`    | Keep-alive leases                     | Ref-counted heartbeat leases to keep a DO warm during long work        | No SQL; physical DO alarm                                                   | Public `keepAlive`; `alarm` heartbeat                      | Depends on alarm coordinator, not scheduler rows                    |
| `LocalTaskQueue`           | Queues                                | SQLite-backed local callback queue and flush loop                      | `cf_agents_queues`                                                          | Public queue APIs; in-process flush                        | Not Cloudflare Queues                                               |
| `RetryPolicy`              | Retries                               | Retry option resolution, jitter, platform error classification         | Retry options serialized into queue/schedule rows; OOM alarm strike key     | Queue/schedule/workflow/MCP operations                     | Pure service plus small durable strike counter                      |
| `FiberRuntime`             | Fibers                                | Durable execution markers, checkpoint recovery, cancellation           | `cf_agents_runs`; `cf_agents_fibers`; `cf_agents_facet_runs`                | Public fiber APIs; startup recovery; `alarm`               | Needs host-provided recovery hooks                                  |
| `EmailInboundRouter`       | Email                                 | Route Email Routing messages to named DO instances                     | None in Agent SQL                                                           | Worker `email`; DO RPC bridge                              | Edge-facing Worker forwarder plus DO delivery method                |
| `EmailOutboundService`     | Email                                 | Send/reply/forward/reject outbound email                               | None in Agent SQL                                                           | Called by email handlers/tools                             | Depends on env binding adapter                                      |
| `FacetManager`             | Sub-agents/facets                     | Create, list, delete, and address colocated child facets               | Parent `cf_agents_sub_agents`; child facet metadata keys                    | Public facet APIs; destroy                                 | Separates registry from routing bridge                              |
| `SubAgentRouter`           | Sub-agents/facets                     | Route HTTP/WebSocket/RPC to child facets                               | Parent/child identity metadata                                              | Parent `fetch`; virtual WebSocket events                   | Edge-facing, probably channel-adjacent                              |
| `VirtualConnectionBridge`  | Sub-agents/facets                     | Adapt parent WebSocket lifecycle into child virtual connections        | WebSocket attachment metadata                                               | Virtual connect/message/close                              | Could compose with protocol router                                  |
| `AgentToolParentRuntime`   | Agent-tools parent side               | Spawn child agent runs, track lifecycle, replay/tail chunks, cancel    | `cf_agent_tool_runs`                                                        | Public `runAgentTool`; reconnect replay; `alarm` reconcile | Parent-side runtime, child side belongs near chat/Think             |
| `DetachedRunBackbone`      | Agent-tools detached runs             | Background run reconciliation and milestone/progress tracking          | `cf_agent_tool_runs`; milestone/progress rows in child runtimes             | `alarm`; reconnect replay                                  | Cross-cutting with scheduler/fibers                                 |
| `AgentToolChildRuntime`    | Agent-tools child side                | Run child chat-capable agent work and expose tail/cancel/inspect       | Think `cf_agent_tool_child_runs`; AI chat child run tables; stream metadata | Child RPC methods; stream tail                             | Chat-specific formatting stays in Think/AIChat                      |
| `ChatResumableStreamStore` | Streaming/chat shared code            | Persist and replay chat stream chunks and metadata                     | `cf_ai_chat_stream_chunks`; `cf_ai_chat_stream_metadata`                    | Chat stream production; reconnect resume                   | Shared `agents/chat` primitive, not Agent-specific                  |
| `WorkflowBridge`           | Workflows                             | Start Workflows, track runs, route callbacks/events                    | `cf_agents_workflows`; external Workflows binding state                     | Public workflow APIs; DO callback RPC                      | Boundary to Cloudflare Workflows service                            |
| `McpClientRuntime`         | MCP client                            | Persist MCP server registrations, connect/restore, OAuth callback flow | `cf_agents_mcp_servers`; OAuth provider DO storage                          | `onStart`; OAuth callback fetch; public MCP APIs           | Separate from MCP server runtime                                    |
| `AgentEventBus`            | Observability                         | Emit typed diagnostics events                                          | None                                                                        | Internal emit calls                                        | Inject into primitives instead of central god method                |

## Think candidate catalog

| Primitive                    | Current subsystem(s)                            | Responsibility                                                                  | Storage owned/touched                                                                        | Entry points / events                                       | Dependencies / boundary notes                                |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `SessionMemory`              | Message history                                 | Durable tree/history/context/compaction; transcript source of truth             | Session tables; assistant messages; compaction/config rows                                   | Chat turns; save/add/clear messages                         | Existing Session should remain the durable memory primitive  |
| `MessageCache`               | Message history                                 | Server-authoritative cache and transcript repair before model calls             | In-memory `_cachedMessages`; Session reads/writes; workspace media files                     | Chat request; recovery/orphan persist                       | Think-owned adapter over Session                             |
| `ThinkConfigStore`           | Config/model/session                            | Persist per-agent config, model settings, skill fingerprints, last client body  | `think_config`; legacy `assistant_config` reads                                              | `configure`; `getConfig`; protocol resume                   | Split from model resolution                                  |
| `ModelResolver`              | Config/model/session                            | Resolve model/provider/system prompt defaults                                   | Reads config and env-provided bindings                                                       | Per-turn inference setup                                    | Pure service dependency                                      |
| `TurnRunner`                 | Inference loop                                  | Assemble tools/messages/system and call `streamText`                            | Reads Session/cache; writes through stream/tool callbacks                                    | `chat`; `runTurn`; submissions; auto-continuation; recovery | Think-owned convergence point                                |
| `TurnQueue`                  | Turn lifecycle                                  | Admission, serialization, abort/reset, terminal status                          | In-memory turn queue and abort registry; terminal records through recovery helpers           | Chat/save/continue/retry/cancel                             | Existing shared `agents/chat` code is close                  |
| `ToolRegistry`               | Tools/actions, MCP/client/skill/extension tools | Merge workspace, fetch, user, action, extension, context, skill, MCP tools      | Tool/action metadata maps; workspace files/SQL as tool dependencies                          | Per-turn tool assembly                                      | Think-specific assembly over many sources                    |
| `ActionRuntime`              | Tools/actions                                   | Convert action descriptors to executable AI SDK tools with auth/timeouts        | Action metadata maps; pending/ledger stores through dependencies                             | AI SDK `execute`; hooks                                     | Depends on approval registry and ledger                      |
| `ActionLedger`               | Action ledger                                   | Idempotency, coalescing, stale pending reclaim, retention sweep                 | `cf_think_action_ledger`; `cf_think_action_ledger:last_swept_at`                             | Action execution; startup sweep                             | Strong standalone primitive                                  |
| `ApprovalRegistry`           | HITL/pending executions                         | Store parked action/codemode approvals and approve/reject them                  | `cf_think_action_pending_approvals`; codemode runtime storage; transcript tool parts         | Approval callables; client approval protocol                | Think-specific piece updates transcript and continues model  |
| `ExtensionRuntime`           | Extensions                                      | Load sandboxed Worker extensions, expose hooks/tools/context                    | DO storage keys `ext:*`; Session context labels                                              | Startup/init; per-turn hooks/tools                          | Already primitive-like in `extensions/manager.ts`            |
| `SkillRegistry`              | Skills                                          | Load Agent Skills catalog, script runner, skill context/tools                   | `think_config.skillsFingerprint`; Session context block                                      | Startup/fingerprint refresh; per-turn tool assembly         | Belongs outside Think, adapted by tool registry              |
| `ChannelRegistry`            | Channels                                        | Configure channel policies, instructions, tool narrowing, delivery surfaces     | Message metadata `channel`; transcript notices; messenger state                              | `configureChannels`; per-turn policy; notices               | Edge-facing; ticket 03 should sharpen routing/claiming       |
| `MessengerRuntime`           | Channels/chat protocol                          | Deliver notices/responses to web/messenger/voice/custom channels                | Messenger state, transcript notices                                                          | Channel delivery events                                     | Outbound half of channel primitive                           |
| `AgentToolChatAdapter`       | Sub-agent tools                                 | Format child agent-tool input/output as chat messages                           | `cf_agent_tool_child_runs`; milestones; stream metadata                                      | Agent-tool child RPC; stream tail                           | Parent/child runtime can be shared, formatting remains Think |
| `SubmissionQueue`            | Submissions                                     | Durable programmatic queued turns with idempotency and inspection/cancel        | `cf_think_submissions`; stream metadata; Session transcript                                  | `submitMessages`; `alarm` drain; startup drain              | Strong standalone inner primitive                            |
| `DeclaredTaskRegistry`       | Declared scheduled tasks                        | Reconcile code-declared recurring tasks and advance recurrence                  | `cf_think_scheduled_tasks`; base Agent schedule rows                                         | Startup reconcile; scheduled callback                       | Depends on Agent schedule primitive                          |
| `WorkflowNotificationOutbox` | Workflow notifications                          | Notify Workflows when prompt/submission terminalizes                            | `cf_think_workflow_notifications`; submission metadata `__thinkWorkflowPrompt`               | Submission terminalization; drain; workflow events          | Thin outbox over WorkflowBridge                              |
| `WorkflowPromptAdapter`      | Workflow notifications                          | Encode workflow prompt as chat turn and final-answer tool                       | Session transcript; submission metadata                                                      | Workflow prompt turn                                        | Think-specific adapter                                       |
| `ChatRecoveryEngine`         | Chat recovery                                   | Recover after eviction/deploy/stalls, classify retry/continue, persist partials | `cf_agents_runs`; `cf_ai_chat_stream_metadata/chunks`; recovery progress/terminal keys       | Fiber recovery; stall watchdog; scheduled retry/continue    | Already shared-ish; Think supplies adapter hooks             |
| `ContextWindowGuard`         | Context-overflow                                | Proactive compaction and reactive compact-and-retry on provider overflow        | Session compaction; transcript/cache                                                         | Before-step guard; stream error handling                    | Depends on Session and model-message assembler               |
| `AutoContinuationController` | Auto-continuation                               | Continue after tool results/approvals and coalesce batches                      | In-memory continuation state; transcript tool parts; `think_config.lastClientTools/lastBody` | Tool-result/approval protocol; stream-finalized hook        | Existing shared `agents/chat` controller is close            |
| `ChatProtocolServer`         | Chat protocol                                   | WebSocket protocol for `useAgentChat`/`useChat`, resume, clear/cancel           | `think_config.lastClientTools/lastBody`; Session; stream metadata                            | `onConnect`; `onMessage`; `onRequest`                       | Edge-facing protocol primitive, channel-adjacent             |

## Cross-cutting storage groups

- Agent core state: `cf_agents_state`.
- Agent scheduler/queue/workflow/fiber tables: `cf_agents_schedules`,
  `cf_agents_queues`, `cf_agents_workflows`, `cf_agents_runs`,
  `cf_agents_fibers`, `cf_agents_facet_runs`.
- Agent registry/tooling tables: `cf_agents_sub_agents`,
  `cf_agent_tool_runs`, `cf_agents_mcp_servers`.
- Think config and action tables: `think_config`, `cf_think_action_ledger`,
  `cf_think_action_pending_approvals`.
- Think queued-work/outbox tables: `cf_think_submissions`,
  `cf_think_scheduled_tasks`, `cf_think_workflow_notifications`.
- Chat stream/recovery tables: `cf_ai_chat_stream_metadata`,
  `cf_ai_chat_stream_chunks`.
- Session/memory tables: owned by `Session`, with Think currently acting as a
  chat-specific adapter around them.

## Open boundary questions

- Should `SchemaMigrator` be a real primitive or only a host service that collects
  migrations from primitives?
- Should `AlarmScheduler`, `KeepAliveLeaseManager`, `FiberRuntime`, chat recovery,
  submissions, and declared tasks share one `AlarmCoordinator`, or should each
  expose `nextAlarm()` and let `PrimitiveHost` reconcile the single DO alarm slot?
- Is `ChannelRegistry` one primitive with adapters, or should each concrete
  channel be its own edge-facing primitive with a shared channel contract?
- Does `ChatProtocolServer` belong inside channel primitives, or is it the
  protocol-specific edge primitive for the web channel only?
- Where does Worker-to-DO instance addressing live for non-fetch events such as
  email and queue once channels can be composed?
- Which storage namespacing rule is enough for first release: convention-only
  table prefixes, a storage helper that requires primitive names, or migration
  registration with generated prefixes?
- Should `AgentToolParentRuntime`, `AgentToolChildRuntime`, and
  `AgentToolChatAdapter` be one product primitive or three composable ones?
- Does `Think` keep a single `TurnRunner` as the composition root for chat, or can
  inference, tool execution, stream persistence, recovery, and continuation all
  compose without a new god primitive?

## Suggested next step for the ticket

Review this prep with the ticket 01 constraints and collapse the candidate list
into the catalog the spec should commit to. The final ticket answer should likely
separate:

- Substrate services: SQL helper, migrations, alarm coordination, event bus.
- Edge-facing primitives: channels, chat protocol, email, sub-agent routing.
- Inner primitives: state, schedules, queues, fibers, tools/actions, submissions,
  recovery, workflows, MCP, Session/memory, config/model, turn running.
