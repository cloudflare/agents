# 30 — Authoring-API compatibility audit

Purpose: the rebuild is intended to ship as a **new version of Think**. The
port work has been protecting the *wire* protocol (client-side — the
`agents/react` frontend keeps working). This doc audits the OTHER axis: the
**authoring API** — the surface a developer writing `class MyAgent extends
Think {…}` and wiring it into a Worker actually touches — so we know exactly
how big a migration a new major imposes on existing agent authors.

Method: extracted the original `Think` authoring surface from
`packages/think/src/think.ts` (+ its `Agent` base and `agents/chat` types)
and the rebuild's from `src/app/{think,agent}.ts` and the exported factories,
then diffed member-by-member. This reads the original — permissible for an
audit (the clean-room rule binds *implementer* subagents, not analysis).

## Verdict vocabulary

Per member: **SAME** (name + shape compatible) · **RENAME** (same concept,
different name — cheap alias) · **SIGNATURE** (same name, changed
params/return) · **MOVED** (same concept, relocated — e.g. method→property,
or agent→adapter) · **UNBUILT→ISSUE-NNN** (absent because the feature isn't
ported yet; will arrive API-matching per audit 28) · **REMOVED** (a
deliberate design deletion) · **NEW** (rebuild-only, additive).

Recommendation per member: **keep** (already compatible) · **alias**
(add a thin compat shim now) · **match-on-build** (the feature is unbuilt;
build it to the original's signature) · **accept-break** (document in the
migration guide; don't paper over).

---

## 0. Headline: the hosting model — the one unavoidable break

| | Original | Rebuild |
|---|---|---|
| The class | `class MyAgent extends Think` **IS** the Durable Object (Think→Agent→partyserver `Server`, which is the DO) | `class MyAgent extends Think` is **transport-free**; a wrapper makes the DO |
| Wiring | export the class directly as the DO binding | `export const MyAgentDO = hostAgent(MyAgent)` — export the wrapper |
| Entry | `export default { fetch: (req,env) => routeAgentRequest(req,env) ?? 404 }` | **identical** |

**Verdict: REMOVED/MOVED — accept-break (deliberate).** This is the transport
refactor the project was chartered to do ("agents must not be concerned with
transport"). The migration for an author is exactly one line: wrap the class
in `hostAgent()`. `routeAgentRequest` + the default-fetch entrypoint are
unchanged, so the *frontend* and the *worker shell* don't move. This is the
headline of the new major and should stay.

Consequence that ripples through §2–§3: the partyserver connection hooks
(`onConnect` / `onMessage` / `onClose` / `onRequest`) and `broadcast()` are
**no longer on the agent** — they live in the WS adapter. An author who
overrode `onConnect` to gate connections now configures that on the adapter
(`hostAgent(MyAgent, { transport: {...} })`) instead. Accept-break, documented.

---

## 1. Configuration fields

| Original field | Rebuild | Verdict | Rec |
|---|---|---|---|
| `sendReasoning` | `sendReasoning` | SAME | keep |
| `chatRecovery` | `chatRecovery` | SIGNATURE (rebuild `boolean\|RecoveryPolicy`; original `ChatRecoveryConfig` is richer: `terminalMessage`, `noProgressTimeoutMs`, `maxRecoveryWork`, …) | alias-shape: widen `RecoveryPolicy` to accept the original keys |
| `chatStreamStallTimeoutMs` | `chatStreamStallTimeoutMs` | SAME | keep |
| `contextOverflow` | `contextOverflow` | SIGNATURE (close; original `proactive` adds `headroom?`) | alias-shape |
| `actionLedgerPendingRetryLeaseMs` | same | SAME | keep |
| `fetchTools` | `fetchTools` | SIGNATURE (shape differs) | alias-shape |
| `classifyChatError` (a **hook method**) | `classifyChatError` (a **field**) | MOVED (method→field) | keep — a subclass `classifyChatError(e){}` method still satisfies `this.classifyChatError?.(e)`; compatible in practice |
| `maxConcurrentAgentTools` (from Agent) | — | UNBUILT-ish (delegation cap exists; not surfaced as this field) | alias/expose |
| `waitForMcpConnections` | — | UNBUILT→ISSUE-003 | match-on-build |
| `messageConcurrency` | (`chatToolResultDebounceMs` only) | REMOVED/partial — rebuild admission is `queue`-only; original had `latest\|merge\|drop\|debounce` | match-on-build (add the strategy enum to TurnQueue) |
| `hydrationByteBudget` | — | UNBUILT (session hydrates; no byte knob) | match-on-build |
| `mediaEviction` | — | UNBUILT→ISSUE-014 | match-on-build |
| `session` (field) | (built via `configureSession`) | MOVED | accept-break — the rebuild composes the session; document `configureSession` as the seam |
| `workspace` / `workspaceBash` / `codemode` | `workspaceTools: boolean` | RENAME+UNBUILT→ISSUE-004/005 | match-on-build (shell/codemode adapters restore the rich shape) |
| `extensionLoader` / `extensionManager` | — | UNBUILT→ISSUE-006 | match-on-build |
| `actionLedgerRetention` / `actionPendingApprovalTtlMs` | (only the lease field) | REMOVED-ish | alias/expose the retention knobs |
| — | `maxSteps` (NEW field) | NEW | keep (additive; original set it per-turn via `TurnConfig` — still works) |
| — | `workspaceTools`, `chatToolResultDebounceMs` | NEW | keep |

Net: the *shared* config fields match by name; the divergence is (a) shape
drift on a few (`chatRecovery`/`contextOverflow`/`fetchTools` — alias-widen
the types), and (b) a batch of fields that are simply **unbuilt features**
(MCP, media eviction, extensions, shell/codemode), which land API-matching
when their issues are done.

## 2. Overridable hooks

**Provider hooks** (author returns config):

| Original | Rebuild | Verdict | Rec |
|---|---|---|---|
| `getModel(): ThinkModel` | `getModel(): ModelClient` | SIGNATURE (original returns a Workers-AI id string OR LanguageModel; rebuild returns the `ModelClient` port) | alias: accept `string \| ModelClient` and resolve strings (the demo already resolves ids) |
| `getSystemPrompt(): string` | same | SAME | keep |
| `getTools(): ToolSet` | same | SAME | keep |
| `getActions(): Record<string,Action>` | same | SAME | keep |
| `configureChannels()` | `configureChannels()` | SAME (shape ok) | keep |
| `getScheduledTasks()` | same | SAME | keep |
| `getDefaultTimezone()` | same | SAME | keep |
| `getSkills()` | same | SAME | keep |
| `configureSession(session: Session): Session` | `configureSession(builder: SessionBuilder): SessionBuilder` | **SIGNATURE (param type differs)** | accept-break OR provide a builder that structurally satisfies the original `Session` mutators — flag for a design decision |
| `getAIBinding()` / `resolveModel()` | — | REMOVED (Workers-AI resolution isn't baked into the agent) | accept-break — resolution moves to the model adapter |
| `getMessengers()` / `getMessengerContext()` | — | UNBUILT→ISSUE-011 | match-on-build |
| `getSkillScriptRunner()` | — | UNBUILT→ISSUE-004 | match-on-build |
| `getExtensions()` | — | UNBUILT→ISSUE-006 | match-on-build |
| — | `getFetchClient()` | NEW | keep |

**Turn / step / tool lifecycle hooks:**

| Original | Rebuild | Verdict | Rec |
|---|---|---|---|
| `beforeTurn`/`beforeStep`/`beforeToolCall`/`afterToolCall`/`onStepFinish`/`onChunk` | all present | SAME concept, MOVED (method→assignable property) | keep — method-style override still resolves through `this.hook?.()`; but the ctx TYPES differ (see below) |
| `beforeStep` ctx | `PrepareStepContext` (AI-SDK) vs `{stepNumber, messages}` | SIGNATURE | alias-shape or accept-break |
| `onChatResponse` | same | SAME | keep |
| `onChatError(error, ctx): unknown` | `onChatError(error, ctx): void` | SIGNATURE (original's return value can substitute the error) | alias: honor a returned value |
| `onChatRecovery(ctx): ChatRecoveryOptions` | `onChatRecovery(ctx): ChatRecoveryDecision` | SIGNATURE (concepts align: `{persist?, continue?}`; ctx field names differ slightly) | alias: reconcile the ctx + return field names (we already ship `recoveryRootRequestId`) |
| `authorizeTurn` / `authorizeAction` | (wired internally via ActionService) | MOVED/UNBUILT as public hooks | expose as Think hooks (cheap — the service already takes them) |
| `describePausedExecution` / `renderAttachment` | — | UNBUILT | match-on-build |
| `onAgentToolStart/Finish` / `onProgress` | — | UNBUILT (delegation runs exist; hooks not surfaced) | expose |

**State / lifecycle hooks (from Agent):**

| Original | Rebuild | Verdict | Rec |
|---|---|---|---|
| `onStart()` | `onStart()` | SAME | keep |
| `onStateChanged(state, source)` | `onStateChanged(state, source: StateSource)` | SIGNATURE (source is `Connection\|"server"` originally; `StateSource` now — per ADR-0001) | accept-break (documented in the ADR) |
| `onStateUpdate` (deprecated) | — | REMOVED (was already deprecated) | keep (accept-break, it was deprecated) |
| `onEmail(email)` | `onEmail(message)` | SAME concept; inbound routing UNBUILT→ISSUE-023 | match-on-build |
| `onError(connection, error)` | — | MOVED to adapter (transport-free) | accept-break |
| `onConnect/onMessage/onClose/onRequest` | — | MOVED to adapter (§0) | accept-break |
| `onFiberRecovered`, `onWorkflowProgress/Complete` | present | SAME | keep |

## 3. Public instance methods

| Original | Rebuild | Verdict | Rec |
|---|---|---|---|
| `chat(msg, cb, opts): Promise<void>` | `chat(input, cb?, opts?): Promise<TurnResult>` | SIGNATURE (cb optional; returns a result) | alias-compatible (superset) — keep, document the added return |
| `saveMessages(...): SaveMessagesResult` | `saveMessages(...): TurnResult` | SIGNATURE (return type) | alias: make `TurnResult` structurally include `SaveMessagesResult`'s fields |
| `submitMessages` | `submitMessages` | SAME | keep |
| `continueLastTurn` | `continueLastTurn` | SAME (both protected) | keep |
| `cancelChat` / `cancelAllChats` | present | SAME (cancelChat returns `boolean` vs `void` — additive) | keep |
| `getMessages` / `clearMessages` | present | SAME | keep |
| `get messages` (getter) | `history()` / `getMessages()` | RENAME (no sync getter) | alias: add a `messages` getter |
| `waitUntilStable` | `waitUntilStable` | SAME | keep |
| `deliverNotice` | `deliverNotice` (channels) | SAME | keep |
| `pendingExecutions`/`pendingApprovals`/`approveExecution`/`rejectExecution` | all present | SAME | keep |
| `inspectSubmission`/`listSubmissions`/`deleteSubmissions` | present | SAME | keep |
| `deleteSubmission` (singular) / `cancelSubmission` | — | RENAME/MISSING | alias |
| `runTurn` (overloaded unified entry) | (split into chat/save/submit) | REMOVED | accept-break OR add a thin `runTurn` dispatcher |
| `addMessages` | — | UNBUILT (persist-without-turn) | match-on-build (small) |
| `startAgentToolRun`/`cancelAgentToolRun`/`inspectAgentToolRun`/`getAgentToolChunks`/`tailAgentToolRun` | (delegation service exists; named differently / not all public) | RENAME/UNBUILT | expose under the original names |
| **`this.sql\`…\`` (tagged template)** | — | **REMOVED** | **decision needed** — see below |
| `schedule`/`scheduleEvery` | present | SAME (callback = method-name string) | keep |
| `getSchedule` / `getSchedules` | `getScheduleById` / `listSchedules` | RENAME | alias |
| `cancelSchedule(id): Promise<boolean>` | `cancelSchedule(id): boolean` | SIGNATURE (sync) | alias (wrap in Promise) |
| `queue` / `dequeue` / `getQueue` | `queue` (+ internal) | RENAME/partial | alias `dequeue`/`getQueue` |
| `subAgent` / `runAgentTool` | (delegation; `agentTool()` factory) | RENAME/UNBUILT-as-methods | expose `subAgent`/`runAgentTool` |
| `setState(state)` | `setState(next, origin?)` | SAME (extra optional arg) | keep |
| `broadcast` | — | MOVED to adapter | accept-break |
| `readonly mcp` (MCPClientManager) | — | UNBUILT→ISSUE-003 | match-on-build |
| `destroy` / `get name` / `keepAlive` / `startFiber` / `stash` / `runFiber` | present | SAME | keep |

**The `this.sql` decision — RESOLVED (2026-07-15).** The original gives authors
a raw tagged-template SQL accessor over DO storage. The rebuild hides storage
behind the `KeyValueStore` port so the *domain modules* never see SQL. The key
reframing: **raw SQL is a Durable-Object concern, not an agent concern.** In
the transport-free split the author's `Think` subclass is pure conversation
logic (it holds only `host`, a port bundle — deliberately no `ctx`), while the
platform surface — raw SQL, extra bindings, custom fetch routes — lives on the
**DO shell** that `hostAgent` produces. That shell is a real, subclassable
`DurableObject` with `this.ctx` (verified: `HostedAgentDO extends
HostedAgentDurableObject`, `this.ctx.storage` in scope). So an author who wants
their own tables writes:

```ts
class MyAgent extends Think<Env> { /* conversation logic; no SQL here */ }
export class MyAgentDO extends hostAgent(MyAgent) {
  myOwnQuery(id: string) { return this.ctx.storage.sql.exec("SELECT …", id); }
}
```

This is **not** a compat compromise — it's a *cleaner* placement than the
original's everything-on-one-class: SQL for the agent's own machinery is gone
(correctly, behind the port), and SQL for the author's *other* needs is fully
available, just at the layer it belongs to (the DO). No `this.sql` on the
agent; the DO shell is the seam. Cheap ergonomic follow-up: give `hostAgent`'s
returned base a documented `protected ctx`/`storage` accessor and a one-liner
in the migration guide. **Decision: accept-break on `this.sql`-on-the-agent;
SQL stays available at the DO-shell layer.**

## 4. Package-level exports

| Original | Rebuild | Verdict | Rec |
|---|---|---|---|
| `action()` / `isAction()` | `action()` | SAME (+add `isAction` re-export) | alias |
| `Think` | `Think` | SAME | keep |
| `callable` | `callable` (from domain) | SAME (different import path) | keep |
| `agentTool()` | `agentTool()` | SAME | keep |
| `tool` | `tool()` (rebuild re-exports; original made you import from `ai`) | NEW convenience | keep |
| `routeAgentRequest` / `getAgentByName` | present (adapter) | SAME | keep |
| `routeAgentEmail` | — | UNBUILT→ISSUE-023 | match-on-build |
| `Workspace` (re-export) | — | UNBUILT→ISSUE-005 | match-on-build |
| `Session` (re-export) | `createSession` | RENAME | alias |
| `ThinkWorkflow` + prompt errors | — | UNBUILT→ISSUE-016 | match-on-build |
| `createWorkspaceTools`/`createFetchTools`/`createExecuteTool`/… (`/tools/*` subpaths) | internal equivalents exist; not on `/tools/*` subpaths | RENAME/partial | expose the subpath factories |
| `createThinkWorkerEntry`/`createThinkRouter` (`/server-entry`) | — | UNBUILT→ISSUE-013 | match-on-build |
| `think()` Vite plugin (`/vite`) | — | UNBUILT→ISSUE-013 | match-on-build |

## 5. Public types

Largely **SAME by name**: `Action`, `ActionConfig`, `ActionContext`,
`ActionKind`, `StreamCallback`, `ChatStartEvent`, `ChatOptions`, `TurnContext`,
`TurnConfig`, `ContextOverflowConfig`, `ChatErrorClassification`,
`ChatErrorContext`, `ChatResponseResult`, `SaveMessagesResult`,
`ChatRecoveryContext`, `ChatRecoveryOptions`/`Decision`, `ReplyAttachment`,
`PendingApproval`, `SubmitMessagesResult`. Shape drift is minor and tracks the
method/field diffs above (e.g. `TurnContext.tools`/`model` are richer in the
original; `ChatResponseResult` carries a `status` the rebuild omits). Types
follow their members — fix on the same passes.

---

## The composition-tier story (why "authors compose their own" is the thesis)

The original Think was a ~15k-line god class: an author could only *subclass
it and configure via hooks* — never "I want the turn loop + session but not
submissions/actions/delegation/skills/channels/workflows." The rebuild
dissolved that into ~40 factory-composed domain modules over ports, so a
simpler agent is just a different composition root. Three tiers are available
to authors today, each a real (verified) base — this is a *product* strength,
not just an internal refactor:

1. **`extends Think`** — batteries-included conversational agent; configure via
   the §2 hooks. The common path.
2. **`extends Agent`** — the lighter base (`Agent` is a standalone `export
   class`, not an internal): you get scheduling, fibers, durable queue,
   observable state, RPC, and the event log over `AgentHost`, and you compose
   *only* the domain modules you actually want in your constructor. This is the
   "simpler needs" tier — impossible against the original god class.
3. **compose modules from scratch** — every domain service is an exported
   `create*(deps)` factory over ports; the in-memory adapters + the entire
   domain test suite are existence proofs that they run standalone. Best
   expressed as tier 2 (extend `Agent` for the platform lifecycle, add
   modules) rather than rebuilding the DO shell by hand.

Hosting is uniform across all three: `hostAgent(YourClass)` works for any
`Agent` subclass, so a custom composition gets the DO lifecycle (start-once,
alarms, WS, facets) for free. **Honest gap:** the module factories are
structurally public and test-proven, but their `{store, clock, ids, bus, …}`
dep signatures are internal-facing — there's no "build-a-lite-agent" cookbook
or ergonomic surface yet. That's a docs/DX gap, not an architectural one, and
it's the natural companion to the compat-alias wave. The publish framing this
unlocks is stronger than "a compatible Think": **Think is the default
composition; `Agent` is the base you compose your own on.**

## Bottom line for the publish decision

**The authoring API is far closer to compatible than "fixtures got rewritten"
suggested** (recall the fixture rewrites were 133:7 test-scaffolding to
real-API overrides). The compatibility picture sorts into four piles:

1. **Already compatible (~half the surface):** the core authoring hooks
   (`getModel`/`getSystemPrompt`/`getTools`/`getActions`/`configureChannels`/
   `getScheduledTasks`/`getSkills`), the turn lifecycle callbacks, chat/
   submission/HITL/schedule methods, `action()`/`agentTool()`/`callable`,
   and most public types. Keep as-is.

2. **Cheap aliases — a half-day of thin shims** that erase most of the visible
   diff: `getSchedule`→`getScheduleById`, `getSchedules`→`listSchedules`,
   `Session`→`createSession`, add a `messages` getter, `isAction`,
   `deleteSubmission`/`cancelSubmission`, `dequeue`/`getQueue`,
   `subAgent`/`runAgentTool` method names, a `runTurn` dispatcher, and
   type-widening on `chatRecovery`/`contextOverflow`/`fetchTools`/`getModel`
   (accept `string` ids). None touch the domain.

3. **Deliberate breaks (the migration story — small):** the `hostAgent()`
   wrapper (§0, one line), transport hooks/`broadcast` moving to the adapter,
   `onStateChanged`'s coarse source (ADR-0001), `configureSession`'s builder
   param, and the `this.sql` decision. These are the new major's actual
   breaking changes — collectively a short migration note, not a rewrite.

4. **Unbuilt features (NOT breaks):** MCP (003), messengers (011), extensions
   (006), shell/codemode (004/005), workflow base (016), inbound email (023),
   media eviction (014), framework/vite (013). These are absent because
   unported; per audit 28 they arrive carrying their own tests, so they land
   **API-matching by construction** — this audit is the checklist to hold them
   to when they do.

**Recommendation.** Publishing as a new major is viable and the migration it
imposes on existing authors is modest: *wrap your class in `hostAgent()`,
move any connection hooks to the adapter, and (if used) replace `this.sql`*.
Two concrete follow-ups: (a) a small "compat-alias" wave implementing pile 2
(cheap, high-signal — shrinks the perceived break); (b) a decision on
`this.sql` (accept-break vs adapter escape hatch). I'd sequence the alias wave
before any publish, and fold "match the original signature" into the
acceptance criteria of every unbuilt-feature issue so pile 4 never drifts.
