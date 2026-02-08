import { useAgent } from "agents/react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// ── Types ──────────────────────────────────────────────────────────────

interface ThinkState {
  sessionId: string;
  status: "idle" | "thinking" | "executing";
  codeVersion: number;
  taskCount: number;
}

type ThinkPayload =
  | { type: "text_delta"; delta: string }
  | { type: "text_done" }
  | { type: "reasoning_delta"; delta: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; output: unknown }
  | { type: "chat"; message: { role: "assistant"; content: string } }
  | { type: "error"; error: string }
  | { type: "files_changed"; files: string[] };

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

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  toolCalls?: { name: string; input: unknown; output?: unknown }[];
}

// ── MIME type helper ───────────────────────────────────────────────────

function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
    py: "python",
    svg: "xml"
  };
  return map[ext] || "plaintext";
}

// ── Streamdown renderer ───────────────────────────────────────────────

function useStreamdown() {
  // oxlint-disable-next-line no-explicit-any -- Streamdown plugin type mismatch
  const ref = useRef(new Streamdown({ plugins: [code() as any] }));
  return ref.current;
}

function RenderedMarkdown({ content }: { content: string }) {
  const sd = useStreamdown();
  const html = sd.render(content);
  return (
    <div
      className="prose prose-sm prose-invert max-w-none [&_pre]:bg-zinc-900 [&_pre]:rounded [&_pre]:p-3 [&_code]:text-blue-300 [&_p]:my-1.5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── File Tree Component ───────────────────────────────────────────────

function FileTree({
  files,
  selectedFile,
  onSelect
}: {
  files: string[];
  selectedFile: string | null;
  onSelect: (f: string) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="p-3 text-xs text-zinc-500 italic">
        No files yet. Ask the agent to create something!
      </div>
    );
  }

  return (
    <div className="py-1">
      {files.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onSelect(f)}
          className={`w-full text-left px-3 py-1.5 text-sm font-mono truncate transition-colors ${
            f === selectedFile
              ? "bg-blue-600/20 text-blue-300 border-l-2 border-blue-500"
              : "text-zinc-300 hover:bg-zinc-800 border-l-2 border-transparent"
          }`}
        >
          <span className="mr-2 text-zinc-500">
            {f.endsWith(".html")
              ? "🌐"
              : f.endsWith(".css")
                ? "🎨"
                : f.endsWith(".js") || f.endsWith(".ts")
                  ? "📜"
                  : f.endsWith(".json")
                    ? "📋"
                    : "📄"}
          </span>
          {f}
        </button>
      ))}
    </div>
  );
}

// ── Code Viewer Component ─────────────────────────────────────────────

function CodeViewer({
  filename,
  content
}: {
  filename: string | null;
  content: string | null;
}) {
  if (!filename || content === null) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Select a file to view its contents
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center px-3 py-1.5 bg-zinc-800 border-b border-zinc-700 text-xs text-zinc-400 font-mono">
        <span className="text-zinc-300">{filename}</span>
        <span className="ml-2 text-zinc-600">{getLanguage(filename)}</span>
      </div>
      <pre className="flex-1 overflow-auto p-4 text-sm font-mono text-zinc-200 bg-zinc-900 leading-relaxed">
        <code>{content}</code>
      </pre>
    </div>
  );
}

// ── Preview Component ─────────────────────────────────────────────────

