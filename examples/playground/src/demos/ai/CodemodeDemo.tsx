import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import {
  Button,
  Surface,
  Text,
  InputArea,
  Empty,
  Badge
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  LightningIcon,
  CaretRightIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  CircleNotchIcon,
  CodeIcon,
  TerminalIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { DemoWrapper } from "../../layout";
import {
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useUserId } from "../../hooks";

const codeSections: CodeSection[] = [
  {
    title: "AI-powered code generation",
    description:
      "Codemode uses an AI model to generate and edit code based on natural language prompts. The generated code runs in a sandboxed environment.",
    code: `import { AIChatAgent } from "@cloudflare/ai-chat";
import { createCodeTool } from "@cloudflare/codemode/ai";

class CodemodeAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: this.messages,
      tools: {
        code: createCodeTool(this.env),
      },
      onFinish,
    });
    return result.toDataStreamResponse();
  }
}`
  }
];

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  errorText?: string;
  input?: Record<string, unknown>;
  output?: {
    code?: string;
    result?: unknown;
    logs?: string[];
    [key: string]: unknown;
  };
}

function extractFunctionCalls(code?: string): string[] {
  if (!code) return [];
  const matches = code.match(/codemode\.(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace("codemode.", "")))];
}

function ToolCard({ toolPart }: { toolPart: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = toolPart.state === "output-error" || !!toolPart.errorText;
  const isComplete = toolPart.state === "output-available";
  const isRunning = !isComplete && !hasError;

  const functionCalls = extractFunctionCalls(
    toolPart.output?.code || (toolPart.input?.code as string)
  );
  const summary =
    functionCalls.length > 0 ? functionCalls.join(", ") : "code execution";

  return (
    <Surface
      className={`rounded-xl ring ${hasError ? "ring-2 ring-red-500/30" : "ring-kumo-line"} overflow-hidden`}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <CaretRightIcon
          size={12}
          className={`text-kumo-secondary transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <LightningIcon size={14} className="text-kumo-inactive" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Text size="xs" bold>
            Ran code
          </Text>
          {functionCalls.length > 0 && (
            <>
              <span className="text-kumo-inactive">&middot;</span>
              <span className="font-mono text-xs text-kumo-secondary truncate">
                {summary}
              </span>
            </>
          )}
        </div>
        {isComplete && (
          <CheckCircleIcon size={14} className="text-green-500 shrink-0" />
        )}
        {hasError && (
          <WarningCircleIcon size={14} className="text-red-500 shrink-0" />
        )}
        {isRunning && (
          <CircleNotchIcon
            size={14}
            className="text-kumo-inactive animate-spin shrink-0"
          />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-2 pt-2">
          {toolPart.output?.code && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <CodeIcon size={10} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Code
                </Text>
              </div>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap wrap-break-word">
                {toolPart.output.code}
              </pre>
            </div>
          )}
          {toolPart.output?.result !== undefined && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Result
              </Text>
              <pre className="font-mono text-xs text-kumo-subtle bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {JSON.stringify(toolPart.output.result, null, 2)}
              </pre>
            </div>
          )}
          {toolPart.output?.logs && toolPart.output.logs.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <TerminalIcon size={10} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Console
                </Text>
              </div>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {toolPart.output.logs.join("\n")}
              </pre>
            </div>
          )}
          {toolPart.errorText && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Error
              </Text>
              <pre className="font-mono text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {toolPart.errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

function CodemodeUI() {
  const userId = useUserId();
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");
  const [input, setInput] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "CodemodeAgent",
    name: `codemode-demo-${userId}`,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <DemoWrapper
      title="Codemode"
      description={
        <>
          Instead of calling tools one at a time, the LLM writes and executes
          code that orchestrates multiple tools together. This lets the model
          compose complex operations — loops, conditionals, data transformations
          — that would be impossible with single tool calls. The generated code
          runs in a sandboxed environment.
        </>
      }
      statusIndicator={<ConnectionStatus status={connectionStatus} />}
    >
      <div className="flex flex-col h-[calc(100vh-16rem)] max-w-3xl">
        <div className="flex items-center gap-2 mb-4 px-1">
          <Badge variant="secondary">
            <LightningIcon size={10} className="mr-1" />
            CodeAct pattern
          </Badge>
          <Badge variant="secondary">Dynamic Worker sandbox</Badge>
        </div>

        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto mb-4 space-y-4"
        >
          {messages.length === 0 && (
            <Empty
              icon={<LightningIcon size={32} />}
              title="Try Codemode"
              description={
                'Try "What is 17 + 25?", "Get weather in London and Paris", ' +
                'or "Create a project called Alpha and list all projects"'
              }
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            const isAnimating = isStreaming && isLastAssistant;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse">
                    <Streamdown
                      className="sd-theme px-4 py-2.5 text-sm leading-relaxed **:text-kumo-inverse"
                      controls={false}
                    >
                      {message.parts
                        .filter((p) => p.type === "text")
                        .map((p) => (p.type === "text" ? p.text : ""))
                        .join("")}
                    </Streamdown>
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIdx) => {
                  if (part.type === "text") {
                    if (!part.text || part.text.trim() === "") return null;
                    return (
                      <div key={partIdx} className="flex justify-start">
                        <Surface className="max-w-[80%] rounded-2xl rounded-bl-md ring ring-kumo-line">
                          <Streamdown
                            className="sd-theme px-4 py-2.5 text-sm leading-relaxed"
                            controls={false}
                            isAnimating={isAnimating}
                          >
                            {part.text}
                          </Streamdown>
                        </Surface>
                      </div>
                    );
                  }

                  if (part.type === "step-start") return null;

                  if (isToolUIPart(part)) {
                    const toolPart = part as unknown as ToolPart;
                    return (
                      <div
                        key={toolPart.toolCallId ?? partIdx}
                        className="max-w-[80%]"
                      >
                        <ToolCard toolPart={toolPart} />
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            );
          })}

          <div />
        </div>

        <div className="border-t border-kumo-line pt-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
              <InputArea
                value={input}
                onValueChange={setInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  isConnected
                    ? "Ask me to calculate, check weather, manage projects..."
                    : "Connecting to agent..."
                }
                disabled={!isConnected || isStreaming}
                rows={2}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
              />
              <div className="flex items-center gap-2 mb-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Clear history"
                  onClick={clearHistory}
                  disabled={messages.length === 0}
                  icon={<TrashIcon size={16} />}
                />
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  size="sm"
                  aria-label="Send message"
                  disabled={!input.trim() || !isConnected || isStreaming}
                  icon={<PaperPlaneRightIcon size={18} />}
                  loading={isStreaming}
                />
              </div>
            </div>
          </form>
        </div>
      </div>
      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}

export function CodemodeDemo() {
  return (
    <Suspense
      fallback={
        <DemoWrapper
          title="Codemode"
          description="LLMs write and execute code to orchestrate tools, instead of calling them one at a time."
        >
          <div className="flex items-center justify-center h-64 text-kumo-inactive">
            Loading codemode demo...
          </div>
        </DemoWrapper>
      }
    >
      <CodemodeUI />
    </Suspense>
  );
}
