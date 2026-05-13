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
tool returns a structured failure instead of an empty success value.

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
