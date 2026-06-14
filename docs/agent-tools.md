# Agent Tools

Agent tools let one chat agent dispatch another chat-capable sub-agent as part
of its work. The child is a real sub-agent with its own Durable Object storage,
messages, tools, resumable stream, and drill-in URL. The parent keeps a small
run registry so clients can render the child timeline, replay it after refresh,
and clean it up later.

Agent tools support `@cloudflare/think` agents and `AIChatAgent` subclasses.
`AIChatAgent` children run headlessly through `saveMessages()`, so they should
use server-side tools. Browser-provided client tools are not available during an
agent-tool turn unless you model that interaction as server-side state or a
separate parent-mediated workflow.

For Think children, prefer agent tools when the parent model or workflow
delegates work and you want retained child runs, event replay, abort bridging,
and UI drill-in. Use raw `subAgent(...).chat()` only for lower-level streaming
RPC where your code owns forwarding, cancellation, and replay policy. For the
full comparison, see [Choosing a turn API](./think/index.md#choosing-a-turn-api).

## Use an Agent as an AI SDK tool

Use `agentTool()` when the parent model should decide when to call the helper.

```ts
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { z } from "zod";

export class Researcher extends Think<Env> {
  getSystemPrompt() {
    return "Research the user's topic and end with a concise summary.";
  }
}

export class Assistant extends Think<Env> {
  getTools() {
    return {
      research: agentTool(Researcher, {
        description: "Research one topic in depth.",
        displayName: "Researcher",
        inputSchema: z.object({
          query: z.string().min(3)
        })
      })
    };
  }
}
```

The child can also be an `AIChatAgent`:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { agentTool } from "agents/agent-tools";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { z } from "zod";

export class Summarizer extends AIChatAgent<Env> {
  protected override formatAgentToolInput(input: { text: string }, request) {
    return {
      id: `agent-tool-${request.runId}-input`,
      role: "user",
      parts: [{ type: "text", text: `Summarize:\n\n${input.text}` }]
    };
  }

  async onChatMessage() {
    const result = streamText({
      model: this.env.MODEL,
      messages: await convertToModelMessages(this.messages)
    });
    return result.toUIMessageStreamResponse();
  }
}

export class Assistant extends AIChatAgent<Env> {
  async onChatMessage() {
    const result = streamText({
      model: this.env.MODEL,
      messages: await convertToModelMessages(this.messages),
      tools: {
        summarize: agentTool(Summarizer, {
          description: "Summarize long text in a separate retained agent.",
          inputSchema: z.object({ text: z.string() })
        })
      },
      stopWhen: stepCountIs(5)
    });
    return result.toUIMessageStreamResponse();
  }
}
```

The generated tool calls `this.runAgentTool(ChildAgent, ...)`, streams
`agent-tool-event` frames on the parent WebSocket, and returns the child
summary to the parent model. If the run fails, aborts, or is interrupted, the
tool returns a structured `AgentToolFailure` instead of an empty success value:

```ts
type AgentToolFailure = {
  ok: false;
  status: "error" | "aborted" | "interrupted";
  error: string; // human-readable, safe to surface
  retryable: boolean;
  // Present only when `status` is "interrupted":
  reason?: AgentToolInterruptedReason;
  childStillRunning?: boolean;
};

type AgentToolInterruptedReason =
  | "no-progress"
  | "window-exceeded"
  | "not-tailable"
  | "inspect-timeout"
  | "inspect-failed"
  | "recovery-deadline"
  | "budget-exceeded";
```

`retryable` is `true` only for an `interrupted` run — the child was reset or
superseded by a deploy or parent recovery and never reached a logical outcome,
so re-dispatching the same call can succeed. A genuine `error` or an intentional
`aborted` is `retryable: false`. This lets a parent prompt convention or an
orchestration harness re-run a transient interruption rather than reporting it
to the user as a final failure. `AgentToolFailure` is exported from `agents`.

On an `interrupted` run, `reason` gives a machine-readable cause and
`childStillRunning` reports whether the child was still working when the parent
stopped waiting (`true`) or has since been torn down (`false`). Branch on these
instead of parsing the `error` prose — for example, re-dispatch a `no-progress`
interrupt (the child may still self-heal) but reconnect to or surface a
`window-exceeded` one (the child was torn down). Both `reason` and
`childStillRunning` are also mirrored onto the `agent-tool-event` wire frame and
the `useAgentToolEvents()` run state.

For `Think` children that do workflow-style work without user-facing assistant
text, override `getAgentToolOutput()` and, if needed, `getAgentToolSummary()`.
Assistant text remains the default summary when present, but a Think agent-tool
run can complete successfully without emitting text chunks.
Persist any structured output before the child turn finishes, because
`getAgentToolOutput()` is read as soon as `saveMessages()` resolves. Keep
`getAgentToolSummary()` concise for display; the full structured value is stored
separately as the tool output.

```ts
export class Extractor extends Think<Env> {
  protected override getAgentToolOutput(runId: string) {
    const rows = this.sql<{ result_json: string }>`
      SELECT result_json FROM extraction_runs WHERE id = ${runId}
    `;
    return rows[0] ? JSON.parse(rows[0].result_json) : undefined;
  }

  protected override getAgentToolSummary(_runId: string, output: unknown) {
    return output ? "Extraction complete" : "";
  }
}
```

## Run an Agent tool imperatively

Use `runAgentTool()` for deterministic workflows, scheduled work, HTTP
handlers, or fan-out code.

```ts
const [a, b] = await Promise.allSettled([
  this.runAgentTool(Researcher, {
    input: { query: "HTTP/3" },
    parentToolCallId: toolCallId,
    displayOrder: 0
  }),
  this.runAgentTool(Researcher, {
    input: { query: "gRPC" },
    parentToolCallId: toolCallId,
    displayOrder: 1
  })
]);
```

`runAgentTool()` is idempotent by `runId`. Passing the same `runId` never starts
a duplicate child turn. Completed, failed, aborted, and interrupted runs are
retained until you explicitly clear them.

## Detached (background) runs

By default `runAgentTool()` **awaits** the child to terminal before returning.
For long-running work — large imports, video renders, deep research — that you
do not want to block the dispatching turn on, pass `detached`. The run is
dispatched, the current turn continues, and `runAgentTool()` returns a handle
immediately:

```ts
type DetachedRunAgentToolResult = {
  runId: string;
  agentType: string;
  status: "running" | "error"; // "error" only if dispatch itself was rejected
};
```

`detached: true` is fire-and-forget — observe the run through `agent-tool-event`
frames (the same ones `useAgentToolEvents()` consumes) and the global
`onAgentToolFinish()` hook. Pass an object to wire a targeted, durable
completion callback:

```ts
async startImport(input: ImportInput) {
  const { runId } = await this.runAgentTool(ImportAgent, {
    input,
    detached: { onFinish: "onImportDone", maxBudgetMs: 60 * 60 * 1000 }
  });
  return runId;
}

// Fires once, even if the Durable Object was evicted and rehydrated while the
// child ran. Referenced by METHOD NAME (like schedule()) — never a closure,
// which cannot survive eviction.
async onImportDone(run: AgentToolRunInfo, result: AgentToolLifecycleResult) {
  switch (result.status) {
    case "completed":
      await this.markImportReady(run.runId, result.summary);
      break;
    case "error":
      await this.markImportFailed(run.runId, result.error);
      break;
    case "interrupted":
      // reason "budget-exceeded" ⇒ the run hit its maxBudgetMs ceiling.
      // interrupted is soft: a child that finishes anyway re-fires this hook
      // with "completed", so make the handler idempotent.
      break;
  }
}
```

Key behaviors:

- **Durable completion.** Delivery survives eviction and deploys: a warm fast
  path delivers with low latency while the isolate is alive, and a
  self-scheduling reconcile backbone finalizes anything the fast path missed.
  Delivery is exactly-once on the happy path; under a crash it is at-least-once,
  so `onFinish` handlers must be idempotent.
- **Give-up vs. finish are independent.** A budget give-up is delivered as
  `status: "interrupted"`, `reason: "budget-exceeded"`. Because `interrupted` is
  soft, a child that completes after the give-up still re-fires `onFinish` with
  the real result — a premature give-up never hides a late completion.
- **Bounded.** Every detached run has an absolute `maxBudgetMs` ceiling
  (per-run, or the `detachedMaxBudgetMs` static option; default 24h). On expiry
  the parent gives up watching and tears the child down so an abandoned run
  cannot hold a `maxConcurrentAgentTools` slot forever.
- **No inherited signal.** A detached run must outlive the spawning turn, so it
  does **not** inherit `options.signal`. Cancel it explicitly:

```ts
await this.cancelAgentTool(runId); // idempotent; delivers onFinish "aborted"
```

### The `inspectAgentToolRun` contract

A child's `inspectAgentToolRun(runId)` returns the run's current status snapshot,
or `null`. **`null` does not mean "failed"** — it means the child has no record
of that run *yet*. This is normal immediately after dispatch (the child may
still be persisting its first row) and is also what a freshly-rehydrated child
returns before it has lazily reconciled a stale `running` row. Callers — and the
framework's own reconcile backbone — treat `null` as "not terminal, keep
watching within budget", never as a terminal failure. Only a non-`null`
inspection with a terminal `status` (`completed` / `error` / `aborted`)
finalizes a run.

## Render child timelines in React

`useAgentToolEvents()` is a headless hook. It subscribes to the existing parent
connection, deduplicates replay/live races, applies child `UIMessageChunk`
bodies to message parts, and groups sibling runs by parent tool call id.

```tsx
import { useAgent, useAgentToolEvents } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

const agent = useAgent({ agent: "Assistant", name: userId });
const { messages } = useAgentChat({ agent });
const agentTools = useAgentToolEvents({ agent });

for (const message of messages) {
  for (const part of message.parts) {
    if (part.type === "tool-call") {
      const runs = agentTools.getRunsForToolCall(part.toolCallId);
      // Render the child runs beside this tool call.
    }
  }
}
```

Imperative runs without a parent tool call are available as
`agentTools.unboundRuns`.

## Drill in and gate access

Agent tools are normal sub-agents. Connect to a retained child through the
parent route:

```ts
useAgent({
  agent: "Assistant",
  name: userId,
  sub: [{ agent: "Researcher", name: runId }]
});
```

Gate external access with the parent registry so guessed run ids cannot spawn
fresh child facets:

```ts
override async onBeforeSubAgent(_request, child) {
  if (!this.hasAgentToolRun(child.className, child.name)) {
    return new Response("Not found", { status: 404 });
  }
}
```

## Clear retained runs

Runs and child facets are retained by default for refresh, drill-in, and later
inspection. Delete them explicitly when clearing chat history or applying your
own retention policy:

```ts
await this.clearAgentToolRuns();
await this.clearAgentToolRuns({
  status: ["completed", "error", "aborted", "interrupted"]
});
await this.clearAgentToolRuns({ olderThan: Date.now() - 7 * 24 * 60 * 60_000 });
```

If a retained run is still `starting` or `running`, cleanup cancels the child
before deleting its facet.

## Interrupted runs and recovery

Agent-tool runs are retained in the parent. If the parent restarts (deploy,
eviction) while a child run is still `starting` or `running`, the parent does
not immediately abandon it. Startup recovery re-attaches to the live child and
tails its stream to the child's real terminal result: the child is a sub-agent
with its own `chatRecovery`, so it self-heals its interrupted turn while the
parent forwards its output and collects the final outcome. A completed child is
finalized in the parent without re-running already-finished work.

The re-attach wait is **progress-keyed**, not a fixed wall clock. Two static
`options` tune it:

| Option                                 | Default          | Behavior                                                                                                                                                                                                        |
| -------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentToolReattachNoProgressTimeoutMs` | `120000` (2 min) | How long the parent waits with **no** forward progress before giving up. Resets on every forwarded chunk, so a streaming child is followed through to terminal.                                                 |
| `agentToolReattachMaxWindowMs`         | `Infinity`       | Optional hard wall-clock ceiling on a single re-attach. Uncapped by default (mirrors chat recovery's `maxRecoveryWork`), so a healthy, long-running child is never cut off. Set a finite value to impose a cap. |

Give-up outcomes map to the `AgentToolFailure` fields:

- A child that goes **silent** for a full no-progress window is sealed
  `reason: "no-progress"`, `childStillRunning: true`. This seal is **soft** —
  the child is left running, so re-dispatching the same `runId` can re-attach
  and collect it if it self-heals.
- If you set a finite `agentToolReattachMaxWindowMs` and it fires, the run is
  sealed `reason: "window-exceeded"`, `childStillRunning: false`, and the child
  is **torn down** (it has had its full window and is treated as exhausted).
- A child that cannot be tailed or inspected, or that exceeds the overall
  recovery deadline, is sealed with the matching `reason` so the parent tool
  call returns a structured failure instead of hanging indefinitely.

A genuinely hung child can never block recovery forever: the no-progress budget
bounds a silent child, and a content-runaway is bounded uniformly (live and
recovery) by the child's own `chatRecovery` `maxRecoveryWork` /
`shouldKeepRecovering`, not by a parent-only timer.

Monitor parent reconciliation through the `agentTool` observability channel:

```ts
import { subscribe } from "agents/observability";

const unsubscribe = subscribe("agentTool", (event) => {
  if (event.type === "agent_tool:recovery:row") {
    console.log("Recovered agent-tool row", event.payload);
  }
});
```

Raw `diagnostics_channel` subscribers should use the channel name
`agents:agent_tool`.