function Preview({
  files
}: {
  files: Record<string, string>;
  sessionId: string | null;
}) {
  const [previewKey, setPreviewKey] = useState(0);
  const hasHtml = Object.keys(files).some((f) => f.endsWith(".html"));

  if (!hasHtml) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        No HTML file to preview. Ask the agent to create an index.html!
      </div>
    );
  }

  // Build a self-contained HTML blob from the files
  const htmlFile =
    Object.keys(files).find((f) => f === "index.html") ||
    Object.keys(files).find((f) => f.endsWith(".html")) ||
    "";

  let html = files[htmlFile] || "";

  // Inline CSS files referenced by <link> tags
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith(".css")) {
      // Replace <link rel="stylesheet" href="..."> with inline <style>
      const linkPattern = new RegExp(
        `<link[^>]*href=["']${name.replace(".", "\\.")}["'][^>]*>`,
        "gi"
      );
      html = html.replace(linkPattern, `<style>${content}</style>`);

      // Also handle if the CSS is referenced but not yet linked
      if (!html.includes(content)) {
        html = html.replace("</head>", `<style>${content}</style></head>`);
      }
    }
  }

  // Inline JS files referenced by <script> tags
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith(".js") || name.endsWith(".ts")) {
      const scriptPattern = new RegExp(
        `<script[^>]*src=["']${name.replace(".", "\\.")}["'][^>]*>\\s*</script>`,
        "gi"
      );
      html = html.replace(scriptPattern, `<script>${content}</script>`);
    }
  }

  const blob = new Blob([html], { type: "text/html" });
  const blobUrl = URL.createObjectURL(blob);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800 border-b border-zinc-700">
        <span className="text-xs text-zinc-400 font-mono">Preview</span>
        <button
          type="button"
          onClick={() => setPreviewKey((k) => k + 1)}
          className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-zinc-700"
          title="Refresh preview"
        >
          ↻ Refresh
        </button>
      </div>
      <iframe
        key={previewKey}
        src={blobUrl}
        className="flex-1 bg-white"
        sandbox="allow-scripts"
        title="Live Preview"
      />
    </div>
  );
}

// ── Main Editor App ───────────────────────────────────────────────────

