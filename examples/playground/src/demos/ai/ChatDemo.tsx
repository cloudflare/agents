import { DemoWrapper } from "../../layout";

export function ChatDemo() {
  return (
    <DemoWrapper
      title="AI Chat"
      description="Build chat interfaces with message persistence, streaming, and tool support."
    >
      <div className="max-w-3xl space-y-6">
        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">AIChatAgent</h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            The{" "}
            <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
              AIChatAgent
            </code>{" "}
            extends the base Agent with chat-specific features: message
            persistence, stream resumption, and AI SDK integration.
          </p>

          <div className="grid grid-cols-2 gap-4 mt-6">
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Message Persistence</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Messages saved to SQLite automatically. Survives reconnections.
              </p>
            </div>
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Stream Resumption</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                If connection drops mid-stream, client can resume from last
                chunk.
              </p>
            </div>
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Tool Execution</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Server-side and client-side tool support with confirmation
                flows.
              </p>
            </div>
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Multi-turn Context</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Full conversation history available via{" "}
                <code>this.messages</code>.
              </p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">Setup Requirements</h3>
          <ol className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400 list-decimal list-inside">
            <li>
              Install{" "}
              <code className="bg-neutral-100 dark:bg-neutral-700 px-1">
                @cloudflare/ai-chat
              </code>{" "}
              and{" "}
              <code className="bg-neutral-100 dark:bg-neutral-700 px-1">
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
              <code className="bg-neutral-100 dark:bg-neutral-700 px-1">
                AIChatAgent
              </code>{" "}
              and implement{" "}
              <code className="bg-neutral-100 dark:bg-neutral-700 px-1">
                onChatMessage
              </code>
            </li>
          </ol>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">useAgentChat Hook</h3>
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
                className="flex gap-3 py-2 px-3 bg-neutral-50 dark:bg-neutral-800 rounded"
              >
                <code className="text-xs font-mono flex-shrink-0">{prop}</code>
                <span className="text-neutral-600 dark:text-neutral-400 text-xs">
                  {desc}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <strong>Note:</strong> This demo requires an OpenAI API key. Set
            <code className="bg-neutral-200 dark:bg-neutral-700 px-1 mx-1">
              OPENAI_API_KEY
            </code>
            in your environment to enable live chat.
          </p>
        </div>
      </div>
    </DemoWrapper>
  );
}
