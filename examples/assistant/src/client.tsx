/**
 * Assistant — Client
 *
 * Left sidebar: orchestrator + spawned agents hierarchy.
 * Main area: chat for the active agent.
 *
 * Data sources:
 *   - Agent list: from Agent state sync (useAgent onStateUpdate)
 *   - Chat messages & streaming: useChat with custom AgentChatTransport
 *   - Agent CRUD + navigation: via agent.call() RPC + WS messages
 *
 * The AgentChatTransport bridges the AI SDK's useChat hook with the Agent
 * WebSocket connection: sendMessages() triggers the server-side RPC, then
 * pipes WS stream-event messages into a ReadableStream<UIMessageChunk>
 * that useChat consumes and renders.
 */

import "./styles.css";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo
} from "react";
import { useAgent } from "agents/react";
import { applyChunkToParts } from "@cloudflare/think/message-builder";
import { AgentChatTransport } from "@cloudflare/think/transport";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
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
  ChatTextIcon,
  BroomIcon,
  InfoIcon,
  FolderIcon,
  GearIcon,
  PlugsConnectedIcon,
  WrenchIcon,
  SignInIcon,
  TrashIcon,
  XIcon,
  RobotIcon,
  ArrowLeftIcon,
  CircleNotchIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  ArrowSquareOutIcon,
  FileIcon,
  CaretRightIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import type { AppState, AgentInfo, FileInfo } from "./server";

const ORCHESTRATOR_ID = "orchestrator";

// ─── Helpers ──────────────────────────────────────────────────────────────

function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ─── Agent status helpers ─────────────────────────────────────────────────

function AgentStatusIcon({ status }: { status: AgentInfo["status"] }) {
  switch (status) {
    case "working":
      return (
        <CircleNotchIcon size={12} className="text-kumo-accent animate-spin" />
      );
    case "done":
      return <CheckCircleIcon size={12} className="text-kumo-success" />;
    case "error":
      return <WarningCircleIcon size={12} className="text-kumo-danger" />;
    default:
      return null;
  }
}

// ─── Agent Sidebar ────────────────────────────────────────────────────────

