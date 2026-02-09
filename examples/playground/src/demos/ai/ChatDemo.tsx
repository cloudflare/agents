import { Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";

export function ChatDemo() {
  return (
    <DemoWrapper
      title="AI Chat"
      description="Build chat interfaces with message persistence, streaming, and tool support."
    >
      <div className="max-w-3xl space-y-6">
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">AIChatAgent</Text>
          </div>
          <div className="mb-4">
            <Text variant="secondary" size="sm">
              The{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                AIChatAgent
              </code>{" "}
              extends the base Agent with chat-specific features: message
              persistence, stream resumption, and AI SDK integration.
            </Text>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-6">
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Message Persistence
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Messages saved to SQLite automatically. Survives
                  reconnections.
                </Text>
              </div>
            </div>
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Stream Resumption
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  If connection drops mid-stream, client can resume from last
                  chunk.
                </Text>
              </div>
            </div>
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Tool Execution
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Server-side and client-side tool support with confirmation
                  flows.
                </Text>
              </div>
            </div>
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Multi-turn Context
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Full conversation history available via{" "}
                  <code className="text-kumo-default">this.messages</code>.
                </Text>
              </div>
            </div>
          </div>
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Setup Requirements</Text>
          </div>
          <ol className="space-y-2 text-sm text-kumo-subtle list-decimal list-inside">
            <li>
              Install{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                @cloudflare/ai-chat
              </code>{" "}
              and{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                ai
              </code>{" "}
              packages
            </li>
            <li>
              Configure an AI provider (OpenAI, Anthropic, Workers AI, etc.)
            </li>
            <li>Set API keys in environment variables</li>
            <li>
              Extend{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                AIChatAgent
              </code>{" "}
              and implement{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                onChatMessage
              </code>
            </li>
          </ol>
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">useAgentChat Hook</Text>
          </div>
          <div className="space-y-2 text-sm">
            {[
              { prop: "messages", desc: "Array of chat messages with parts" },
              {
                prop: "input / handleInputChange",
                desc: "Controlled input state"
              },
              { prop: "handleSubmit", desc: "Submit handler for forms" },
              { prop: "isLoading / status", desc: "Loading state indicators" },
              { prop: "clearHistory()", desc: "Clear all messages" },
              {
                prop: "addToolOutput()",
                desc: "Report client-side tool results"
              }
            ].map(({ prop, desc }) => (
              <div
                key={prop}
                className="flex gap-3 py-2 px-3 bg-kumo-elevated rounded"
              >
                <code className="text-xs font-mono shrink-0 text-kumo-default">
                  {prop}
                </code>
                <span className="text-kumo-subtle text-xs">{desc}</span>
              </div>
            ))}
          </div>
        </Surface>

        <Surface className="p-4 rounded-lg bg-kumo-elevated">
          <Text variant="secondary" size="sm">
            <strong className="text-kumo-default">Note:</strong> This demo
            requires an OpenAI API key. Set
            <code className="bg-kumo-control px-1 mx-1 rounded text-kumo-default">
              OPENAI_API_KEY
            </code>
            in your environment to enable live chat.
          </Text>
        </Surface>
      </div>
    </DemoWrapper>
  );
}
