import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import "./styles.css";
import { generateId, type UIMessage } from "ai";
import { useState, useEffect, useRef, useCallback } from "react";
import { Streamdown } from "streamdown";
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
  GearIcon,
  LightningIcon,
  CaretRightIcon,
  XIcon,
  CodeIcon,
  TerminalIcon,
  WarningCircleIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  BrainIcon,
  CaretDownIcon
} from "@phosphor-icons/react";
import {
  ModeToggle,
  PoweredByAgents,
  ConnectionIndicator,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import type { Codemode, ExecutorType } from "./server";

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  errorText?: string;
  input?: { functionDescription?: string; [key: string]: unknown };
  output?: {
    code?: string;
    result?: string;
    logs?: string[];
    [key: string]: unknown;
  };
}

function asToolPart(part: UIMessage["parts"][0]): ToolPart | null {
  if (!part.type.startsWith("tool-")) return null;
  return part as unknown as ToolPart;
}

const EXECUTORS: { value: ExecutorType; label: string; description: string }[] =
  [
    {
      value: "dynamic-worker",
      label: "Dynamic Worker",
      description: "Sandboxed Cloudflare Worker via WorkerLoader"
    },
    {
      value: "node-server",
      label: "Node Server",
      description: "Node.js VM via external HTTP server"
    }
  ];

const TOOLS: { name: string; description: string }[] = [
  { name: "createProject", description: "Create a new project" },
  { name: "listProjects", description: "List all projects" },
  { name: "createTask", description: "Create a task in a project" },
  { name: "listTasks", description: "List tasks with optional filters" },
  { name: "updateTask", description: "Update a task's fields" },
  { name: "deleteTask", description: "Delete a task and its comments" },
  { name: "createSprint", description: "Create a sprint for a project" },
  { name: "listSprints", description: "List sprints, optionally by project" },
  { name: "addComment", description: "Add a comment to a task" },
  { name: "listComments", description: "List comments on a task" }
];

function extractFunctionCalls(code?: string): string[] {
  if (!code) return [];
  const matches = code.match(/codemode\.(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace("codemode.", "")))];
}