export default function EditorApp() {
  // Agent connection
  const agent = useAgent({
    agent: "think",
    name: "editor-session"
  });

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "thinking" | "executing">(
    "idle"
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  });

  // Fetch files from the server
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch("/agents/think/editor-session/files");
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || {});
        // Auto-select first file if none selected
        const fileNames = Object.keys(data.files || {});
        if (fileNames.length > 0 && !selectedFileRef.current) {
          setSelectedFile(fileNames[0]);
        }
      }
    } catch {
      // Server might not be ready yet
    }
  }, []);

  // Fetch files on mount and when status changes to idle (agent finished)
  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    if (status === "idle") {
      fetchFiles();
    }
  }, [status, fetchFiles]);

  // Handle WebSocket messages
  useEffect(() => {
    if (!agent) return;

    const handleMessage = (event: MessageEvent) => {
      let data: unknown;
      try {
        data =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      // Handle state updates from the Agents SDK
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        (data as { type: string }).type === "cf_agent_state_update"
      ) {
        const state = (data as unknown as { state: ThinkState }).state;
        if (state?.status) {
          setStatus(state.status);
        }
        return;
      }

      if (!isThinkMessage(data)) return;

      const msg = data.payload;

      switch (msg.type) {
        case "text_delta":
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.isStreaming) {
              updated[updated.length - 1] = {
                ...last,
                content: last.content + msg.delta
              };
            } else {
              updated.push({
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: msg.delta,
                isStreaming: true
              });
            }
            return updated;
          });
          break;

        case "text_done":
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.isStreaming) {
              updated[updated.length - 1] = { ...last, isStreaming: false };
            }
            return updated;
          });
          // Refresh files after each complete response
          fetchFiles();
          break;

        case "tool_call":
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              const toolCalls = [...(last.toolCalls || [])];
              toolCalls.push({ name: msg.name, input: msg.input });
              updated[updated.length - 1] = { ...last, toolCalls };
            }
            return updated;
          });
          break;

        case "tool_result":
          // Refresh files after tool results (file operations)
          if (["create_file", "edit_file", "write_file"].includes(msg.name)) {
            fetchFiles();
          }
          break;

        case "error":
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.isStreaming) {
              updated[updated.length - 1] = {
                ...last,
                content: last.content
                  ? `${last.content}\n\n**Error:** ${msg.error}`
                  : `**Error:** ${msg.error}`,
                isStreaming: false
              };
            } else {
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
    };

    agent.addEventListener("message", handleMessage);
    return () => agent.removeEventListener("message", handleMessage);
  }, [agent, fetchFiles]);

  // Send message
  const sendMessage = useCallback(() => {
    if (!input.trim() || !agent) return;

    const content = input.trim();
    setInput("");

    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content }
    ]);

    // Send to agent
    agent.send(JSON.stringify({ type: "chat", content }));
  }, [input, agent]);

  // Handle Enter key
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const fileNames = Object.keys(files).sort();
  const selectedContent =
    selectedFile && files[selectedFile] !== undefined
      ? files[selectedFile]
      : null;

  return (
    <div className="flex h-[calc(100vh-2.25rem)] bg-zinc-950 text-zinc-100">
      {/* ── Left: Chat Panel ────────────────────────────────────── */}
      <div className="w-[380px] flex flex-col border-r border-zinc-800 bg-zinc-950">
        {/* Chat header */}
        <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
          <h2 className="text-sm font-semibold text-zinc-300">Vibe Coder</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Describe what you want to build
          </p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 && (
            <div className="p-4 text-center">
              <div className="text-zinc-600 text-sm mt-8">
                Tell me what to build!
              </div>
              <div className="text-zinc-700 text-xs mt-2">
                e.g. "Make a todo app" or "Create a calculator"
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`px-4 py-3 ${
                msg.role === "user"
                  ? "bg-zinc-900/30"
                  : "border-b border-zinc-800/50"
              }`}
            >
              <div className="text-[10px] font-medium uppercase tracking-wider mb-1.5 text-zinc-500">
                {msg.role === "user" ? "You" : "Agent"}
              </div>
              {msg.role === "user" ? (
                <div className="text-sm text-zinc-200">{msg.content}</div>
              ) : (
                <div className="text-sm">
                  <RenderedMarkdown content={msg.content} />
                </div>
              )}
              {/* Tool call indicators */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.toolCalls.map((tc, i) => (
                    <div
                      key={`${msg.id}-tool-${i}`}
                      className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500"
                    >
                      <span className="text-green-500">→</span>
                      <span>{tc.name}</span>
                      {tc.name === "create_file" || tc.name === "edit_file" ? (
                        <span className="text-zinc-600">
                          {(tc.input as { filename?: string })?.filename}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {msg.isStreaming && (
                <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Status indicator */}
        {status !== "idle" && (
          <div className="px-4 py-1.5 bg-blue-600/10 border-t border-blue-600/20">
            <span className="text-[11px] text-blue-400 flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              {status === "thinking" ? "Thinking..." : "Executing..."}
            </span>
          </div>
        )}

        {/* Input */}
        <div className="p-3 border-t border-zinc-800 bg-zinc-900/50">
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what to build..."
              rows={2}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/50"
            />
            <button
              type="button"
              onClick={sendMessage}
              disabled={!input.trim() || status !== "idle"}
              className="self-end px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500 transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ── Middle: File Tree + Code Viewer ─────────────────────── */}
      <div className="flex-1 flex flex-col border-r border-zinc-800">
        <div className="flex h-full">
          {/* File tree sidebar */}
          <div className="w-48 border-r border-zinc-800 bg-zinc-900/30 overflow-y-auto">
            <div className="px-3 py-2 border-b border-zinc-800 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Files
            </div>
            <FileTree
              files={fileNames}
              selectedFile={selectedFile}
              onSelect={setSelectedFile}
            />
          </div>

          {/* Code viewer */}
          <div className="flex-1 bg-zinc-900 overflow-hidden">
            <CodeViewer filename={selectedFile} content={selectedContent} />
          </div>
        </div>
      </div>

      {/* ── Right: Live Preview ─────────────────────────────────── */}
      <div className="w-[420px] bg-zinc-900 flex flex-col">
        <Preview files={files} sessionId={agent ? "editor-session" : null} />
      </div>
    </div>
  );
}