function AgentSidebar({
  agents,
  activeAgentId,
  onSwitch,
  onDelete,
  onClear,
  onRename
}: {
  agents: AgentInfo[];
  activeAgentId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const orchestrator = agents.find((a) => a.id === ORCHESTRATOR_ID);
  const subAgents = agents.filter((a) => a.id !== ORCHESTRATOR_ID);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RobotIcon size={18} className="text-kumo-brand" />
          <Text size="sm" bold>
            Agents
          </Text>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {/* Orchestrator — always at top */}
        {orchestrator && (
          <div
            // oxlint-disable-next-line prefer-tag-over-role
            role="button"
            tabIndex={0}
            className={`group rounded-lg px-3 py-2 cursor-pointer transition-colors w-full text-left ${
              orchestrator.id === activeAgentId
                ? "bg-kumo-tint ring-1 ring-kumo-ring"
                : "hover:bg-kumo-tint/50"
            }`}
            onClick={() => onSwitch(orchestrator.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSwitch(orchestrator.id);
              }
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <RobotIcon
                  size={14}
                  className={
                    orchestrator.id === activeAgentId
                      ? "text-kumo-brand"
                      : "text-kumo-inactive"
                  }
                />
                <Text size="sm" bold>
                  Orchestrator
                </Text>
              </div>
              {orchestrator.messageCount > 0 && (
                <Badge variant="secondary">{orchestrator.messageCount}</Badge>
              )}
            </div>
            {orchestrator.id === activeAgentId && (
              <div className="flex items-center gap-1 mt-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear(orchestrator.id);
                  }}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Sub-agents section */}
        {subAgents.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1">
              <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wider">
                Spawned Agents
              </span>
            </div>
            {subAgents.map((ag) => {
              const isActive = ag.id === activeAgentId;
              return (
                <div
                  key={ag.id}
                  // oxlint-disable-next-line prefer-tag-over-role
                  role="button"
                  tabIndex={0}
                  className={`group rounded-lg px-3 py-2 cursor-pointer transition-colors w-full text-left ${
                    isActive
                      ? "bg-kumo-tint ring-1 ring-kumo-ring"
                      : "hover:bg-kumo-tint/50"
                  }`}
                  onClick={() => onSwitch(ag.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSwitch(ag.id);
                    }
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <ChatTextIcon
                        size={14}
                        className={
                          isActive ? "text-kumo-brand" : "text-kumo-inactive"
                        }
                      />
                      {editingId === ag.id ? (
                        <input
                          className="flex-1 text-sm bg-transparent border-b border-kumo-line text-kumo-default outline-none"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              onRename(ag.id, editName);
                              setEditingId(null);
                            }
                            if (e.key === "Escape") {
                              setEditingId(null);
                            }
                          }}
                          onBlur={() => {
                            onRename(ag.id, editName);
                            setEditingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <Text size="sm" bold>
                          {ag.name}
                        </Text>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <AgentStatusIcon status={ag.status} />
                      {ag.messageCount > 0 && editingId !== ag.id && (
                        <Badge variant="secondary">{ag.messageCount}</Badge>
                      )}
                    </div>
                  </div>

                  {ag.lastTaskDescription && (
                    <span className="block text-xs text-kumo-subtle mt-0.5 truncate">
                      {ag.lastTaskDescription}
                    </span>
                  )}

                  <div
                    className={`flex items-center gap-1 mt-1.5 ${
                      isActive
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100"
                    } transition-opacity`}
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(ag.id);
                        setEditName(ag.name);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClear(ag.id);
                      }}
                    >
                      Clear
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(ag.id);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Messages ──────────────────────────────────────────────────────────────

// ─── Orchestrator tool names for special rendering ────────────────────────

const ORCHESTRATOR_TOOLS = new Set([
  "spawn_agent",
  "delegate_task",
  "hand_off"
]);

function DelegationCard({
  toolName,
  input,
  output,
  state,
  onNavigate
}: {
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  state: string;
  onNavigate: (agentId: string) => void;
}) {
  const out = output as Record<string, unknown> | null | undefined;
  const agentId = (out?.agentId ?? input?.agent_id) as string | undefined;
  const isRunning = state !== "output-available";

  if (toolName === "spawn_agent") {
    return (
      <div className="flex items-center gap-2">
        <RobotIcon size={14} className="text-kumo-accent" />
        <Text size="xs" bold>
          Spawning: {(input.name as string) ?? "agent"}
        </Text>
        {isRunning ? (
          <CircleNotchIcon
            size={12}
            className="animate-spin text-kumo-accent"
          />
        ) : agentId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onNavigate(agentId)}
          >
            <ArrowSquareOutIcon size={12} className="mr-1" />
            Open
          </Button>
        ) : null}
      </div>
    );
  }

  if (toolName === "delegate_task") {
    const isDelegated = !isRunning && out?.status === "delegated";
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <GearIcon
            size={14}
            className={
              isRunning ? "animate-spin text-kumo-accent" : "text-kumo-inactive"
            }
          />
          <Text size="xs" bold>
            {isDelegated ? "Delegated to agent" : "Delegating to agent"}
          </Text>
          {isRunning && <Badge variant="secondary">sending</Badge>}
          {isDelegated && <Badge variant="secondary">background</Badge>}
        </div>
        {isDelegated && out?.task != null && (
          <span className="block text-xs text-kumo-subtle mt-0.5 truncate">
            {String(out.task)}
          </span>
        )}
        {isDelegated && agentId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onNavigate(agentId)}
          >
            <ArrowSquareOutIcon size={12} className="mr-1" />
            View agent
          </Button>
        )}
        {!isRunning && out?.error != null && (
          <span className="text-xs text-kumo-danger">{String(out.error)}</span>
        )}
      </div>
    );
  }

  if (toolName === "hand_off") {
    return (
      <div className="flex items-center gap-2">
        <ArrowSquareOutIcon size={14} className="text-kumo-accent" />
        <Text size="xs" bold>
          Handing off to {(out?.name as string) ?? "agent"}
        </Text>
        {agentId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onNavigate(agentId)}
          >
            Go to chat
          </Button>
        )}
      </div>
    );
  }

  // list_agents, list_available_tools — generic rendering
  return null;
}

function Messages({
  messages,
  status,
  onNavigate,
  activeAgent
}: {
  messages: UIMessage[];
  status: string;
  onNavigate: (agentId: string) => void;
  activeAgent: AgentInfo | undefined;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const isBusy = status === "submitted" || status === "streaming";
  const isOrch = activeAgent?.id === ORCHESTRATOR_ID;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBusy]);

  if (messages.length === 0 && !isBusy) {
    return (
      <>
        <Surface className="p-4 rounded-xl ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div>
              <Text size="sm" bold>
                {isOrch
                  ? "Orchestrator Assistant"
                  : (activeAgent?.name ?? "Agent")}
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  {isOrch
                    ? "An AI orchestrator that can spawn specialized agents, delegate tasks, or hand off conversations. It has workspace tools, MCP server support, and model routing (fast vs capable)."
                    : `A specialized agent (${activeAgent?.config.modelTier ?? "fast"} model, ${activeAgent?.config.toolAccess ?? "workspace"} tools). Chat with it directly or navigate back to the orchestrator.`}
                </Text>
              </span>
            </div>
          </div>
        </Surface>
        <Empty
          icon={isOrch ? <FolderIcon size={32} /> : <ChatTextIcon size={32} />}
          title="Start a conversation"
          description={
            isOrch
              ? 'Try "Create a researcher agent to find info about X" or "Write a package.json for a Node.js project"'
              : "Send a message to start chatting with this agent"
          }
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((msg) => (
        <div key={msg.id}>
          {msg.role === "user" ? (
            <div className="flex justify-end">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                {getMessageText(msg)}
              </div>
            </div>
          ) : (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
                {msg.parts.map((part, i) => {
                  if (part.type === "reasoning") {
                    return (
                      <details
                        key={i}
                        className="px-4 py-2 border-b border-kumo-line"
                        open={"state" in part && part.state === "streaming"}
                      >
                        <summary className="cursor-pointer text-xs text-kumo-inactive select-none">
                          Reasoning
                        </summary>
                        <div className="mt-1 text-xs text-kumo-secondary italic whitespace-pre-wrap">
                          {part.text}
                        </div>
                      </details>
                    );
                  }
                  if (part.type.startsWith("tool-") && "toolCallId" in part) {
                    const tp = part as unknown as {
                      type: string;
                      toolCallId: string;
                      state: string;
                      input: unknown;
                      output?: unknown;
                    };
                    const toolName = tp.type.split("-").slice(1).join("-");

                    // Orchestrator tools get special delegation card rendering
                    if (ORCHESTRATOR_TOOLS.has(toolName)) {
                      return (
                        <div
                          key={i}
                          className="px-4 py-2.5 border-b border-kumo-line"
                        >
                          <DelegationCard
                            toolName={toolName}
                            input={(tp.input ?? {}) as Record<string, unknown>}
                            output={tp.output}
                            state={tp.state}
                            onNavigate={onNavigate}
                          />
                        </div>
                      );
                    }

                    return (
                      <div
                        key={i}
                        className="px-4 py-2.5 border-b border-kumo-line"
                      >
                        <div className="flex items-center gap-2">
                          <GearIcon
                            size={14}
                            className={
                              tp.state === "output-available"
                                ? "text-kumo-inactive"
                                : "text-kumo-inactive animate-spin"
                            }
                          />
                          <Text size="xs" bold>
                            {toolName}
                          </Text>
                          <Badge variant="secondary">{tp.state}</Badge>
                        </div>
                        {tp.input != null &&
                          Object.keys(tp.input as Record<string, unknown>)
                            .length > 0 && (
                            <pre className="mt-1 text-xs text-kumo-secondary overflow-auto">
                              {JSON.stringify(tp.input, null, 2)}
                            </pre>
                          )}
                        {tp.state === "output-available" &&
                          tp.output != null && (
                            <pre className="mt-1 text-xs text-kumo-brand overflow-auto">
                              {formatToolOutput(tp.output)}
                            </pre>
                          )}
                      </div>
                    );
                  }
                  if (part.type === "text") {
                    return (
                      <Streamdown
                        key={i}
                        className="sd-theme px-4 py-2.5"
                        controls={false}
                        isAnimating={
                          "state" in part && part.state === "streaming"
                        }
                      >
                        {part.text}
                      </Streamdown>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          )}
        </div>
      ))}

      {status === "submitted" && (
        <div className="flex justify-start">
          <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-kumo-brand rounded-full animate-pulse" />
              <Text size="xs" variant="secondary">
                Thinking...
              </Text>
            </div>
          </div>
        </div>
      )}

      {!isBusy && activeAgent?.status === "working" && (
        <div className="flex justify-start">
          <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
            <div className="flex items-center gap-2">
              <CircleNotchIcon
                size={14}
                className="text-kumo-accent animate-spin"
              />
              <Text size="xs" variant="secondary">
                Working on background task...
              </Text>
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

// ─── Workspace Panel ─────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AgentRpc {
  call(method: string, args?: unknown[]): Promise<unknown>;
}

function WorkspacePanel({
  agent,
  agentId,
  onClose
}: {
  agent: AgentRpc;
  agentId: string;
  onClose: () => void;
}) {
  const [which, setWhich] = useState<"private" | "shared">("private");
  const [currentPath, setCurrentPath] = useState("/");
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);

  // Load directory listing
  const loadDir = useCallback(
    async (path: string) => {
      setLoading(true);
      setSelectedFile(null);
      try {
        const result = (await agent.call("listWorkspaceFiles", [
          agentId,
          which,
          path
        ])) as FileInfo[];
        setFiles(result ?? []);
        setCurrentPath(path);
      } catch {
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [agent, agentId, which]
  );

  // Load file content
  const loadFile = useCallback(
    async (path: string) => {
      setFileLoading(true);
      try {
        const content = (await agent.call("readWorkspaceFile", [
          agentId,
          which,
          path
        ])) as string | null;
        setSelectedFile({ path, content: content ?? "(empty)" });
      } catch {
        setSelectedFile({ path, content: "(error reading file)" });
      } finally {
        setFileLoading(false);
      }
    },
    [agent, agentId, which]
  );

  // Reload on agent/tab change
  useEffect(() => {
    loadDir("/");
  }, [loadDir]);

  // Breadcrumb segments
  const segments =
    currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);

  const sorted = useMemo(() => {
    const dirs = files.filter((f) => f.type === "directory");
    const rest = files.filter((f) => f.type !== "directory");
    return [...dirs, ...rest];
  }, [files]);

  return (
    <div className="w-[320px] bg-kumo-base border-l border-kumo-line shrink-0 flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderIcon size={16} className="text-kumo-brand" />
          <Text size="sm" bold>
            Workspace
          </Text>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Close workspace"
          icon={<XIcon size={14} />}
          onClick={onClose}
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-kumo-line">
        <button
          type="button"
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            which === "private"
              ? "text-kumo-brand border-b-2 border-kumo-brand"
              : "text-kumo-subtle hover:text-kumo-default"
          }`}
          onClick={() => setWhich("private")}
        >
          Private
        </button>
        <button
          type="button"
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            which === "shared"
              ? "text-kumo-brand border-b-2 border-kumo-brand"
              : "text-kumo-subtle hover:text-kumo-default"
          }`}
          onClick={() => setWhich("shared")}
        >
          Shared
        </button>
      </div>

      {/* Breadcrumbs */}
      <div className="px-3 py-2 border-b border-kumo-line flex items-center gap-1 text-xs overflow-x-auto">
        <button
          type="button"
          className="text-kumo-accent hover:underline shrink-0"
          onClick={() => loadDir("/")}
        >
          /
        </button>
        {segments.map((seg, i) => {
          const path = "/" + segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={path} className="flex items-center gap-1 shrink-0">
              <CaretRightIcon size={10} className="text-kumo-inactive" />
              {isLast ? (
                <span className="text-kumo-default font-medium">{seg}</span>
              ) : (
                <button
                  type="button"
                  className="text-kumo-accent hover:underline"
                  onClick={() => loadDir(path)}
                >
                  {seg}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <CircleNotchIcon
              size={16}
              className="animate-spin text-kumo-accent"
            />
          </div>
        ) : sorted.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Text size="xs" variant="secondary">
              Empty directory
            </Text>
          </div>
        ) : (
          <div className="py-1">
            {sorted.map((file) => (
              <button
                key={file.path}
                type="button"
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-tint/50 transition-colors ${
                  selectedFile?.path === file.path ? "bg-kumo-tint" : ""
                }`}
                onClick={() => {
                  if (file.type === "directory") {
                    loadDir(file.path);
                  } else {
                    loadFile(file.path);
                  }
                }}
              >
                {file.type === "directory" ? (
                  <FolderIcon
                    size={14}
                    weight="fill"
                    className="text-kumo-accent shrink-0"
                  />
                ) : (
                  <FileIcon size={14} className="text-kumo-inactive shrink-0" />
                )}
                <span className="text-xs text-kumo-default truncate flex-1">
                  {file.name}
                </span>
                {file.type === "file" && (
                  <span className="text-[10px] text-kumo-subtle shrink-0">
                    {formatFileSize(file.size)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* File viewer */}
      {selectedFile && (
        <div className="border-t border-kumo-line flex flex-col max-h-[40%]">
          <div className="px-3 py-2 border-b border-kumo-line flex items-center justify-between">
            <span className="text-xs font-medium text-kumo-default truncate">
              {selectedFile.path.split("/").pop()}
            </span>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Close file"
              icon={<XIcon size={12} />}
              onClick={() => setSelectedFile(null)}
            />
          </div>
          <div className="flex-1 overflow-auto">
            {fileLoading ? (
              <div className="flex items-center justify-center py-4">
                <CircleNotchIcon
                  size={14}
                  className="animate-spin text-kumo-accent"
                />
              </div>
            ) : (
              <pre className="px-3 py-2 text-xs font-mono text-kumo-secondary whitespace-pre-wrap break-all leading-relaxed">
                {selectedFile.content}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Messages (continued) ────────────────────────────────────────────────────

function formatToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  const setChatMessagesRef = useRef<((messages: UIMessage[]) => void) | null>(
    null
  );

  // Ref for handleSwitch so navigate handler can call it without stale closure
  const handleSwitchRef = useRef<(id: string) => Promise<void>>(undefined);

  // Track active delegation stream (server-initiated, not from useChat transport)
  const delegationRef = useRef<{
    requestId: string;
    baseMessages: UIMessage[];
    assistantMsg: UIMessage;
  } | null>(null);

  // Last messages received from server — used as base when a delegation stream starts
  const lastMessagesRef = useRef<UIMessage[]>([]);

  const handleServerMessage = useCallback((event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "messages") {
        setActiveAgentId(msg.agentId);
        setChatMessagesRef.current?.(msg.messages);
        lastMessagesRef.current = msg.messages;
        delegationRef.current = null;
      } else if (msg.type === "navigate") {
        handleSwitchRef.current?.(msg.agentId);
      } else if (msg.type === "stream-start" && msg.delegation) {
        delegationRef.current = {
          requestId: msg.requestId,
          baseMessages: lastMessagesRef.current,
          assistantMsg: {
            id: `deleg-${msg.requestId}`,
            role: "assistant",
            parts: []
          }
        };
      } else if (
        msg.type === "stream-event" &&
        delegationRef.current?.requestId === msg.requestId
      ) {
        const d = delegationRef.current;
        if (!d) return;
        const chunk = JSON.parse(msg.event);
        applyChunkToParts(d.assistantMsg.parts, chunk);
        setChatMessagesRef.current?.([
          ...d.baseMessages,
          { ...d.assistantMsg, parts: [...d.assistantMsg.parts] }
        ]);
      } else if (
        msg.type === "stream-done" &&
        delegationRef.current?.requestId === msg.requestId
      ) {
        if (msg.error && delegationRef.current) {
          const d = delegationRef.current;
          d.assistantMsg.parts.push({
            type: "text",
            text: `\n\nError: ${msg.error}`
          } as UIMessage["parts"][number]);
          setChatMessagesRef.current?.([
            ...d.baseMessages,
            { ...d.assistantMsg, parts: [...d.assistantMsg.parts] }
          ]);
        }
        delegationRef.current = null;
      }
    } catch (err) {
      console.error(`[CLIENT] handleServerMessage error`, err);
    }
  }, []);

  const agent = useAgent<AppState>({
    agent: "MyAssistant",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: AppState) => setAgents(state.agents),
      []
    ),
    onMessage: handleServerMessage,
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, [])
  });

  // Auto-select orchestrator on first connect
  useEffect(() => {
    if (connectionStatus === "connected" && !activeAgentId) {
      agent.call("switchAgent", [ORCHESTRATOR_ID]).catch(() => {});
    }
  }, [connectionStatus, activeAgentId, agent]);

  // Close MCP panel when clicking outside
  useEffect(() => {
    if (!showMcpPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        mcpPanelRef.current &&
        !mcpPanelRef.current.contains(e.target as Node)
      ) {
        setShowMcpPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMcpPanel]);

  const handleAddServer = useCallback(async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      await agent.call("addServer", [
        mcpName.trim(),
        mcpUrl.trim(),
        window.location.origin
      ]);
      setMcpName("");
      setMcpUrl("");
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  }, [agent, mcpName, mcpUrl]);

  const handleRemoveServer = useCallback(
    async (serverId: string) => {
      try {
        await agent.call("removeServer", [serverId]);
      } catch (e) {
        console.error("Failed to remove MCP server:", e);
      }
    },
    [agent]
  );

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const transport = useMemo(() => new AgentChatTransport(agent), [agent]);

  const {
    messages,
    setMessages: setChatMessages,
    sendMessage,
    resumeStream,
    status
  } = useChat({ transport });

  setChatMessagesRef.current = setChatMessages;

  const isConnected = connectionStatus === "connected";
  const isBusy = status === "submitted" || status === "streaming";

  const handleDelete = useCallback(
    async (id: string) => {
      transport.detach();
      await agent.call("deleteAgent", [id]);
      if (activeAgentId === id) {
        setActiveAgentId(ORCHESTRATOR_ID);
        setChatMessages([]);
      }
    },
    [agent, activeAgentId, setChatMessages, transport]
  );

  const handleClear = useCallback(
    async (id: string) => agent.call("clearAgent", [id]),
    [agent]
  );

  const handleRename = useCallback(
    async (id: string, name: string) => agent.call("renameAgent", [id, name]),
    [agent]
  );

  const handleSwitch = useCallback(
    async (id: string) => {
      transport.detach();
      await agent.call("switchAgent", [id]);
      // Skip resumeStream when viewing a delegation stream — resumeStream
      // finds no user-initiated stream and resets useChat messages, wiping
      // the delegation text we're already displaying.
      if (!delegationRef.current) {
        resumeStream();
      }
    },
    [agent, transport, resumeStream]
  );

  handleSwitchRef.current = handleSwitch;

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy || !activeAgentId) return;
    setInput("");
    sendMessage({ text });
  }, [input, isBusy, activeAgentId, sendMessage]);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const isOrchestrator = activeAgentId === ORCHESTRATOR_ID;

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left: Agent sidebar */}
      <div className="w-[260px] bg-kumo-base border-r border-kumo-line shrink-0">
        <AgentSidebar
          agents={agents}
          activeAgentId={activeAgentId}
          onSwitch={handleSwitch}
          onDelete={handleDelete}
          onClear={handleClear}
          onRename={handleRename}
        />
      </div>

      {/* Main: Chat */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {activeAgent ? (
                <>
                  {isOrchestrator ? (
                    <RobotIcon size={20} className="text-kumo-brand" />
                  ) : (
                    <ChatTextIcon size={20} className="text-kumo-brand" />
                  )}
                  <Text size="lg" bold>
                    {activeAgent.name}
                  </Text>
                  {activeAgent.messageCount > 0 && (
                    <Badge variant="secondary">
                      {activeAgent.messageCount} messages
                    </Badge>
                  )}
                  {!isOrchestrator && (
                    <>
                      <Badge variant="secondary">
                        {activeAgent.config.modelTier}
                      </Badge>
                      <Badge variant="secondary">
                        <FolderIcon size={12} weight="bold" className="mr-1" />
                        {activeAgent.config.toolAccess}
                      </Badge>
                    </>
                  )}
                  {!isOrchestrator && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<ArrowLeftIcon size={14} />}
                      onClick={() => handleSwitch(ORCHESTRATOR_ID)}
                    >
                      Back
                    </Button>
                  )}
                </>
              ) : (
                <Text size="lg" bold variant="secondary">
                  Connecting...
                </Text>
              )}
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <div className="relative" ref={mcpPanelRef}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PlugsConnectedIcon size={14} />}
                  onClick={() => setShowMcpPanel(!showMcpPanel)}
                >
                  MCP
                  {mcpToolCount > 0 && (
                    <Badge variant="primary" className="ml-1.5">
                      <WrenchIcon size={10} className="mr-0.5" />
                      {mcpToolCount}
                    </Badge>
                  )}
                </Button>

                {showMcpPanel && (
                  <div className="absolute right-0 top-full mt-2 w-96 z-50">
                    <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <PlugsConnectedIcon
                            size={16}
                            className="text-kumo-accent"
                          />
                          <Text size="sm" bold>
                            MCP Servers
                          </Text>
                          {serverEntries.length > 0 && (
                            <Badge variant="secondary">
                              {serverEntries.length}
                            </Badge>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label="Close MCP panel"
                          icon={<XIcon size={14} />}
                          onClick={() => setShowMcpPanel(false)}
                        />
                      </div>

                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleAddServer();
                        }}
                        className="space-y-2"
                      >
                        <input
                          type="text"
                          value={mcpName}
                          onChange={(e) => setMcpName(e.target.value)}
                          placeholder="Server name"
                          className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                        />
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={mcpUrl}
                            onChange={(e) => setMcpUrl(e.target.value)}
                            placeholder="https://mcp.example.com"
                            className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent font-mono"
                          />
                          <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            disabled={
                              isAddingServer ||
                              !mcpName.trim() ||
                              !mcpUrl.trim()
                            }
                          >
                            {isAddingServer ? "..." : "Add"}
                          </Button>
                        </div>
                      </form>

                      {serverEntries.length > 0 && (
                        <div className="space-y-2 max-h-60 overflow-y-auto">
                          {serverEntries.map(([id, server]) => (
                            <div
                              key={id}
                              className="flex items-start justify-between p-2.5 rounded-lg border border-kumo-line"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-kumo-default truncate">
                                    {server.name}
                                  </span>
                                  <Badge
                                    variant={
                                      server.state === "ready"
                                        ? "primary"
                                        : server.state === "failed"
                                          ? "destructive"
                                          : "secondary"
                                    }
                                  >
                                    {server.state}
                                  </Badge>
                                </div>
                                <span className="text-xs font-mono text-kumo-subtle truncate block mt-0.5">
                                  {server.server_url}
                                </span>
                                {server.state === "failed" && server.error && (
                                  <span className="text-xs text-red-500 block mt-0.5">
                                    {server.error}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0 ml-2">
                                {server.state === "authenticating" &&
                                  server.auth_url && (
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      icon={<SignInIcon size={12} />}
                                      onClick={() =>
                                        window.open(
                                          server.auth_url as string,
                                          "oauth",
                                          "width=600,height=800"
                                        )
                                      }
                                    >
                                      Auth
                                    </Button>
                                  )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  shape="square"
                                  aria-label="Remove server"
                                  icon={<TrashIcon size={12} />}
                                  onClick={() => handleRemoveServer(id)}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {mcpToolCount > 0 && (
                        <div className="pt-2 border-t border-kumo-line">
                          <div className="flex items-center gap-2">
                            <WrenchIcon
                              size={14}
                              className="text-kumo-subtle"
                            />
                            <span className="text-xs text-kumo-subtle">
                              {mcpToolCount} tool
                              {mcpToolCount !== 1 ? "s" : ""} available from MCP
                              servers
                            </span>
                          </div>
                        </div>
                      )}
                    </Surface>
                  </div>
                )}
              </div>
              {activeAgent && (
                <Button
                  variant={showWorkspace ? "primary" : "secondary"}
                  size="sm"
                  icon={<FolderIcon size={14} />}
                  onClick={() => setShowWorkspace(!showWorkspace)}
                >
                  Files
                </Button>
              )}
              {activeAgent && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<BroomIcon size={14} />}
                  onClick={() => handleClear(activeAgent.id)}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6">
            {activeAgentId ? (
              <Messages
                messages={messages}
                status={status}
                onNavigate={handleSwitch}
                activeAgent={activeAgent}
              />
            ) : (
              <Empty
                icon={<RobotIcon size={32} />}
                title="Connecting..."
                description="Waiting for connection to the orchestrator"
              />
            )}
          </div>
        </div>

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
                placeholder={
                  activeAgentId
                    ? isOrchestrator
                      ? "Ask me anything, or tell me to spawn a specialist agent..."
                      : "Chat with this agent..."
                    : "Connecting..."
                }
                disabled={!isConnected || isBusy || !activeAgentId}
                rows={2}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  !input.trim() || !isConnected || isBusy || !activeAgentId
                }
                icon={<PaperPlaneRightIcon size={18} />}
                loading={isBusy}
                className="mb-0.5"
              />
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByAgents />
          </div>
        </div>
      </div>

      {/* Right: Workspace panel */}
      {showWorkspace && activeAgentId && (
        <WorkspacePanel
          agent={agent}
          agentId={activeAgentId}
          onClose={() => setShowWorkspace(false)}
        />
      )}
    </div>
  );
}

export default function AppRoot() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <App />
    </Suspense>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(
  <ThemeProvider>
    <AppRoot />
  </ThemeProvider>
);
