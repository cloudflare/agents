import { Suspense, useCallback, useRef, useState, useEffect } from "react";
import { useAgent } from "agents/react";
import { Button, InputArea, Empty, Text } from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  BrainIcon,
  CodeIcon,
  TrashIcon,
  PlusIcon,
  ChatCircleIcon,
  WrenchIcon,
  FolderIcon,
  FileIcon,
  CaretRightIcon,
  CaretDownIcon,
  XIcon,
  ArrowClockwiseIcon,
  FolderOpenIcon,
  LinkSimpleIcon,
  LinkBreakIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import {
  MessageType,
  type ThinkMessage,
  type ThreadInfo,
  type WorkspaceInfo,
  type FileEntry,
  type ServerMessage
} from "./shared";

// ── Utilities ────────────────────────────────────────────────────────────────

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getThreadIdFromHash(): string | null {
  const hash = window.location.hash.slice(1);
  return hash || null;
}

function setHash(threadId: string | null) {
  if (threadId) {
    window.history.replaceState(null, "", `#${threadId}`);
  } else {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── File viewer overlay ───────────────────────────────────────────────────────

function FileViewer({
  path,
  content,
  loading,
  onClose
}: {
  path: string;
  content: string | null;
  loading: boolean;
  onClose: () => void;
}) {
  const filename = path.split("/").filter(Boolean).pop() ?? path;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`File viewer: ${path}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* oxlint-disable-next-line jsx_a11y/no-static-element-interactions */}
      <div
        role="document"
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-kumo-line bg-kumo-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileIcon size={14} className="shrink-0 text-kumo-inactive" />
            <span className="truncate font-mono text-xs text-kumo-inactive">
              {path}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 shrink-0 rounded p-1 text-kumo-inactive hover:bg-kumo-elevated hover:text-kumo-default"
            aria-label="Close file viewer"
          >
            <XIcon size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-xs text-kumo-inactive">
              Loading {filename}…
            </div>
          ) : content === null ? (
            <div className="flex h-32 items-center justify-center text-xs text-kumo-inactive">
              Binary or unreadable file
            </div>
          ) : content === "" ? (
            <div className="flex h-32 items-center justify-center text-xs text-kumo-inactive">
              Empty file
            </div>
          ) : (
            <pre className="overflow-auto p-4 font-mono text-xs leading-relaxed text-kumo-default">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── File tree entry ───────────────────────────────────────────────────────────

function FileTreeEntry({
  entry,
  depth,
  childEntries,
  isExpanded,
  isLoading,
  onToggleDir,
  onOpenFile
}: {
  entry: FileEntry;
  depth: number;
  childEntries?: FileEntry[];
  isExpanded: boolean;
  isLoading: boolean;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const indent = depth * 12;

  if (entry.type === "directory") {
    return (
      <>
        <button
          type="button"
          style={{ paddingLeft: `${indent + 8}px` }}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-kumo-default hover:bg-kumo-elevated"
          onClick={() => onToggleDir(entry.path)}
        >
          {isLoading ? (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-kumo-line border-t-kumo-brand" />
          ) : isExpanded ? (
            <CaretDownIcon size={10} className="shrink-0 text-kumo-inactive" />
          ) : (
            <CaretRightIcon size={10} className="shrink-0 text-kumo-inactive" />
          )}
          {isExpanded ? (
            <FolderOpenIcon size={13} className="shrink-0 text-kumo-brand" />
          ) : (
            <FolderIcon size={13} className="shrink-0 text-kumo-brand" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        {isExpanded &&
          childEntries?.map((child) => (
            <FileTreeEntry
              key={child.path}
              entry={child}
              depth={depth + 1}
              isExpanded={false}
              isLoading={false}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
      </>
    );
  }

  return (
    <button
      type="button"
      style={{ paddingLeft: `${indent + 8}px` }}
      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-kumo-default hover:bg-kumo-elevated"
      onClick={() => onOpenFile(entry.path)}
    >
      <span className="w-2.5 shrink-0" />
      <FileIcon size={13} className="shrink-0 text-kumo-inactive" />
      <span className="min-w-0 truncate">{entry.name}</span>
      <span className="ml-auto shrink-0 text-kumo-inactive">
        {formatBytes(entry.size)}
      </span>
    </button>
  );
}

// ── File browser panel ────────────────────────────────────────────────────────

function FileBrowser({
  workspaceId,
  workspaceName,
  fileTree,
  expandedDirs,
  loadingDirs,
  onListDir,
  onOpenFile
}: {
  workspaceId: string;
  workspaceName: string;
  fileTree: Record<string, FileEntry[]>;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  onListDir: (workspaceId: string, dir: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const rootEntries = fileTree["/"] ?? [];

  function handleToggleDir(path: string) {
    if (expandedDirs.has(path)) {
      // Close: parent component updates expandedDirs
      onListDir(workspaceId, path); // triggers collapse via state logic in Chat
    } else {
      onListDir(workspaceId, path);
    }
  }

  function renderEntries(entries: FileEntry[], depth: number) {
    return entries.map((entry) => (
      <FileTreeEntry
        key={entry.path}
        entry={entry}
        depth={depth}
        isExpanded={expandedDirs.has(entry.path)}
        isLoading={loadingDirs.has(entry.path)}
        childEntries={fileTree[entry.path]}
        onToggleDir={handleToggleDir}
        onOpenFile={onOpenFile}
      />
    ));
  }

  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-kumo-line bg-kumo-base">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-kumo-line px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FolderIcon size={14} className="shrink-0 text-kumo-brand" />
          <span className="truncate text-xs font-semibold text-kumo-default">
            {workspaceName}
          </span>
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-kumo-inactive hover:bg-kumo-elevated hover:text-kumo-default"
          onClick={() => onListDir(workspaceId, "/")}
          aria-label="Refresh file tree"
          title="Refresh"
        >
          <ArrowClockwiseIcon size={13} />
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {fileTree["/"] === undefined ? (
          <div className="flex h-20 items-center justify-center text-xs text-kumo-inactive">
            <span className="h-4 w-4 animate-spin rounded-full border border-kumo-line border-t-kumo-brand" />
          </div>
        ) : rootEntries.length === 0 ? (
          <div className="px-4 py-4 text-xs text-kumo-inactive">
            Workspace is empty
          </div>
        ) : (
          <div className="px-2">{renderEntries(rootEntries, 0)}</div>
        )}
      </div>
    </div>
  );
}

// ── Main chat component ───────────────────────────────────────────────────────

function Chat() {
  // ── Connection & core state ─────────────────────────────────────
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ThinkMessage[]>([]);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);

  // ── Streaming state ─────────────────────────────────────────────
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [reasoningText, setReasoningText] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // ── Thread navigation ───────────────────────────────────────────
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    getThreadIdFromHash
  );
  const pendingSelectRef = useRef(false);
  const initialLoadRef = useRef(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingHashLoadRef = useRef<string | null>(getThreadIdFromHash());

  // ── File browser state ──────────────────────────────────────────
  // fileTree: maps dir path → its immediate children (populated on demand)
  const [fileTree, setFileTree] = useState<Record<string, FileEntry[]>>({});
  // expandedDirs: set of dir paths that are currently open in the tree
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  // loadingDirs: dirs whose listing is in-flight
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  // selectedFilePath / fileContent: for the file viewer overlay
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);

  // Track which workspaceId the file browser is currently showing
  const activeWorkspaceIdRef = useRef<string | null>(null);

  // ── Derived: workspace attached to active thread ─────────────────
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const attachedWorkspaceId = activeThread?.workspaceId ?? null;
  const attachedWorkspace =
    workspaces.find((w) => w.id === attachedWorkspaceId) ?? null;

  // ── Agent (WebSocket) ───────────────────────────────────────────
  const agent = useAgent({
    agent: "ThinkAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onMessage: useCallback((event: MessageEvent) => {
      const data = JSON.parse(event.data) as ServerMessage<ThinkMessage>;

      switch (data.type) {
        case MessageType.THREADS:
          setThreads(data.threads);
          if (pendingSelectRef.current && data.threads.length > 0) {
            pendingSelectRef.current = false;
            const newest = data.threads[0];
            setActiveThreadId(newest.id);
            setHash(newest.id);
            setMessages([]);
          }
          if (initialLoadRef.current) {
            initialLoadRef.current = false;
            const hashId = pendingHashLoadRef.current;
            pendingHashLoadRef.current = null;
            if (
              hashId &&
              data.threads.some((t: ThreadInfo) => t.id === hashId)
            ) {
              setActiveThreadId(hashId);
            }
          }
          break;

        case MessageType.WORKSPACES:
          setWorkspaces(data.workspaces);
          break;

        case MessageType.SYNC:
          setActiveThreadId((current) => {
            if (data.threadId === current) {
              setMessages(data.messages);
              setStreamingText(null);
              setReasoningText(null);
              setActiveTool(null);
              setIsStreaming(false);
            }
            return current;
          });
          break;

        case MessageType.CLEAR:
          setActiveThreadId((current) => {
            if (data.threadId === current) setMessages([]);
            return current;
          });
          break;

        case MessageType.STREAM_DELTA:
          setActiveThreadId((current) => {
            if (data.threadId === current)
              setStreamingText((prev) => (prev ?? "") + data.delta);
            return current;
          });
          break;

        case MessageType.REASONING_DELTA:
          setActiveThreadId((current) => {
            if (data.threadId === current)
              setReasoningText((prev) => (prev ?? "") + data.delta);
            return current;
          });
          break;

        case MessageType.TOOL_CALL:
          setActiveThreadId((current) => {
            if (data.threadId === current) setActiveTool(data.toolName);
            return current;
          });
          break;

        case MessageType.STREAM_END:
          setActiveThreadId((current) => {
            if (data.threadId === current) {
              setIsStreaming(false);
              setActiveTool(null);
            }
            return current;
          });
          break;

        // ── File browser responses ──────────────────────────────
        case MessageType.FILE_LIST:
          setFileTree((prev) => ({ ...prev, [data.dir]: data.entries }));
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(data.dir);
            return next;
          });
          break;

        case MessageType.FILE_CONTENT:
          setFileContent(data.content);
          setFileContentLoading(false);
          break;
      }
    }, []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const isConnected = connectionStatus === "connected";

  // ── Thread navigation effects ────────────────────────────────────
  useEffect(() => {
    if (!isConnected) return;
    const hashId = getThreadIdFromHash();
    if (hashId && activeThreadId === hashId && messages.length === 0) {
      agent.send(
        JSON.stringify({ type: MessageType.GET_MESSAGES, threadId: hashId })
      );
    }
  }, [isConnected, activeThreadId, agent, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const onHashChange = () => {
      const id = getThreadIdFromHash();
      if (id && id !== activeThreadId) {
        setActiveThreadId(id);
        setMessages([]);
        agent.send(
          JSON.stringify({ type: MessageType.GET_MESSAGES, threadId: id })
        );
      } else if (!id) {
        setActiveThreadId(null);
        setMessages([]);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [agent, activeThreadId]);

  // ── File browser: load root when workspace changes ───────────────
  useEffect(() => {
    if (!isConnected || !attachedWorkspaceId) {
      activeWorkspaceIdRef.current = null;
      setFileTree({});
      setExpandedDirs(new Set());
      setLoadingDirs(new Set());
      return;
    }
    if (attachedWorkspaceId === activeWorkspaceIdRef.current) return;

    // New workspace attached — reset tree and load root
    activeWorkspaceIdRef.current = attachedWorkspaceId;
    setFileTree({});
    setExpandedDirs(new Set());
    setLoadingDirs(new Set(["/"]));
    agent.send(
      JSON.stringify({
        type: MessageType.LIST_FILES,
        workspaceId: attachedWorkspaceId,
        dir: "/"
      })
    );
  }, [isConnected, attachedWorkspaceId, agent]);

  // ── File browser: auto-refresh root after each agent run ─────────
  // Done via the STREAM_END handler. We track it via a ref to avoid
  // re-registering the onMessage callback on every render.
  const refreshFileTreeRef = useRef<(() => void) | null>(null);
  refreshFileTreeRef.current = () => {
    if (!attachedWorkspaceId) return;
    setLoadingDirs((prev) => new Set([...prev, "/"]));
    agent.send(
      JSON.stringify({
        type: MessageType.LIST_FILES,
        workspaceId: attachedWorkspaceId,
        dir: "/"
      })
    );
  };

  // Trigger refresh when streaming ends and there's an attached workspace
  useEffect(() => {
    if (!isStreaming && attachedWorkspaceId) {
      refreshFileTreeRef.current?.();
    }
    // We only want to refresh when streaming transitions from true→false,
    // so isStreaming is the only dep that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  // ── File browser actions ─────────────────────────────────────────
  const handleListDir = useCallback(
    (workspaceId: string, dir: string) => {
      // Toggle: if already expanded, collapse (remove from expandedDirs);
      // if not expanded, request the listing and expand.
      if (dir !== "/" && expandedDirs.has(dir)) {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
        return;
      }
      setExpandedDirs((prev) => new Set([...prev, dir]));
      setLoadingDirs((prev) => new Set([...prev, dir]));
      agent.send(
        JSON.stringify({ type: MessageType.LIST_FILES, workspaceId, dir })
      );
    },
    [agent, expandedDirs]
  );

  const handleOpenFile = useCallback(
    (path: string) => {
      if (!attachedWorkspaceId) return;
      setSelectedFilePath(path);
      setFileContent(null);
      setFileContentLoading(true);
      agent.send(
        JSON.stringify({
          type: MessageType.READ_FILE,
          workspaceId: attachedWorkspaceId,
          path
        })
      );
    },
    [agent, attachedWorkspaceId]
  );

  // ── Thread / message actions ─────────────────────────────────────
  const createThread = useCallback(() => {
    pendingSelectRef.current = true;
    agent.send(
      JSON.stringify({
        type: MessageType.CREATE_THREAD,
        name: `Thread ${threads.length + 1}`
      })
    );
  }, [agent, threads.length]);

  const selectThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      setHash(threadId);
      setMessages([]);
      agent.send(JSON.stringify({ type: MessageType.GET_MESSAGES, threadId }));
    },
    [agent]
  );

  const deleteThread = useCallback(
    (threadId: string) => {
      agent.send(JSON.stringify({ type: MessageType.DELETE_THREAD, threadId }));
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setHash(null);
        setMessages([]);
      }
    },
    [agent, activeThreadId]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || !activeThreadId || isStreaming) return;
    setInput("");

    const message: ThinkMessage = {
      id: genId(),
      role: "user",
      content: text,
      createdAt: Date.now()
    };

    setMessages((prev) => [...prev, message]);
    setStreamingText(null);
    setReasoningText(null);
    setIsStreaming(true);

    agent.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: activeThreadId,
        message
      })
    );
    agent.send(
      JSON.stringify({ type: MessageType.RUN, threadId: activeThreadId })
    );
  }, [input, agent, activeThreadId, isStreaming]);

  const clearHistory = useCallback(() => {
    if (!activeThreadId) return;
    setMessages([]);
    agent.send(
      JSON.stringify({
        type: MessageType.CLEAR_REQUEST,
        threadId: activeThreadId
      })
    );
  }, [agent, activeThreadId]);

  // ── Workspace actions ─────────────────────────────────────────────
  const createWorkspace = useCallback(() => {
    agent.send(
      JSON.stringify({
        type: MessageType.CREATE_WORKSPACE,
        name: `Workspace ${workspaces.length + 1}`
      })
    );
  }, [agent, workspaces.length]);

  const deleteWorkspace = useCallback(
    (workspaceId: string) => {
      agent.send(
        JSON.stringify({ type: MessageType.DELETE_WORKSPACE, workspaceId })
      );
    },
    [agent]
  );

  const toggleWorkspace = useCallback(
    (workspaceId: string) => {
      if (!activeThreadId) return;
      if (attachedWorkspaceId === workspaceId) {
        agent.send(
          JSON.stringify({
            type: MessageType.DETACH_WORKSPACE,
            threadId: activeThreadId
          })
        );
      } else {
        agent.send(
          JSON.stringify({
            type: MessageType.ATTACH_WORKSPACE,
            threadId: activeThreadId,
            workspaceId
          })
        );
      }
    },
    [agent, activeThreadId, attachedWorkspaceId]
  );

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* ── Left sidebar: thread list ─────────────────────────── */}
      <div className="flex w-56 shrink-0 flex-col border-r border-kumo-line bg-kumo-base">
        <div className="flex items-center justify-between border-b border-kumo-line px-4 py-4">
          <div className="flex items-center gap-2">
            <BrainIcon size={18} className="text-kumo-brand" weight="duotone" />
            <Text size="sm" bold>
              Threads
            </Text>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            onClick={createThread}
            disabled={!isConnected}
          />
        </div>

        {/* Thread list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {threads.length === 0 && (
            <div className="px-2 py-4">
              <Text size="xs" variant="secondary">
                No threads yet.
              </Text>
            </div>
          )}
          {threads.map((thread) => (
            <div
              key={thread.id}
              // oxlint-disable-next-line jsx_a11y/prefer-tag-over-role
              role="button"
              tabIndex={0}
              className={`group mb-1 flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                activeThreadId === thread.id
                  ? "bg-kumo-elevated"
                  : "hover:bg-kumo-elevated/50"
              }`}
              onClick={() => selectThread(thread.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectThread(thread.id);
                }
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <ChatCircleIcon
                  size={13}
                  className="shrink-0 text-kumo-inactive"
                />
                <span className="truncate text-sm text-kumo-default">
                  {thread.name}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {thread.workspaceId && (
                  <button
                    type="button"
                    title="Detach workspace"
                    className="text-kumo-brand hover:text-kumo-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      agent.send(
                        JSON.stringify({
                          type: MessageType.DETACH_WORKSPACE,
                          threadId: thread.id
                        })
                      );
                    }}
                  >
                    <FolderIcon size={10} />
                  </button>
                )}
                <button
                  type="button"
                  className="hidden text-kumo-inactive hover:text-kumo-danger group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteThread(thread.id);
                  }}
                >
                  <TrashIcon size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Workspaces section */}
        <div className="shrink-0 border-t border-kumo-line">
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-2">
              <FolderIcon size={13} className="text-kumo-inactive" />
              <Text size="xs" bold>
                Workspaces
              </Text>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<PlusIcon size={12} />}
              onClick={createWorkspace}
              disabled={!isConnected}
            />
          </div>

          <div className="max-h-36 overflow-y-auto px-2 pb-2">
            {workspaces.length === 0 && (
              <div className="px-2 pb-2">
                <Text size="xs" variant="secondary">
                  No workspaces.
                </Text>
              </div>
            )}
            {workspaces.map((ws) => {
              const isAttached = attachedWorkspaceId === ws.id;
              const canAttach = !!activeThreadId;
              return (
                <div
                  key={ws.id}
                  className="group mb-1 flex w-full items-center justify-between rounded-lg px-3 py-1.5"
                >
                  <button
                    type="button"
                    title={
                      !canAttach
                        ? "Select a thread first"
                        : isAttached
                          ? "Detach from thread"
                          : "Attach to thread"
                    }
                    disabled={!canAttach}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded text-left text-xs transition-colors disabled:opacity-40 ${
                      isAttached
                        ? "text-kumo-brand"
                        : "text-kumo-default hover:text-kumo-brand"
                    }`}
                    onClick={() => toggleWorkspace(ws.id)}
                  >
                    {isAttached ? (
                      <LinkSimpleIcon size={11} className="shrink-0" />
                    ) : (
                      <FolderIcon
                        size={11}
                        className="shrink-0 text-kumo-inactive"
                      />
                    )}
                    <span
                      className={`truncate ${isAttached ? "font-medium" : ""}`}
                    >
                      {ws.name}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {isAttached && (
                      <button
                        type="button"
                        title="Detach"
                        className="text-kumo-inactive opacity-0 hover:text-kumo-danger group-hover:opacity-100"
                        onClick={() => toggleWorkspace(ws.id)}
                      >
                        <LinkBreakIcon size={10} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Delete workspace"
                      className="text-kumo-inactive opacity-0 hover:text-kumo-danger group-hover:opacity-100"
                      onClick={() => deleteWorkspace(ws.id)}
                    >
                      <TrashIcon size={10} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t border-kumo-line p-3">
          <div className="flex items-center justify-between">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </div>
      </div>

      {/* ── Main: chat ──────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeThreadId ? (
          <>
            <header className="flex items-center justify-between border-b border-kumo-line bg-kumo-base px-5 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-kumo-default">
                  {threads.find((t) => t.id === activeThreadId)?.name ??
                    activeThreadId}
                </span>
                {attachedWorkspace && (
                  <span className="shrink-0 rounded-full border border-kumo-line px-2 py-0.5 text-xs text-kumo-inactive">
                    {attachedWorkspace.name}
                  </span>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<TrashIcon size={14} />}
                onClick={clearHistory}
              >
                Clear
              </Button>
            </header>

            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
                {messages.length === 0 && (
                  <Empty
                    icon={<CodeIcon size={32} />}
                    title="Start coding"
                    description="Send a message to begin."
                  />
                )}

                {messages.map((message) => {
                  const isUser = message.role === "user";
                  return (
                    <div key={message.id} className="space-y-2">
                      {isUser ? (
                        <div className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 leading-relaxed text-kumo-inverse">
                            <Streamdown className="sd-theme" controls={false}>
                              {message.content}
                            </Streamdown>
                          </div>
                        </div>
                      ) : (
                        <>
                          {message.reasoning && (
                            <div className="flex justify-start">
                              <details className="max-w-[85%] rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2 text-xs text-kumo-inactive">
                                <summary className="cursor-pointer select-none font-medium">
                                  Thinking
                                </summary>
                                <div className="mt-2 whitespace-pre-wrap font-mono opacity-70">
                                  {message.reasoning}
                                </div>
                              </details>
                            </div>
                          )}
                          <div className="flex justify-start">
                            <div className="max-w-[85%] overflow-hidden rounded-2xl rounded-bl-md bg-kumo-base leading-relaxed text-kumo-default">
                              <Streamdown
                                className="sd-theme px-4 py-2.5"
                                controls={false}
                              >
                                {message.content}
                              </Streamdown>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                {(streamingText !== null ||
                  reasoningText !== null ||
                  activeTool !== null) && (
                  <div className="space-y-2">
                    {reasoningText && (
                      <div className="flex justify-start">
                        <details className="max-w-[85%] rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2 text-xs text-kumo-inactive">
                          <summary className="cursor-pointer select-none font-medium">
                            Thinking
                            {isStreaming &&
                              streamingText === null &&
                              !activeTool && (
                                <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-kumo-inactive align-text-bottom" />
                              )}
                          </summary>
                          <div className="mt-2 whitespace-pre-wrap font-mono opacity-70">
                            {reasoningText}
                          </div>
                        </details>
                      </div>
                    )}
                    {activeTool && (
                      <div className="flex justify-start">
                        <div className="flex items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-elevated px-3 py-1 text-xs text-kumo-inactive">
                          <WrenchIcon
                            size={12}
                            className="animate-pulse text-kumo-brand"
                          />
                          <span className="font-mono">{activeTool}</span>
                        </div>
                      </div>
                    )}
                    {streamingText !== null && (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] overflow-hidden rounded-2xl rounded-bl-md bg-kumo-base leading-relaxed text-kumo-default">
                          <Streamdown
                            className="sd-theme px-4 py-2.5"
                            controls={false}
                            isAnimating={isStreaming}
                          >
                            {streamingText}
                          </Streamdown>
                        </div>
                      </div>
                    )}
                    {streamingText === null && !activeTool && isStreaming && (
                      <div className="flex justify-start">
                        <div className="rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 leading-relaxed text-kumo-inactive">
                          Thinking...
                          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-kumo-brand align-text-bottom" />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t border-kumo-line bg-kumo-base">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
                className="mx-auto max-w-3xl px-5 py-4"
              >
                <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
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
                      isStreaming
                        ? "Agent is responding..."
                        : "Describe what you want to build..."
                    }
                    disabled={!isConnected || isStreaming}
                    rows={2}
                    className="flex-1 bg-transparent! shadow-none! outline-none! ring-0! focus:ring-0!"
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !isConnected || isStreaming}
                    icon={<PaperPlaneRightIcon size={18} />}
                    loading={isStreaming}
                    className="mb-0.5"
                  />
                </div>
              </form>
              <div className="flex justify-center pb-3">
                <PoweredByAgents />
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center">
            <Empty
              icon={<BrainIcon size={40} weight="duotone" />}
              title="Think — Coding Agent"
              description="Create or select a thread to start a conversation."
            />
          </div>
        )}
      </div>

      {/* ── Right panel: file browser (when workspace attached) ─── */}
      {activeThreadId && attachedWorkspace && (
        <FileBrowser
          workspaceId={attachedWorkspace.id}
          workspaceName={attachedWorkspace.name}
          fileTree={fileTree}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          onListDir={handleListDir}
          onOpenFile={handleOpenFile}
        />
      )}

      {/* ── File viewer overlay ──────────────────────────────────── */}
      {selectedFilePath && (
        <FileViewer
          path={selectedFilePath}
          content={fileContent}
          loading={fileContentLoading}
          onClose={() => {
            setSelectedFilePath(null);
            setFileContent(null);
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
