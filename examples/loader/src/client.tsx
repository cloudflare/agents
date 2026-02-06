import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import "./styles.css";

// Theme management
type Theme = "dark" | "light";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("think-theme");
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

// Agent state from Think DO
interface ThinkState {
  sessionId: string;
  status: "idle" | "thinking" | "executing";
  codeVersion: number;
  taskCount: number;
}

// Think message payload types
type ThinkPayload =
  | { type: "text_delta"; delta: string }
  | { type: "text_done" }
  | { type: "reasoning_delta"; delta: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; output: unknown }
  | { type: "chat"; message: { role: "assistant"; content: string } }
  | { type: "error"; error: string };

interface ThinkMessage {
  __think__: 1;
  payload: ThinkPayload;
}

function isThinkMessage(data: unknown): data is ThinkMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "__think__" in data &&
    (data as { __think__: unknown }).__think__ === 1
  );
}

// Debug event types for internal observability
type ThinkDebugEvent =
  | { event: "subagent:spawn"; id: string; task: string }
  | {
      event: "subagent:complete";
      id: string;
      success: boolean;
      summary?: string;
    }
  | { event: "subagent:error"; id: string; error: string }
  | { event: "task:created"; id: string; type: string; title: string }
  | { event: "task:started"; id: string }
  | { event: "task:completed"; id: string; result?: string }
  | { event: "tool:start"; name: string; callId: string }
  | {
      event: "tool:end";
      name: string;
      callId: string;
      durationMs: number;
      success: boolean;
    }
  | { event: "state:change"; status: string }
  | { event: "connected"; sessionId: string }
  | { event: "message:received"; content: string };

interface ThinkDebugMessage {
  __think_debug__: 1;
  timestamp: number;
  payload: ThinkDebugEvent;
}

function isDebugMessage(data: unknown): data is ThinkDebugMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "__think_debug__" in data &&
    (data as { __think_debug__: unknown }).__think_debug__ === 1
  );
}

interface DebugEntry {
  timestamp: number;
  event: ThinkDebugEvent;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
  isStreaming?: boolean;
}

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
}

