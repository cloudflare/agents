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
  BookOpenIcon,
  CaretRightIcon,
  CheckCircleIcon,
  FloppyDiskIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  StopCircleIcon,
  SunIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Skill, SkillsAgent } from "./server";

type ToolPart = Extract<UIMessage["parts"][number], { type: string }> & {
  toolCallId: string;
  toolName: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
};

function isToolPart(part: UIMessage["parts"][number]): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const done = part.state === "output-available";
  const label = [part.input?.action, part.input?.label, part.input?.key]
    .filter(Boolean)
    .join(" ");

  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setOpen(!open)}
      >
        <CaretRightIcon
          size={12}
          className={`text-kumo-secondary transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Text size="xs" bold>
          {part.toolName}
        </Text>
        {label && (
          <span className="font-mono text-xs text-kumo-secondary truncate">
            {label}
          </span>
        )}
        {done && (
          <CheckCircleIcon
            size={14}
            className="text-green-500 ml-auto shrink-0"
          />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-2 pt-2">
          {part.input && (
            <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          )}
          {part.output != null && (
            <pre className="font-mono text-xs text-green-600 dark:text-green-400 bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Surface>
  );
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </div>
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

// ── Skills Sidebar ──────────────────────────────────────────────────

function SkillsSidebar({
  agent,
  isConnected
}: {
  agent: ReturnType<typeof useAgent<SkillsAgent>>;
  isConnected: boolean;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<{
    key: string;
    content: string;
    description: string;
    isNew: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const refreshSkills = useCallback(async () => {
    if (!isConnected) return;
    try {
      const list = await agent.call<Skill[]>("listSkills");
      setSkills(list);
    } catch (err) {
      console.error("Failed to list skills:", err);
    }
  }, [agent, isConnected]);

  useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);

  const handleNew = () => {
    setEditing({ key: "", content: "", description: "", isNew: true });
  };

  const handleEdit = async (skill: Skill) => {
    try {
      const content = await agent.call<string | null>("getSkill", [skill.key]);
      setEditing({
        key: skill.key,
        content: content ?? "",
        description: skill.description ?? "",
        isNew: false
      });
    } catch (err) {
      console.error("Failed to load skill:", err);
    }
  };

  const handleSave = async () => {
    if (!editing || !editing.key.trim() || !editing.content.trim()) return;
    setSaving(true);
    try {
      await agent.call("saveSkill", [
        editing.key.trim(),
        editing.content,
        editing.description || undefined
      ]);
      setEditing(null);
      await refreshSkills();
    } catch (err) {
      console.error("Failed to save skill:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (key: string) => {
    try {
      await agent.call("deleteSkill", [key]);
      if (editing?.key === key) setEditing(null);
      await refreshSkills();
    } catch (err) {
      console.error("Failed to delete skill:", err);
    }
  };

  return (
    <div className="w-80 border-l border-kumo-line bg-kumo-elevated flex flex-col">
      <header className="px-5 py-4 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-kumo-default">Skills</h1>
          <Badge variant="secondary">{skills.length}</Badge>
        </div>
        <Button
          variant="secondary"
          icon={<PlusIcon size={16} />}
          onClick={handleNew}
          disabled={!isConnected}
        >
          New
        </Button>
      </header>

      {editing ? (
        <div className="flex-1 flex flex-col p-4 gap-3 overflow-y-auto">
          <div className="flex items-center justify-between">
            <Text size="sm" bold>
              {editing.isNew ? "New Skill" : `Edit: ${editing.key}`}
            </Text>
            <Button
              variant="ghost"
              shape="square"
              aria-label="Close editor"
              icon={<XIcon size={16} />}
              onClick={() => setEditing(null)}
            />
          </div>

          {editing.isNew && (
            <InputArea
              value={editing.key}
              onValueChange={(v) => setEditing({ ...editing, key: v })}
              placeholder="skill-name"
              rows={1}
            />
          )}

          <div>
            <div className="mb-1">
              <Text size="xs" variant="secondary">
                Description
              </Text>
            </div>
            <InputArea
              value={editing.description}
              onValueChange={(v) => setEditing({ ...editing, description: v })}
              placeholder="Short description..."
              rows={1}
            />
          </div>

          <div className="flex-1 flex flex-col">
            <div className="mb-1">
              <Text size="xs" variant="secondary">
                Content
              </Text>
            </div>
            <InputArea
              value={editing.content}
              onValueChange={(v) => setEditing({ ...editing, content: v })}
              placeholder="Write the skill instructions here..."
              rows={12}
              className="flex-1 font-mono"
            />
          </div>

          <Button
            variant="primary"
            icon={<FloppyDiskIcon size={16} />}
            onClick={handleSave}
            disabled={saving || !editing.key.trim() || !editing.content.trim()}
            loading={saving}
          >
            Save Skill
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {skills.length === 0 && (
            <Empty
              icon={<BookOpenIcon size={32} />}
              title="No skills yet"
              description="Create a skill and the model can load it on demand."
            />
          )}
          {skills.map((skill) => (
            <Surface
              key={skill.key}
              className="rounded-lg ring ring-kumo-line p-3 hover:bg-kumo-elevated transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <Text size="sm" bold>
                      {skill.key}
                    </Text>
                  </div>
                  {skill.description && (
                    <div className="mt-1">
                      <Badge variant="secondary">{skill.description}</Badge>
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Edit skill"
                    icon={<PencilSimpleIcon size={14} />}
                    onClick={() => handleEdit(skill)}
                  />
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Delete skill"
                    icon={<TrashIcon size={14} />}
                    onClick={() => handleDelete(skill.key)}
                  />
                </div>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Chat ───────────────────────────────────────────────────────

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasFetched = useRef(false);
  const abortRef = useRef<(() => void) | null>(null);

  const agent = useAgent<SkillsAgent>({
    agent: "SkillsAgent",
    name: "default",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => {
      setConnectionStatus("disconnected");
      hasFetched.current = false;
    }, [])
  });

  const isConnected = connectionStatus === "connected";

  if (isConnected && !hasFetched.current) {
    hasFetched.current = true;
    agent
      .call<UIMessage[]>("getMessages")
      .then(setMessages)
      .catch(console.error);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    setIsLoading(true);
    const userMsg: UIMessage = {
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    setMessages((prev) => [...prev, userMsg]);

    const streamId = `streaming-${crypto.randomUUID()}`;
    let stopped = false;
    abortRef.current = () => {
      stopped = true;
    };

    try {
      await agent.call("chat", [text, userMsg.id], {
        onChunk: (chunk: unknown) => {
          if (stopped) return;
          const c = chunk as { type?: string; text?: string };
          if (c.type === "text-delta" && c.text) {
            setMessages((prev) => {
              const existing = prev.find((m) => m.id === streamId);
              if (existing) {
                const oldText =
                  existing.parts[0]?.type === "text"
                    ? existing.parts[0].text
                    : "";
                return prev.map((m) =>
                  m.id === streamId
                    ? {
                        ...m,
                        parts: [
                          { type: "text" as const, text: oldText + c.text }
                        ]
                      }
                    : m
                );
              }
              return [
                ...prev,
                {
                  id: streamId,
                  role: "assistant" as const,
                  parts: [{ type: "text" as const, text: c.text! }]
                }
              ];
            });
          }
        },
        onDone: (final: unknown) => {
          if (stopped) return;
          const f = final as { message?: UIMessage };
          if (f.message) {
            setMessages((prev) =>
              prev.map((m) => (m.id === streamId ? f.message! : m))
            );
          }
        },
        onError: (err: string) => {
          console.error("Stream error:", err);
        }
      });
    } catch (err) {
      if (!stopped) console.error("Failed to send:", err);
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  }, [input, isLoading, agent]);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-kumo-default">
                Session Skills
              </h1>
              <Badge variant="secondary">{messages.length} msgs</Badge>
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={async () => {
                  try {
                    await agent.call("clearMessages");
                    setMessages([]);
                  } catch (err) {
                    console.error("Clear failed:", err);
                  }
                }}
                disabled={messages.length === 0}
              >
                Clear
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && !isLoading && (
              <Empty
                icon={<BookOpenIcon size={32} />}
                title="Skills-powered chat"
                description="Create skills in the sidebar, then ask the agent to use them. It will load skills on demand via the get_catalog tool."
              />
            )}

            {messages.map((message) => {
              if (message.role === "user") {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse text-sm leading-relaxed">
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
                  {message.parts.map((part, i) => {
                    if (part.type === "text" && part.text?.trim()) {
                      return (
                        <div key={i} className="flex justify-start">
                          <Surface className="max-w-[80%] rounded-2xl rounded-bl-md ring ring-kumo-line">
                            <div className="px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                              {part.text}
                            </div>
                          </Surface>
                        </div>
                      );
                    }
                    if (isToolPart(part)) {
                      return (
                        <div key={part.toolCallId ?? i} className="max-w-[80%]">
                          <ToolCard part={part} />
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              );
            })}

            {isLoading &&
              !messages.some((m) => m.id.startsWith("streaming-")) && (
                <div className="flex justify-start">
                  <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
                    <span className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse" />
                    <span
                      className="inline-block w-2 h-2 bg-kumo-brand rounded-full mr-1 animate-pulse"
                      style={{ animationDelay: "150ms" }}
                    />
                    <span
                      className="inline-block w-2 h-2 bg-kumo-brand rounded-full animate-pulse"
                      style={{ animationDelay: "300ms" }}
                    />
                  </div>
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
                  isConnected ? "Ask me to use a skill..." : "Connecting..."
                }
                disabled={!isConnected || isLoading}
                rows={2}
                className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
              />
              {isLoading ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={stop}
                  icon={<StopCircleIcon size={18} />}
                  className="mb-0.5"
                />
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={!input.trim() || !isConnected}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex justify-center pb-3">
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </div>

      {/* Skills sidebar */}
      <SkillsSidebar agent={agent} isConnected={isConnected} />
    </div>
  );
}

export default function App() {
  return <Chat />;
}
