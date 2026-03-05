import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  FolderIcon,
  FileIcon,
  FolderOpenIcon,
  ArrowCounterClockwiseIcon,
  InfoIcon,
  TerminalIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

type FileEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  path: string;
};

type FileBrowserHandle = { refresh: () => void };

const FileBrowser = forwardRef<
  FileBrowserHandle,
  {
    agent: { call: (method: string, args: unknown[]) => Promise<unknown> };
    isConnected: boolean;
  }
>(function FileBrowser({ agent, isConnected }, ref) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [info, setInfo] = useState<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
  } | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      if (!isConnected) return;
      setLoading(true);
      try {
        const result = (await agent.call("listFiles", [
          path
        ])) as unknown as Array<{
          name: string;
          type: "file" | "directory" | "symlink";
          size: number;
          path: string;
        }>;
        setEntries(result);
        setCurrentPath(path);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [agent, isConnected]
  );

  const loadInfo = useCallback(async () => {
    if (!isConnected) return;
    try {
      const result = (await agent.call("getWorkspaceInfo", [])) as unknown as {
        fileCount: number;
        directoryCount: number;
        totalBytes: number;
      };
      setInfo(result);
    } catch {
      // ignore
    }
  }, [agent, isConnected]);

  useEffect(() => {
    if (isConnected) {
      loadDir(currentPath);
      loadInfo();
    }
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    loadDir(currentPath);
    loadInfo();
  }, [loadDir, loadInfo, currentPath]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  const navigateTo = (path: string) => {
    setSelectedFile(null);
    loadDir(path);
    loadInfo();
  };

  const openFile = useCallback(
    async (path: string) => {
      if (!isConnected) return;
      try {
        const content = (await agent.call("readFileContent", [
          path
        ])) as unknown as string | null;
        setSelectedFile({
          path,
          content: content ?? "(empty file)"
        });
      } catch {
        setSelectedFile({ path, content: "(error reading file)" });
      }
    },
    [agent, isConnected]
  );

  const parentPath =
    currentPath === "/"
      ? null
      : currentPath.split("/").slice(0, -1).join("/") || "/";

  const dirs = entries.filter((e) => e.type === "directory");
  const files = entries.filter((e) => e.type !== "directory");

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpenIcon size={14} className="text-kumo-accent shrink-0" />
          <span className="text-xs font-mono text-kumo-default truncate">
            {currentPath}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Refresh"
          icon={<ArrowCounterClockwiseIcon size={12} />}
          onClick={refresh}
          disabled={loading}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center">
            <Text size="xs" variant="secondary">
              Loading...
            </Text>
          </div>
        ) : entries.length === 0 && currentPath === "/" ? (
          <div className="p-4 text-center">
            <Empty
              icon={<FolderIcon size={24} />}
              title="Workspace is empty"
              description="Ask the AI to create some files"
            />
          </div>
        ) : (
          <div className="py-1">
            {parentPath !== null && (
              <button
                type="button"
                onClick={() => navigateTo(parentPath)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left"
              >
                <FolderIcon size={14} className="text-kumo-accent shrink-0" />
                <span className="text-xs text-kumo-subtle">..</span>
              </button>
            )}
            {dirs.map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left"
              >
                <FolderIcon size={14} className="text-kumo-accent shrink-0" />
                <span className="text-xs text-kumo-default truncate">
                  {entry.name}
                </span>
              </button>
            ))}
            {files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => openFile(entry.path)}
                className={`w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left ${
                  selectedFile?.path === entry.path ? "bg-kumo-elevated" : ""
                }`}
              >
                <FileIcon size={14} className="text-kumo-subtle shrink-0" />
                <span className="text-xs text-kumo-default truncate flex-1">
                  {entry.name}
                </span>
                <span className="text-[10px] text-kumo-inactive shrink-0">
                  {entry.size > 1024
                    ? `${(entry.size / 1024).toFixed(1)}K`
                    : `${entry.size}B`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedFile && (
        <div className="border-t border-kumo-line flex flex-col max-h-[40%]">
          <div className="px-3 py-1.5 flex items-center justify-between border-b border-kumo-line bg-kumo-elevated">
            <span className="text-[10px] font-mono text-kumo-default truncate">
              {selectedFile.path.split("/").pop()}
            </span>
            <button
              type="button"
              onClick={() => setSelectedFile(null)}
              className="text-kumo-inactive hover:text-kumo-default text-xs"
            >
              ×
            </button>
          </div>
          <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed font-mono text-kumo-default bg-kumo-base whitespace-pre-wrap break-all">
            {selectedFile.content}
          </pre>
        </div>
      )}

      {info && (info.fileCount > 0 || info.directoryCount > 0) && (
        <div className="px-3 py-2 border-t border-kumo-line">
          <span className="text-[10px] text-kumo-inactive">
            {info.fileCount} file{info.fileCount !== 1 ? "s" : ""},{" "}
            {info.directoryCount} dir{info.directoryCount !== 1 ? "s" : ""},{" "}
            {info.totalBytes > 1024
              ? `${(info.totalBytes / 1024).toFixed(1)} KB`
              : `${info.totalBytes} B`}
          </span>
        </div>
      )}
    </div>
  );
});

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);

  const agent = useAgent({
    agent: "WorkspaceChatAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";
  const prevStreamingRef = useRef(false);

  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      fileBrowserRef.current?.refresh();
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Sidebar — File Browser */}
      <div className="w-64 border-r border-kumo-line bg-kumo-base flex flex-col shrink-0">
        <div className="px-3 py-3 border-b border-kumo-line">
          <div className="flex items-center gap-2">
            <TerminalIcon size={16} className="text-kumo-accent" />
            <span className="text-sm font-semibold text-kumo-default">
              Workspace
            </span>
          </div>
        </div>
        <FileBrowser
          ref={fileBrowserRef}
          agent={
            agent as unknown as {
              call: (method: string, args: unknown[]) => Promise<unknown>;
            }
          }
          isConnected={isConnected}
        />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-kumo-default">
                Workspace Chat
              </h1>
              <Badge variant="secondary">
                <TerminalIcon size={12} weight="bold" className="mr-1" />
                AI + Files
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={clearHistory}
              >
                Clear
              </Button>
            </div>
          </div>
        </header>

        {/* Explainer */}
        <div className="px-5 pt-4">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Workspace Chat
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    An AI assistant with a persistent virtual filesystem. Ask it
                    to create files, write code, run bash commands, or explore
                    the workspace. Files persist across conversations.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && (
              <Empty
                icon={<TerminalIcon size={32} />}
                title="Start building"
                description='Try "Create a hello world HTML page" or "Show me what files are in the workspace"'
              />
            )}

            {messages.map((message, index) => {
              const isUser = message.role === "user";
              const isLastAssistant =
                message.role === "assistant" && index === messages.length - 1;

              if (isUser) {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                      {getMessageText(message)}
                    </div>
                  </div>
                );
              }

              return (
                <div key={message.id} className="space-y-2">
                  {message.parts.map((part, partIndex) => {
                    if (part.type === "text") {
                      if (!part.text) return null;
                      const isLastTextPart = message.parts
                        .slice(partIndex + 1)
                        .every((p) => p.type !== "text");

                      return (
                        <div key={partIndex} className="flex justify-start">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme"
                              controls={false}
                              isAnimating={
                                isLastAssistant && isLastTextPart && isStreaming
                              }
                            >
                              {part.text}
                            </Streamdown>
                          </div>
                        </div>
                      );
                    }

                    if (part.type === "reasoning") {
                      if (!part.text) return null;
                      return (
                        <div key={partIndex} className="flex justify-start">
                          <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                            <div className="flex items-center gap-2 mb-1">
                              <GearIcon
                                size={14}
                                className="text-kumo-inactive"
                              />
                              <Text size="xs" variant="secondary" bold>
                                Thinking
                              </Text>
                            </div>
                            <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                              {part.text}
                            </div>
                          </Surface>
                        </div>
                      );
                    }

                    if (!isToolUIPart(part)) return null;
                    const toolName = getToolName(part);

                    if (part.state === "output-available") {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2 mb-1">
                              <GearIcon
                                size={14}
                                className="text-kumo-inactive"
                              />
                              <Text size="xs" variant="secondary" bold>
                                {toolName}
                              </Text>
                              <Badge variant="secondary">Done</Badge>
                            </div>
                            <div className="font-mono max-h-32 overflow-y-auto">
                              <Text size="xs" variant="secondary">
                                {JSON.stringify(part.output, null, 2)}
                              </Text>
                            </div>
                          </Surface>
                        </div>
                      );
                    }

                    if (
                      part.state === "input-available" ||
                      part.state === "input-streaming"
                    ) {
                      return (
                        <div
                          key={part.toolCallId}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2">
                              <GearIcon
                                size={14}
                                className="text-kumo-inactive animate-spin"
                              />
                              <Text size="xs" variant="secondary">
                                Running {toolName}...
                              </Text>
                            </div>
                          </Surface>
                        </div>
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

        {/* Input */}
        <div className="border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
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
                    send();
                  }
                }}
                placeholder='Try: "Create a package.json for a web app"'
                disabled={!isConnected || isStreaming}
                rows={2}
                className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
              />
              {isStreaming ? (
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Stop streaming"
                  onClick={stop}
                  icon={<StopIcon size={18} weight="fill" />}
                  className="mb-0.5"
                />
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!input.trim() || !isConnected}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByAgents />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