// Check if debug mode is enabled via URL param
function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("debug") === "1";
}

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const dark = theme === "dark";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "thinking" | "executing">(
    "idle"
  );
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(
    new Set()
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [debugEnabled] = useState(isDebugEnabled);
  const [debugEvents, setDebugEvents] = useState<DebugEntry[]>([]);
  const [debugPanelOpen, setDebugPanelOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const debugEndRef = useRef<HTMLDivElement>(null);
  const streamingMessageRef = useRef<string>("");
  const streamingReasoningRef = useRef<string>("");
  const currentToolCallsRef = useRef<ToolCall[]>([]);
  const handleMessageRef = useRef<(msg: ThinkPayload) => void>(() => {});
  const handleDebugRef = useRef<(msg: ThinkDebugMessage) => void>(() => {});
  const historyLoadedRef = useRef(false);
  const lastUserMessageRef = useRef<string>("");

  // Persist theme
  useEffect(() => {
    localStorage.setItem("think-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  // Load chat history
  const loadHistory = useCallback(async () => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    try {
      const res = await fetch("/agents/think/dev-session/chat/history");
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages?: Array<{ role: string; content: string }>;
      };
      if (data.messages && data.messages.length > 0) {
        setMessages(
          data.messages.map((msg, idx) => ({
            id: `history-${idx}`,
            role: msg.role as "user" | "assistant",
            content: msg.content
          }))
        );
      }
    } catch (e) {
      console.error("Failed to load history:", e);
    }
  }, []);

  // WebSocket connection - pass debug=1 if debug mode enabled
  const agent = useAgent<ThinkState>({
    agent: "Think",
    name: "dev-session",
    // Pass debug query param to enable debug events
    ...(debugEnabled ? { query: { debug: "1" } } : {}),
    onStateUpdate: (state) => setStatus(state.status),
    onMessage: (event) => {
      try {
        const data = JSON.parse(event.data) as unknown;
        console.log("[DEBUG CLIENT] Raw message:", data);
        if (isThinkMessage(data)) {
          handleMessageRef.current(data.payload);
        } else if (isDebugMessage(data)) {
          console.log("[DEBUG CLIENT] Detected debug message!");
          handleDebugRef.current(data);
        }
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    },
    onOpen: (event) => {
      console.log("[DEBUG CLIENT] Connected to Think agent");
      console.log("[DEBUG CLIENT] debugEnabled:", debugEnabled);
      // @ts-expect-error - accessing target.url for debug
      console.log("[DEBUG CLIENT] WebSocket URL:", event?.target?.url);
      loadHistory();
    },
    onClose: () => console.log("Disconnected"),
    onError: (error) => console.error("WebSocket error:", error)
  });

  // Start new assistant message on status change
  const prevStatusRef = useRef<string>("idle");
  useEffect(() => {
    if (status === "thinking" && prevStatusRef.current === "idle") {
      streamingMessageRef.current = "";
      streamingReasoningRef.current = "";
      currentToolCallsRef.current = [];
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: "",
          toolCalls: [],
          isStreaming: true
        }
      ]);
    }
    prevStatusRef.current = status;
  }, [status]);

  const handleMessage = useCallback((msg: ThinkPayload) => {
    switch (msg.type) {
      case "text_delta":
        streamingMessageRef.current += msg.delta;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.length - 1;
          if (last >= 0 && updated[last].isStreaming) {
            updated[last] = {
              ...updated[last],
              content: streamingMessageRef.current
            };
          }
          return updated;
        });
        break;
      case "text_done":
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.length - 1;
          if (last >= 0 && updated[last].isStreaming) {
            updated[last] = { ...updated[last], isStreaming: false };
          }
          return updated;
        });
        break;
      case "tool_call": {
        currentToolCallsRef.current.push({
          id: msg.id,
          name: msg.name,
          input: msg.input
        });
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.length - 1;
          if (last >= 0 && updated[last].role === "assistant") {
            updated[last] = {
              ...updated[last],
              toolCalls: [...currentToolCallsRef.current]
            };
          }
          return updated;
        });
        break;
      }
      case "tool_result": {
        const idx = currentToolCallsRef.current.findIndex(
          (t) => t.id === msg.callId
        );
        if (idx !== -1) {
          currentToolCallsRef.current[idx].output = msg.output;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated.length - 1;
            if (last >= 0 && updated[last].role === "assistant") {
              updated[last] = {
                ...updated[last],
                toolCalls: [...currentToolCallsRef.current]
              };
            }
            return updated;
          });
        }
        break;
      }
      case "reasoning_delta":
        // Stream reasoning as it arrives
        streamingReasoningRef.current += msg.delta;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.length - 1;
          if (last >= 0 && updated[last].role === "assistant") {
            updated[last] = {
              ...updated[last],
              reasoning: streamingReasoningRef.current
            };
          }
          return updated;
        });
        break;
      case "reasoning":
        // Final reasoning (fallback for models that don't stream)
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.length - 1;
          if (last >= 0 && updated[last].role === "assistant") {
            updated[last] = { ...updated[last], reasoning: msg.content };
          }
          return updated;
        });
        break;
      case "error":
        console.error("Agent error:", msg.error);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.length - 1;
          // If there's a streaming message, update it with the error
          if (
            last >= 0 &&
            updated[last].role === "assistant" &&
            updated[last].isStreaming
          ) {
            updated[last] = {
              ...updated[last],
              content: updated[last].content
                ? `${updated[last].content}\n\n**Error:** ${msg.error}`
                : `**Error:** ${msg.error}`,
              isStreaming: false
            };
          } else {
            // No assistant message exists yet - create one with the error
            updated.push({
              id: `error-${Date.now()}`,
              role: "assistant",
              content: `**Error:** ${msg.error}`,
              isStreaming: false
            });
          }
          return updated;
        });
        break;
    }
  }, []);

  handleMessageRef.current = handleMessage;

  // Handle debug messages
  const handleDebug = useCallback((msg: ThinkDebugMessage) => {
    console.log("[DEBUG CLIENT] Received debug message:", msg);
    setDebugEvents((prev) => {
      // Keep last 100 events
      const next = [...prev, { timestamp: msg.timestamp, event: msg.payload }];
      return next.slice(-100);
    });
  }, []);

  handleDebugRef.current = handleDebug;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-scroll debug panel
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on debug event change
  useEffect(() => {
    debugEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [debugEvents]);

  const sendMessage = useCallback(() => {
    if (!input.trim() || status !== "idle") return;
    const content = input.trim();
    lastUserMessageRef.current = content;
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content }
    ]);
    agent.send(JSON.stringify({ type: "chat", content }));
    setInput("");
  }, [input, status, agent]);

  // Stop the current generation
  const stopGeneration = useCallback(() => {
    if (status === "idle") return;
    agent.send(JSON.stringify({ type: "cancel" }));
  }, [status, agent]);

  // Retry the last user message
  const retryLastMessage = useCallback(() => {
    if (status !== "idle" || !lastUserMessageRef.current) return;
    // Remove the last assistant message if it exists
    setMessages((prev) => {
      const lastIdx = prev.length - 1;
      if (lastIdx >= 0 && prev[lastIdx].role === "assistant") {
        return prev.slice(0, lastIdx);
      }
      return prev;
    });
    // Resend the message
    agent.send(
      JSON.stringify({ type: "chat", content: lastUserMessageRef.current })
    );
  }, [status, agent]);

  // Start editing a message
  const startEditing = useCallback(
    (msg: ChatMessage) => {
      if (status !== "idle") return;
      setEditingMessageId(msg.id);
      setEditingContent(msg.content);
    },
    [status]
  );

  // Cancel editing
  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
    setEditingContent("");
  }, []);

  // Save edited message and restart conversation from that point
  const saveEditedMessage = useCallback(
    async (messageId: string) => {
      if (status !== "idle" || !editingContent.trim()) return;

      // Find the index of the message being edited
      const messageIndex = messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) return;

      // Count how many user messages come before this one (to tell server where to truncate)
      let userMessageCount = 0;
      for (let i = 0; i < messageIndex; i++) {
        if (messages[i].role === "user") userMessageCount++;
      }

      // Truncate server-side history (keep messages before this user message)
      try {
        await fetch("/agents/think/dev-session/chat/truncate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keepUserMessages: userMessageCount })
        });
      } catch (e) {
        console.error("Failed to truncate history:", e);
      }

      // Update local messages - remove everything from this message onwards
      const newContent = editingContent.trim();
      setMessages((prev) => prev.slice(0, messageIndex));

      // Clear editing state
      setEditingMessageId(null);
      setEditingContent("");

      // Send the edited message as a new message
      lastUserMessageRef.current = newContent;
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: newContent }
      ]);
      agent.send(JSON.stringify({ type: "chat", content: newContent }));
    },
    [status, editingContent, messages, agent]
  );

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleReasoning = (id: string) => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const clearMessages = useCallback(async () => {
    try {
      const res = await fetch("/agents/think/dev-session/chat/clear", {
        method: "POST"
      });
      if (res.ok) {
        setMessages([]);
        setExpandedTools(new Set());
        setExpandedReasoning(new Set());
      }
    } catch (e) {
      console.error("Failed to clear:", e);
    }
  }, []);

  // Status badge styles
  const statusStyle =
    status === "idle"
      ? "bg-green-600 text-white"
      : status === "thinking"
        ? "bg-blue-600 text-white animate-pulse"
        : "bg-amber-600 text-white animate-pulse";

  // Format timestamp for debug events
  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return (
      d.toLocaleTimeString("en-US", { hour12: false }) +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  };

  // Get color for debug event type
  const getEventColor = (event: ThinkDebugEvent) => {
    switch (event.event) {
      case "state:change":
        return dark ? "text-purple-400" : "text-purple-600";
      case "tool:start":
      case "tool:end":
        return dark ? "text-cyan-400" : "text-cyan-600";
      case "message:received":
        return dark ? "text-blue-400" : "text-blue-600";
      case "subagent:spawn":
      case "subagent:complete":
      case "subagent:error":
        return dark ? "text-orange-400" : "text-orange-600";
      case "task:created":
      case "task:started":
      case "task:completed":
        return dark ? "text-green-400" : "text-green-600";
      case "connected":
        return dark ? "text-emerald-400" : "text-emerald-600";
      default:
        return dark ? "text-zinc-400" : "text-zinc-500";
    }
  };

  // Format debug event for display
  const formatDebugEvent = (event: ThinkDebugEvent): string => {
    switch (event.event) {
      case "connected":
        return `Connected (session: ${event.sessionId.slice(0, 8)}...)`;
      case "state:change":
        return `State → ${event.status}`;
      case "message:received":
        return `Message: "${event.content.slice(0, 40)}${event.content.length > 40 ? "..." : ""}"`;
      case "tool:start":
        return `Tool start: ${event.name}`;
      case "tool:end":
        return `Tool end: ${event.name} (${event.durationMs}ms, ${event.success ? "✓" : "✗"})`;
      case "subagent:spawn":
        return `Subagent spawn: ${event.id} - ${event.task.slice(0, 30)}...`;
      case "subagent:complete":
        return `Subagent complete: ${event.id} (${event.success ? "✓" : "✗"})`;
      case "subagent:error":
        return `Subagent error: ${event.id} - ${event.error}`;
      case "task:created":
        return `Task created: ${event.type} - ${event.title}`;
      case "task:started":
        return `Task started: ${event.id}`;
      case "task:completed":
        return `Task completed: ${event.id}`;
      default:
        return JSON.stringify(event);
    }
  };

  return (
    <div
      className={`flex h-screen ${dark ? "bg-zinc-900 text-zinc-100" : "bg-white text-zinc-900"}`}
    >
      {/* Main chat area */}
      <div
        className={`flex flex-col flex-1 ${debugEnabled && debugPanelOpen ? "max-w-[calc(100%-320px)]" : ""}`}
      >
        {/* Header */}
        <header
          className={`flex items-center justify-between px-6 py-4 border-b ${
            dark ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-zinc-50"
          }`}
        >
          <h1 className="text-xl font-semibold">Think</h1>
          <div className="flex items-center gap-3">
            {/* Theme toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              className={`p-2 rounded-lg ${dark ? "text-zinc-400 hover:bg-zinc-700" : "text-zinc-500 hover:bg-zinc-200"}`}
              title={`Switch to ${dark ? "light" : "dark"} mode`}
            >
              {dark ? (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                  />
                </svg>
              )}
            </button>
            {/* Clear button */}
            <button
              type="button"
              onClick={clearMessages}
              disabled={messages.length === 0 || status !== "idle"}
              className={`px-3 py-1.5 text-xs border rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${
                dark
                  ? "border-zinc-600 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 hover:bg-zinc-700"
                  : "border-zinc-300 text-zinc-600 hover:text-zinc-900 hover:border-zinc-400 hover:bg-zinc-100"
              }`}
            >
              Clear
            </button>
            {/* Status badge */}
            <span
              data-testid="status-badge"
              data-status={status}
              className={`px-3 py-1 text-xs font-medium rounded-full uppercase tracking-wide ${statusStyle}`}
            >
              {status}
            </span>
          </div>
        </header>

        {/* Messages */}
        <main className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 && (
            <div
              className={`flex flex-col items-center justify-center h-full text-center ${dark ? "text-zinc-400" : "text-zinc-500"}`}
            >
              <p>Start a conversation with Think.</p>
              <p
                className={`text-sm italic mt-2 ${dark ? "text-zinc-500" : "text-zinc-400"}`}
              >
                Try: "Create a hello world function and test it"
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              data-testid={`message-${msg.role}`}
              data-message-id={msg.id}
              className={`rounded-xl p-4 max-w-[85%] ${
                msg.role === "user"
                  ? "bg-blue-600 text-white ml-auto"
                  : dark
                    ? "bg-zinc-800 border border-zinc-700"
                    : "bg-zinc-100 border border-zinc-200"
              }`}
            >
              <div
                className={`text-[11px] uppercase font-semibold tracking-wide mb-1 ${
                  msg.role === "user"
                    ? "opacity-70"
                    : dark
                      ? "text-zinc-400"
                      : "text-zinc-500"
                }`}
              >
                {msg.role}
              </div>

              {/* Reasoning - auto-expand while streaming */}
              {msg.reasoning &&
                (() => {
                  const isExpanded =
                    msg.isStreaming || expandedReasoning.has(msg.id);
                  return (
                    <div
                      className={`mb-3 rounded-lg overflow-hidden border ${dark ? "bg-zinc-900 border-zinc-700" : "bg-white border-zinc-200"}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleReasoning(msg.id)}
                        className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm ${dark ? "hover:bg-zinc-800" : "hover:bg-zinc-50"}`}
                      >
                        <span>💭</span>
                        <span
                          className={
                            dark
                              ? "text-purple-400 font-medium"
                              : "text-purple-600 font-medium"
                          }
                        >
                          Reasoning
                        </span>
                        {msg.isStreaming && (
                          <span className="text-xs text-purple-400 animate-pulse">
                            thinking...
                          </span>
                        )}
                        <span
                          className={`ml-auto text-xs ${dark ? "text-zinc-500" : "text-zinc-400"}`}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </span>
                      </button>
                      {isExpanded && (
                        <div
                          className={`px-3 py-2 border-t text-sm whitespace-pre-wrap ${dark ? "border-zinc-700 text-zinc-400" : "border-zinc-200 text-zinc-600"}`}
                        >
                          {msg.reasoning}
                          {msg.isStreaming && (
                            <span className="text-purple-400 animate-pulse">
                              ▊
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

              {/* Content - with edit support for user messages */}
              {msg.role === "user" && editingMessageId === msg.id ? (
                // Edit mode for user messages
                <div className="space-y-2">
                  <textarea
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-blue-700 text-white placeholder-blue-300 border border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                    rows={3}
                    ref={(el) => el?.focus()}
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={cancelEditing}
                      className="px-3 py-1 text-sm rounded bg-blue-700 hover:bg-blue-800 text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => saveEditedMessage(msg.id)}
                      disabled={!editingContent.trim()}
                      className="px-3 py-1 text-sm rounded bg-white text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                    >
                      Save & Resend
                    </button>
                  </div>
                </div>
              ) : (
                // Normal display mode
                <div className="group relative">
                  <div
                    className={`prose prose-sm max-w-none ${msg.role === "user" ? "prose-invert" : dark ? "prose-invert" : ""}`}
                  >
                    {msg.content ? (
                      <Streamdown
                        plugins={{ code }}
                        isAnimating={msg.isStreaming}
                      >
                        {msg.content}
                      </Streamdown>
                    ) : msg.isStreaming ? (
                      <span className="text-blue-400 animate-pulse">▊</span>
                    ) : null}
                  </div>
                  {/* Edit button for user messages */}
                  {msg.role === "user" &&
                    status === "idle" &&
                    !msg.isStreaming && (
                      <button
                        type="button"
                        onClick={() => startEditing(msg)}
                        className="absolute -right-2 -top-2 p-1.5 rounded-full bg-blue-700 hover:bg-blue-800 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Edit message"
                      >
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                          />
                        </svg>
                      </button>
                    )}
                </div>
              )}

              {/* Tool calls */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-3 space-y-2">
                  {msg.toolCalls.map((tool) => (
                    <div
                      key={tool.id}
                      className={`rounded-lg overflow-hidden border ${dark ? "bg-zinc-900 border-zinc-700" : "bg-white border-zinc-200"}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleTool(tool.id)}
                        className={`flex items-center gap-2 w-full px-3 py-2 text-left font-mono text-sm ${dark ? "hover:bg-zinc-800" : "hover:bg-zinc-50"}`}
                      >
                        <span
                          className={`text-xs ${dark ? "text-zinc-500" : "text-zinc-400"}`}
                        >
                          {expandedTools.has(tool.id) ? "▼" : "▶"}
                        </span>
                        <span
                          className={dark ? "text-cyan-400" : "text-cyan-600"}
                        >
                          {tool.name}
                        </span>
                        {tool.output !== undefined && (
                          <span
                            className={`ml-auto ${dark ? "text-green-500" : "text-green-600"}`}
                          >
                            ✓
                          </span>
                        )}
                      </button>
                      {expandedTools.has(tool.id) && (
                        <div
                          className={`border-t p-3 space-y-3 ${dark ? "border-zinc-700" : "border-zinc-200"}`}
                        >
                          <div>
                            <div
                              className={`text-[10px] uppercase font-semibold mb-1 ${dark ? "text-zinc-400" : "text-zinc-500"}`}
                            >
                              Input
                            </div>
                            <pre
                              className={`rounded p-3 text-xs overflow-x-auto ${dark ? "bg-zinc-950 border-zinc-800 text-zinc-300" : "bg-zinc-50 border-zinc-200 text-zinc-700"} border`}
                            >
                              {JSON.stringify(tool.input, null, 2)}
                            </pre>
                          </div>
                          {tool.output !== undefined && (
                            <div>
                              <div
                                className={`text-[10px] uppercase font-semibold mb-1 ${dark ? "text-zinc-400" : "text-zinc-500"}`}
                              >
                                Output
                              </div>
                              <pre
                                className={`rounded p-3 text-xs overflow-x-auto max-h-72 overflow-y-auto ${dark ? "bg-zinc-950 border-zinc-800 text-zinc-300" : "bg-zinc-50 border-zinc-200 text-zinc-700"} border`}
                              >
                                {typeof tool.output === "string"
                                  ? tool.output
                                  : JSON.stringify(tool.output, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </main>

        {/* Input */}
        <footer
          className={`flex gap-3 px-6 py-4 border-t ${dark ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-zinc-50"}`}
        >
          <input
            type="text"
            data-testid="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={
              status === "idle"
                ? "Type a message..."
                : "Waiting for Think to respond..."
            }
            disabled={status !== "idle"}
            className={`flex-1 px-4 py-3 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-60 disabled:cursor-not-allowed ${
              dark
                ? "bg-zinc-900 border-zinc-700 text-zinc-100 placeholder-zinc-500"
                : "bg-white border-zinc-300 text-zinc-900 placeholder-zinc-400"
            }`}
          />
          {/* Retry button - show when idle and there's a last message */}
          {status === "idle" &&
            lastUserMessageRef.current &&
            messages.length > 0 && (
              <button
                type="button"
                data-testid="retry-button"
                onClick={retryLastMessage}
                className={`px-4 py-3 font-medium rounded-lg ${
                  dark
                    ? "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
                    : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
                }`}
                title="Retry last message"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
            )}
          {/* Stop button - show when thinking/executing */}
          {status !== "idle" ? (
            <button
              type="button"
              data-testid="stop-button"
              onClick={stopGeneration}
              className="px-6 py-3 font-medium rounded-lg bg-red-600 text-white hover:bg-red-500"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              data-testid="send-button"
              onClick={sendMessage}
              disabled={!input.trim()}
              className={`px-6 py-3 font-medium rounded-lg disabled:cursor-not-allowed ${
                input.trim()
                  ? "bg-blue-600 text-white hover:bg-blue-500"
                  : dark
                    ? "bg-zinc-700 text-zinc-500"
                    : "bg-zinc-300 text-zinc-500"
              }`}
            >
              Send
            </button>
          )}
        </footer>
      </div>

      {/* Debug Panel - only shown when debug=1 in URL */}
      {debugEnabled && (
        <div
          className={`flex flex-col border-l ${
            dark ? "border-zinc-700 bg-zinc-950" : "border-zinc-200 bg-zinc-50"
          } ${debugPanelOpen ? "w-80" : "w-10"}`}
        >
          {/* Debug panel header */}
          <div
            className={`flex items-center justify-between px-3 py-2 border-b ${
              dark ? "border-zinc-700 bg-zinc-900" : "border-zinc-200 bg-white"
            }`}
          >
            {debugPanelOpen && (
              <span
                className={`text-xs font-semibold uppercase tracking-wide ${dark ? "text-zinc-400" : "text-zinc-500"}`}
              >
                Debug Events
              </span>
            )}
            <button
              type="button"
              onClick={() => setDebugPanelOpen((p) => !p)}
              className={`p-1 rounded ${dark ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"}`}
              title={
                debugPanelOpen ? "Collapse debug panel" : "Expand debug panel"
              }
            >
              {debugPanelOpen ? "»" : "«"}
            </button>
          </div>

          {/* Debug events list */}
          {debugPanelOpen && (
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {debugEvents.length === 0 && (
                <div
                  className={`text-xs italic p-2 ${dark ? "text-zinc-500" : "text-zinc-400"}`}
                >
                  No events yet. Send a message to see debug events.
                </div>
              )}
              {debugEvents.map((entry, idx) => (
                <div
                  key={`${entry.timestamp}-${idx}`}
                  className={`text-xs font-mono px-2 py-1 rounded ${
                    dark
                      ? "bg-zinc-900 border border-zinc-800"
                      : "bg-white border border-zinc-200"
                  }`}
                >
                  <span className={dark ? "text-zinc-500" : "text-zinc-400"}>
                    {formatTime(entry.timestamp)}
                  </span>{" "}
                  <span className={getEventColor(entry.event)}>
                    {formatDebugEvent(entry.event)}
                  </span>
                </div>
              ))}
              <div ref={debugEndRef} />
            </div>
          )}

          {/* Clear button */}
          {debugPanelOpen && debugEvents.length > 0 && (
            <div
              className={`px-2 py-2 border-t ${dark ? "border-zinc-700" : "border-zinc-200"}`}
            >
              <button
                type="button"
                onClick={() => setDebugEvents([])}
                className={`w-full px-2 py-1 text-xs rounded ${
                  dark
                    ? "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                    : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300"
                }`}
              >
                Clear Events
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