function ReasoningBlock({
  text,
  isStreaming
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text?.trim()) return null;

  return (
    <div className="flex justify-start">
      <Surface className="max-w-[80%] rounded-xl bg-purple-500/10 border border-purple-500/20 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer"
        >
          <BrainIcon size={14} className="text-purple-400" />
          <Text size="xs" bold>
            Thinking
          </Text>
          <CaretDownIcon
            size={12}
            className={`ml-auto text-kumo-secondary transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {expanded && (
          <div className="px-3 pb-3">
            <Streamdown
              className="sd-theme text-xs"
              controls={false}
              isAnimating={isStreaming}
            >
              {text}
            </Streamdown>
          </div>
        )}
      </Surface>
    </div>
  );
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
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {toolPart.output.code}
              </pre>
            </div>
          )}
          {!toolPart.output?.code && toolPart.input && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Input
              </Text>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {JSON.stringify(toolPart.input, null, 2)}
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

function MessagePart({
  part,
  isStreaming
}: {
  part: UIMessage["parts"][0];
  isStreaming: boolean;
}) {
  if (part.type === "text") {
    if (!part.text || part.text.trim() === "") return null;
    return (
      <Streamdown
        className="sd-theme text-sm leading-relaxed"
        controls={false}
        isAnimating={isStreaming}
      >
        {part.text}
      </Streamdown>
    );
  }

  if (part.type === "step-start") return null;

  if (part.type === "reasoning") {
    return <ReasoningBlock text={part.text} isStreaming={isStreaming} />;
  }

  const toolPart = asToolPart(part);
  if (toolPart) {
    return <ToolCard toolPart={toolPart} />;
  }

  return null;
}

function SettingsPanel({
  executor,
  onExecutorChange,
  toolDef,
  loading,
  onClose
}: {
  executor: ExecutorType;
  onExecutorChange: (e: ExecutorType) => void;
  toolDef: {
    name: string;
    description: string;
    inputSchema: unknown;
  } | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [showSchema, setShowSchema] = useState(false);

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-label="Close settings"
      />
      <aside className="fixed top-0 right-0 bottom-0 w-[360px] max-w-[90vw] bg-kumo-base border-l border-kumo-line z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-kumo-line">
          <Text variant="heading3">Settings</Text>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            icon={<XIcon size={16} />}
            onClick={onClose}
            aria-label="Close"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          <div>
            <span className="text-xs font-semibold text-kumo-secondary mb-2 block uppercase tracking-wider">
              Executor
            </span>
            <select
              className="w-full px-3 py-2 bg-kumo-elevated border border-kumo-line rounded-lg text-kumo-default text-sm outline-none focus:ring-2 focus:ring-kumo-ring"
              value={executor}
              onChange={(e) => onExecutorChange(e.target.value as ExecutorType)}
              disabled={loading}
            >
              {EXECUTORS.map((exec) => (
                <option key={exec.value} value={exec.value}>
                  {exec.label}
                </option>
              ))}
            </select>
            <div className="mt-1">
              <Text size="xs" variant="secondary">
                {EXECUTORS.find((e) => e.value === executor)?.description}
              </Text>
            </div>
          </div>

          <div>
            <span className="text-xs font-semibold text-kumo-secondary mb-2 block uppercase tracking-wider">
              Available Functions
            </span>
            <div className="border border-kumo-line rounded-lg overflow-hidden divide-y divide-kumo-line">
              {TOOLS.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-baseline gap-3 px-3 py-2 bg-kumo-elevated hover:bg-kumo-base transition-colors"
                >
                  <span className="text-xs font-semibold font-mono text-kumo-brand shrink-0">
                    {tool.name}
                  </span>
                  <span className="text-xs text-kumo-secondary truncate">
                    {tool.description}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {toolDef && (
            <div>
              <button
                type="button"
                className="flex items-center gap-2 w-full px-3 py-2 border border-kumo-line rounded-lg text-sm text-kumo-secondary hover:bg-kumo-elevated transition-colors cursor-pointer"
                onClick={() => setShowSchema(!showSchema)}
              >
                <CaretRightIcon
                  size={12}
                  className={`transition-transform ${showSchema ? "rotate-90" : ""}`}
                />
                <span>Tool Schema</span>
              </button>
              {showSchema && (
                <pre className="mt-2 p-3 bg-kumo-elevated border border-kumo-line rounded-lg font-mono text-xs text-kumo-subtle overflow-x-auto whitespace-pre-wrap leading-relaxed">
                  {JSON.stringify(toolDef.inputSchema, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [executor, setExecutor] = useState<ExecutorType>("dynamic-worker");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [toolDef, setToolDef] = useState<{
    name: string;
    description: string;
    inputSchema: unknown;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const toolDefFetched = useRef(false);

  const agent = useAgent<
    Codemode,
    { messages: UIMessage[]; loading: boolean; executor: ExecutorType }
  >({
    agent: "codemode",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), []),
    onStateUpdate: (state) => {
      setMessages(state.messages);
      setLoading(state.loading);
      setExecutor(state.executor);
      if (!toolDefFetched.current) {
        toolDefFetched.current = true;
        agent.call("getToolDefinition", []).then((def: unknown) => {
          setToolDef(def as typeof toolDef);
        });
      }
    }
  });

  const handleExecutorChange = useCallback(
    (newExecutor: ExecutorType) => {
      setExecutor(newExecutor);
      agent.call("setExecutor", [newExecutor]);
    },
    [agent]
  );

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    const userMessage: UIMessage = {
      id: generateId(),
      role: "user",
      parts: [{ type: "text", text }]
    };
    agent.setState({ messages: [...messages, userMessage], loading, executor });
    setInput("");
  }, [input, messages, loading, executor, agent]);

  const resetMessages = useCallback(() => {
    agent.setState({ messages: [], loading: false, executor });
  }, [agent, executor]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Codemode
            </h1>
            <Badge variant="secondary">
              <LightningIcon size={12} weight="bold" className="mr-1" />
              {EXECUTORS.find((e) => e.value === executor)?.label}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={<GearIcon size={16} />}
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-label="Settings"
            />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={resetMessages}
              disabled={messages.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && !loading && (
            <Empty
              icon={<LightningIcon size={32} />}
              title="Welcome to Codemode"
              description="AI-powered project management. Ask me to create projects, manage tasks, plan sprints, and more."
            />
          )}

          {messages.map((message, msgIndex) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && msgIndex === messages.length - 1;
            const isStreaming = loading && isLastAssistant;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed text-sm">
                    {message.parts
                      .filter((p) => p.type === "text")
                      .map((p) => (p.type === "text" ? p.text : ""))
                      .join("")}
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, index) => (
                  <div
                    key={`${message.id}-${index}`}
                    className="flex justify-start"
                  >
                    <div className="max-w-[80%]">
                      <MessagePart part={part} isStreaming={isStreaming} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {loading && messages[messages.length - 1]?.role !== "assistant" && (
            <div className="flex justify-start">
              <Surface className="px-4 py-2.5 rounded-2xl rounded-bl-md ring ring-kumo-line">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-kumo-inactive animate-bounce" />
                  <span className="w-1.5 h-1.5 rounded-full bg-kumo-inactive animate-bounce [animation-delay:0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-kumo-inactive animate-bounce [animation-delay:0.3s]" />
                </div>
              </Surface>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={
                isConnected
                  ? "Ask me to manage your projects..."
                  : "Connecting..."
              }
              disabled={!isConnected || loading}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              size="sm"
              aria-label="Send message"
              disabled={!input.trim() || !isConnected || loading}
              icon={<PaperPlaneRightIcon size={18} />}
              loading={loading}
              className="mb-0.5"
            />
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByAgents />
        </div>
      </div>

      {settingsOpen && (
        <SettingsPanel
          executor={executor}
          onExecutorChange={handleExecutorChange}
          toolDef={toolDef}
          loading={loading}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
