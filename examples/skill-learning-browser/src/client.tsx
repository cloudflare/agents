/**
 * Skill-Learning Browser Automation — client.
 *
 * Two-panel layout:
 *   Left  — chat interface with the TaskAgent (shows agent-tool-event
 *            frames while the SkillLearnerAgent sub-agent is running)
 *   Right — live skill registry panel (polls listSkillsCallable)
 *
 * The skill registry panel makes the core pattern visible: watch skills
 * appear as the sub-agent learns them, then see use_count increment as the
 * main agent reuses them for subsequent requests.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { AgentToolRunState } from "agents/chat";
import {
  Badge,
  Button,
  Input,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  MoonIcon,
  SunIcon,
  BrainIcon,
  LightningIcon,
  TrashIcon,
  ListBulletsIcon,
  ArrowClockwiseIcon,
  GearIcon,
  CheckCircleIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { DEMO_USER } from "./protocol";
import type { BrowserSkill } from "./server";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveUser(): string {
  if (typeof window === "undefined") return DEMO_USER;
  const params = new URLSearchParams(window.location.search);
  return params.get("user") ?? DEMO_USER;
}

const USER = resolveUser();

function useDarkMode() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);
  return {
    dark: mode === "dark",
    toggle: () => setMode((m) => (m === "light" ? "dark" : "light"))
  };
}

// ── SkillRegistry panel ───────────────────────────────────────────────────────

function timeAgo(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function SkillCard({
  skill,
  onForget
}: {
  skill: BrowserSkill;
  onForget: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Surface className="p-3 rounded-lg ring ring-kumo-line">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-kumo-default">
              {skill.name}
            </code>
            <Badge variant="secondary">
              {skill.useCount} use{skill.useCount !== 1 ? "s" : ""}
            </Badge>
            <Text size="xs" variant="secondary">
              {timeAgo(skill.learnedAt)}
            </Text>
          </div>
          <span className="block mt-0.5 truncate">
            <Text size="xs" variant="secondary">
              {skill.description}
            </Text>
          </span>
          {Object.keys(skill.parameterSchema).length > 0 && (
            <div className="flex gap-1 flex-wrap mt-1">
              {Object.entries(skill.parameterSchema).map(([k, v]) => (
                <span key={k} title={v.description}>
                  <Badge variant="secondary">
                    {"{{"}
                    {k}
                    {"}}"}
                  </Badge>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            onClick={() => setExpanded((e) => !e)}
            title="Show script template"
            aria-label="Show script template"
            icon={<ListBulletsIcon size={14} />}
          />
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            onClick={() => onForget(skill.name)}
            title="Delete skill"
            aria-label="Delete skill"
            icon={<TrashIcon size={14} />}
          />
        </div>
      </div>
      {expanded && (
        <pre className="mt-2 text-xs bg-kumo-surface-raised rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">
          {skill.scriptTemplate}
        </pre>
      )}
    </Surface>
  );
}

type AgentWithCallables = ReturnType<typeof useAgent> & {
  listSkillsCallable: () => Promise<BrowserSkill[]>;
  forgetSkillCallable: (name: string) => Promise<boolean>;
};

function SkillRegistry({ agent }: { agent: AgentWithCallables }) {
  const [skills, setSkills] = useState<BrowserSkill[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await agent.listSkillsCallable();
      setSkills(result ?? []);
    } catch {
      // silently ignore — agent may not be ready yet
    } finally {
      setLoading(false);
    }
  }, [agent]);

  const forget = useCallback(
    async (name: string) => {
      await agent.forgetSkillCallable(name);
      await refresh();
    },
    [agent, refresh]
  );

  // Poll so the panel updates when new skills are learned
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-3 h-full overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrainIcon size={16} />
          <Text size="sm" bold>
            Skill Registry
          </Text>
          {skills.length > 0 && (
            <Badge variant="secondary">{skills.length}</Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          shape="square"
          onClick={refresh}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh skills"
          icon={
            <ArrowClockwiseIcon
              size={14}
              className={loading ? "animate-spin" : ""}
            />
          }
        />
      </div>

      {skills.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 opacity-50">
          <BrainIcon size={32} />
          <Text size="sm" variant="secondary">
            No skills learned yet.
          </Text>
          <Text size="xs" variant="secondary">
            Ask the agent to search or add items.
          </Text>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto flex flex-col gap-2">
          {skills.map((s) => (
            <SkillCard key={s.name} skill={s} onForget={forget} />
          ))}
        </div>
      )}

      <div className="text-center opacity-40 pb-1">
        <Text size="xs" variant="secondary">
          Skills persist in the DO's SQLite database. Once learned, they execute
          without LLM involvement.
        </Text>
      </div>
    </div>
  );
}

// ── Agent-tool sub-panel ──────────────────────────────────────────────────────

function AgentToolPanel({ run }: { run: AgentToolRunState }) {
  const isRunning = run.status === "running";
  return (
    <div className="ml-4 mt-1 border-l-2 border-kumo-brand pl-3">
      <div className="flex items-center gap-2 mb-1">
        {isRunning ? (
          <GearIcon size={12} className="text-kumo-brand animate-spin" />
        ) : (
          <CheckCircleIcon size={12} className="text-kumo-brand" />
        )}
        <Text size="xs" bold>
          Skill Learner
        </Text>
        {isRunning ? (
          <Badge variant="secondary">Learning…</Badge>
        ) : run.status === "completed" ? (
          <Badge variant="secondary">Skill ready</Badge>
        ) : (
          <Badge variant="destructive">{run.status}</Badge>
        )}
      </div>
      <div className="sd-theme text-sm">
        {run.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <Streamdown key={i} plugins={{ code }}>
                {part.text}
              </Streamdown>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

// ── Message rendering ─────────────────────────────────────────────────────────

function MessageParts({
  message,
  runsByToolCallId
}: {
  message: UIMessage;
  runsByToolCallId: Record<string, AgentToolRunState[]>;
}) {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
    >
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <div
              key={i}
              className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                isUser
                  ? "bg-kumo-brand text-white rounded-br-sm"
                  : "bg-kumo-surface-raised rounded-bl-sm"
              }`}
            >
              {isUser ? (
                <span>{part.text}</span>
              ) : (
                <div className="sd-theme">
                  <Streamdown plugins={{ code }}>{part.text}</Streamdown>
                </div>
              )}
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const toolName = getToolName(part);
          const runs = runsByToolCallId[part.toolCallId] ?? [];
          return (
            <div key={i} className="w-full max-w-[85%]">
              <div className="flex items-center gap-1.5 text-xs opacity-60 mb-1">
                <LightningIcon size={10} />
                <span>{toolName}</span>
                {(part.state === "input-streaming" ||
                  part.state === "input-available") && (
                  <Badge variant="secondary">running</Badge>
                )}
                {part.state === "output-available" && (
                  <Badge variant="secondary">done</Badge>
                )}
              </div>
              {runs.map((run) => (
                <AgentToolPanel key={run.runId} run={run} />
              ))}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const { dark, toggle } = useDarkMode();
  const agent = useAgent({ agent: "TaskAgent", name: USER });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const { runsByToolCallId } = useAgentToolEvents({ agent });

  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const busy = status === "streaming" || status === "submitted";

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || busy) return;
      sendMessage({ text: input });
      setInput("");
    },
    [input, busy, sendMessage]
  );

  const suggestions = useMemo(
    () => [
      "Search for oat milk",
      "Add semi-skimmed milk to my basket",
      "What's in my basket?"
    ],
    []
  );

  return (
    <div className="flex flex-col h-full bg-kumo-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-kumo-line shrink-0">
        <div className="flex items-center gap-2">
          <BrainIcon size={20} className="text-kumo-brand" />
          <Text bold>Skill-Learning Browser Agent</Text>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label="Toggle theme"
            onClick={toggle}
            icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          />
          <PoweredByCloudflare />
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex flex-col flex-1 overflow-hidden border-r border-kumo-line">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {messages.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
                <BrainIcon size={40} className="opacity-30" />
                <Text variant="secondary" size="sm">
                  Ask me to search for products, add items to your basket, or
                  view your basket. I'll learn reusable skills the first time
                  and reuse them instantly on subsequent requests.
                </Text>
                <div className="flex flex-col gap-1 text-left max-w-xs mt-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      className="text-xs text-kumo-brand hover:underline text-left"
                      onClick={() => setInput(s)}
                    >
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg) => (
              <MessageParts
                key={msg.id}
                message={msg}
                runsByToolCallId={runsByToolCallId}
              />
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={submit}
            className="flex gap-2 p-3 border-t border-kumo-line shrink-0"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? "Agent is thinking…" : "Message…"}
              disabled={busy}
              className="flex-1"
            />
            <Button
              type="submit"
              disabled={busy || !input.trim()}
              icon={<PaperPlaneRightIcon size={16} />}
            >
              Send
            </Button>
          </form>
        </div>

        {/* Skill registry panel */}
        <div className="w-72 shrink-0 p-3 overflow-hidden">
          <SkillRegistry agent={agent as unknown as AgentWithCallables} />
        </div>
      </div>
    </div>
  );
}
