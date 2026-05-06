import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat, type AITool } from "@cloudflare/ai-chat/react";
import {
  IframeSandboxExecutor,
  createBrowserCodeTool,
  type JsonSchemaExecutableToolDescriptors
} from "@cloudflare/codemode/browser";
import { isToolUIPart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  CodeIcon,
  LightningIcon,
  PaperPlaneRightIcon,
  TerminalIcon,
  TrashIcon,
  WarningCircleIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";
import "./styles.css";

type Project = { id: number; name: string };
type Task = { id: number; projectId: number; title: string; done: boolean };

type ToolPart = {
  type: string;
  state?: string;
  errorText?: string;
  input?: { code?: string; [key: string]: unknown };
  output?: { code?: string; result?: unknown; logs?: string[] };
};

const store = {
  projects: [] as Project[],
  tasks: [] as Task[]
};

const browserTools: JsonSchemaExecutableToolDescriptors = {
  getPageInfo: {
    description: "Get information about the current browser page",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => ({ title: document.title, url: location.href })
  },
  createProject: {
    description: "Create a project in browser memory",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Project name" } },
      required: ["name"]
    },
    execute: async (args) => {
      const project = {
        id: store.projects.length + 1,
        name: String(args.name)
      };
      store.projects.push(project);
      return project;
    }
  },
  listProjects: {
    description: "List browser-memory projects",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => store.projects
  },
  createTask: {
    description: "Create a task in browser memory",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "number", description: "Project ID" },
        title: { type: "string", description: "Task title" }
      },
      required: ["projectId", "title"]
    },
    execute: async (args) => {
      const task = {
        id: store.tasks.length + 1,
        projectId: Number(args.projectId),
        title: String(args.title),
        done: false
      };
      store.tasks.push(task);
      return task;
    }
  },
  listTasks: {
    description: "List browser-memory tasks, optionally by project",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "number", description: "Project ID" } },
      required: []
    },
    execute: async (args) => {
      const projectId =
        args.projectId == null ? undefined : Number(args.projectId);
      return projectId == null
        ? store.tasks
        : store.tasks.filter((task) => task.projectId === projectId);
    }
  },
  updateTask: {
    description: "Update a browser-memory task",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Task ID" },
        title: { type: "string", description: "New title" },
        done: { type: "boolean", description: "Whether the task is done" }
      },
      required: ["id"]
    },
    execute: async (args) => {
      const task = store.tasks.find((item) => item.id === Number(args.id));
      if (!task) return { error: "Task not found" };
      if (args.title != null) task.title = String(args.title);
      if (args.done != null) task.done = Boolean(args.done);
      return task;
    }
  }
};

function extractFunctionCalls(code?: string): string[] {
  if (!code) return [];
  return [
    ...new Set(
      code.match(/codemode\.(\w+)/g)?.map((m) => m.replace("codemode.", "")) ??
        []
    )
  ];
}

function ToolCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(true);
  const calls = extractFunctionCalls(part.output?.code ?? part.input?.code);
  const hasError = part.state === "output-error" || !!part.errorText;
  const isDone = part.state === "output-available";
  const isRunning = !isDone && !hasError;

  return (
    <Surface
      className={`rounded-xl ring ${hasError ? "ring-2 ring-red-500/30" : "ring-kumo-line"} overflow-hidden`}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <LightningIcon size={14} className="text-orange-500" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Text size="xs" bold>
            Browser iframe codemode
          </Text>
          {calls.length > 0 && (
            <>
              <span className="text-kumo-inactive">&middot;</span>
              <span className="font-mono text-xs text-kumo-secondary truncate">
                {calls.join(", ")}
              </span>
            </>
          )}
        </div>
        {isDone && <CheckCircleIcon size={14} className="text-green-500" />}
        {hasError && <WarningCircleIcon size={14} className="text-red-500" />}
        {isRunning && (
          <CircleNotchIcon
            size={14}
            className="text-kumo-inactive animate-spin"
          />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-2 pt-2">
          {part.output?.code && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <CodeIcon size={10} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Code
                </Text>
              </div>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap wrap-break-word">
                {part.output.code}
              </pre>
            </div>
          )}
          {part.output?.result !== undefined && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Result
              </Text>
              <pre className="font-mono text-xs text-kumo-subtle bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {JSON.stringify(part.output.result, null, 2)}
              </pre>
            </div>
          )}
          {part.output?.logs?.length ? (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <TerminalIcon size={10} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Console
                </Text>
              </div>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {part.output.logs.join("\n")}
              </pre>
            </div>
          ) : null}
          {part.errorText && (
            <div className="text-red-500 text-xs">{part.errorText}</div>
          )}
        </div>
      )}
    </Surface>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function App() {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({ agent: "browser-codemode" });

  const codemodeTool = useMemo(
    () =>
      createBrowserCodeTool({
        tools: browserTools,
        executor: new IframeSandboxExecutor()
      }),
    []
  );

  const tools = useMemo<Record<string, AITool>>(
    () => ({
      codemode: {
        description: codemodeTool.description,
        parameters: codemodeTool.inputSchema,
        execute: (input) => codemodeTool.execute(input as { code: string })
      }
    }),
    [codemodeTool]
  );

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
    tools,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      const tool = tools[toolCall.toolName];
      if (!tool?.execute) return;
      const output = await tool.execute(toolCall.input);
      addToolOutput({ toolCallId: toolCall.toolCallId, output });
    }
  });

  const isStreaming = status === "streaming";

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-kumo-default">
                Browser Codemode
              </h1>
              <Badge variant="secondary" className="text-[10px]">
                iframe executor
              </Badge>
            </div>
            <Text size="xs" variant="secondary">
              Generated code runs client-side in a sandboxed iframe.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
              disabled={messages.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<LightningIcon size={32} />}
              title="Try browser codemode"
              description="Ask: Create a project named Alpha, add two tasks, then list everything."
            />
          )}

          {messages.map((message) => {
            const isUser = message.role === "user";
            return (
              <div
                key={message.id}
                className={isUser ? "flex justify-end" : "space-y-2"}
              >
                {message.parts.map((part, idx) => {
                  if (part.type === "text") {
                    return (
                      <Surface
                        key={idx}
                        className={`max-w-[80%] rounded-2xl ${isUser ? "rounded-br-md bg-kumo-contrast text-kumo-inverse" : "rounded-bl-md ring ring-kumo-line"}`}
                      >
                        <Streamdown
                          className={`sd-theme px-4 py-2.5 text-sm leading-relaxed ${isUser ? "**:text-kumo-inverse" : ""}`}
                          plugins={{ code }}
                          controls={false}
                          isAnimating={isStreaming && !isUser}
                        >
                          {part.text}
                        </Streamdown>
                      </Surface>
                    );
                  }
                  if (isToolUIPart(part)) {
                    return (
                      <ToolCard key={idx} part={part as unknown as ToolPart} />
                    );
                  }
                  return null;
                })}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <footer className="px-5 py-4 bg-kumo-base border-t border-kumo-line">
        <div className="max-w-3xl mx-auto flex gap-2">
          <InputArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask codemode to use browser tools..."
            disabled={isStreaming}
          />
          <Button
            variant="primary"
            shape="square"
            icon={<PaperPlaneRightIcon size={18} />}
            onClick={send}
            disabled={!input.trim() || isStreaming}
            loading={isStreaming}
            aria-label="Send"
          />
        </div>
        <div className="max-w-3xl mx-auto mt-2 flex justify-end">
          <PoweredByCloudflare />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
