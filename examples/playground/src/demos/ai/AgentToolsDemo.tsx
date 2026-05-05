import { useState } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { CodeExplanation, LogPanel, type CodeSection } from "../../components";
import { useLogs } from "../../hooks";

const timeline = [
  {
    type: "parent_tool_call",
    payload: { tool: "research", topic: "Workers AI cache strategy" }
  },
  {
    type: "child_started",
    payload: { agent: "Researcher", runId: "research-01" }
  },
  {
    type: "child_chunk",
    payload: { runId: "research-01", text: "Scanning docs and examples..." }
  },
  {
    type: "child_completed",
    payload: {
      runId: "research-01",
      summary: "Use session affinity and prune context."
    }
  },
  {
    type: "drill_in_ready",
    payload: { path: "/sub/researcher/research-01" }
  }
];

const codeSections: CodeSection[] = [
  {
    title: "Expose a chat-capable agent as a tool",
    description:
      "agentTool() wraps a Think child agent as an AI SDK tool. The child owns its own messages, tools, storage, and resumable stream.",
    code: `import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { z } from "zod";

export class Researcher extends Think<Env> {
  getSystemPrompt() {
    return "Research the requested topic and return a concise brief.";
  }
}

export class Assistant extends Think<Env> {
  getTools() {
    return {
      research: agentTool(Researcher, {
        description: "Research one topic in depth.",
        inputSchema: z.object({ query: z.string().min(3) }),
        displayName: "Researcher"
      })
    };
  }
}`
  },
  {
    title: "Render child timelines inline",
    description:
      "useAgentToolEvents() listens for agent-tool-event frames from the parent and groups child runs by the parent tool call id.",
    code: `const agent = useAgent({ agent: "Assistant", name: userId });
const chat = useAgentChat({ agent });
const agentTools = useAgentToolEvents({ agent });

// For each tool part in the chat message:
const childRuns = agentTools.getRunsForToolCall(toolCallId);

return childRuns.map((run) => (
  <ChildRunPanel key={run.info.runId} run={run} />
));`
  },
  {
    title: "Drill into the real child agent",
    description:
      "The child is not just a rendered transcript. It is a retained sub-agent facet that the UI can connect to directly for replay or follow-up.",
    code: `const helper = useAgent({
  agent: "Assistant",
  name: userId,
  sub: [{ agent: "Researcher", name: run.info.runId }]
});

const helperChat = useAgentChat({ agent: helper });`
  }
];

export function AgentToolsDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [activeRun, setActiveRun] = useState(false);

  const simulate = () => {
    clearLogs();
    setActiveRun(true);
    timeline.forEach((event, index) => {
      window.setTimeout(() => {
        addLog("in", event.type, event.payload);
        if (index === timeline.length - 1) {
          setActiveRun(false);
        }
      }, index * 350);
    });
  };

  return (
    <DemoWrapper
      title="Agent Tools"
      description={
        <>
          Agent tools let one assistant delegate work to real child agents
          during a chat turn. The child can stream its own timeline inline, keep
          its own state, and remain available for direct drill-in through nested
          agent routes.
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Parent and Child Agents
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              A parent chat agent can expose specialist Think agents as tools.
              The model chooses the helper, the framework starts a child facet,
              and the UI receives live child events under the original tool
              call.
            </p>
            <Button variant="primary" onClick={simulate} disabled={activeRun}>
              {activeRun ? "Streaming child run..." : "Simulate Agent Tool Run"}
            </Button>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Why This Is Different
              </Text>
            </div>
            <div className="space-y-3">
              {[
                [
                  "Real agents",
                  "Each helper has its own prompt, tools, SQLite state, and stream durability."
                ],
                [
                  "Inline UX",
                  "The parent forwards child events so users can watch delegated work happen."
                ],
                [
                  "Drill-in",
                  "The UI can open the child through /sub/... and continue the conversation."
                ],
                [
                  "Cleanup",
                  "Retained child runs can be deleted when the parent chat is cleared."
                ]
              ].map(([title, description]) => (
                <div key={title} className="p-3 rounded bg-kumo-elevated">
                  <Text bold size="sm">
                    {title}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">{description}</p>
                </div>
              ))}
            </div>
          </Surface>
        </div>

        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="280px" />

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Full Interactive Example
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              The focused example runs real Think child agents, renders their
              tool timelines, gates arbitrary sub-agent access, and tests
              retention/cleanup.
            </p>
            <code className="text-xs text-kumo-subtle">
              examples/agents-as-tools
            </code>
          </Surface>
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
