/**
 * Think coding-orchestrator example — client.
 *
 * One chat against the `CodingOrchestrator` (a Think agent). When it delegates
 * a coding task, it spawns a `ClaudeCodeAgent` sub-agent that runs Claude Code
 * in its own container. The framework forwards that sub-agent's chat chunks to
 * the parent on the same WebSocket as `agent-tool-event` frames;
 * `useAgentToolEvents` groups them by the originating `toolCallId`, and we
 * render each as a panel attached to the matching tool part — Claude's
 * narration, tool calls, and the final diff stream in live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import {
  getToolOrDynamicToolName,
  isToolOrDynamicToolUIPart,
  type UIMessage
} from "ai";
import type { AgentToolRunState } from "agents/chat";
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
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CpuIcon,
  GearIcon,
  GitDiffIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  RobotIcon,
  SunIcon,
  TrashIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const USER = "default";

type RunParts = UIMessage["parts"];

type DelegateState = {
  runId: string;
  label: string;
  task: string;
  order: number;
  status: "running" | "done" | "error";
  parts: RunParts;
  progress?: AgentToolRunState["progress"];
  summary?: string;
  error?: string;
};

function previewText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const task = (input as Record<string, unknown>).task;
    if (typeof task === "string") return task;
  }
  return input === undefined ? "" : JSON.stringify(input);
}

function toDelegateState(
  run: AgentToolRunState<UIMessage["parts"][number]>
): DelegateState {
  return {
    runId: run.runId,
    label: run.display?.name ?? run.agentType,
    task: previewText(run.inputPreview),
    order: run.order,
    status:
      run.status === "completed"
        ? "done"
        : run.status === "running"
          ? "running"
          : "error",
    parts: run.parts,
    progress: run.progress,
    summary: run.summary,
    error: run.error
  };
}

// ── Small UI helpers ───────────────────────────────────────────────

function ConnectionDot({
  status
}: {
  status: "connecting" | "connected" | "disconnected";
}) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  return <span className={`size-2 rounded-full ${dot}`} />;
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

/** Live progress bar for a running delegate, fed by its `reportProgress` calls. */
function ProgressBar({
  progress
}: {
  progress: NonNullable<AgentToolRunState["progress"]>;
}) {
  const pct =
    typeof progress.fraction === "number"
      ? Math.max(0, Math.min(1, progress.fraction)) * 100
      : undefined;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        {progress.phase && <Badge variant="secondary">{progress.phase}</Badge>}
        {progress.message && (
          <span className="truncate min-w-0">
            <Text size="xs" variant="secondary">
              {progress.message}
            </Text>
          </span>
        )}
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-kumo-line overflow-hidden">
        <div
          className={`h-full bg-kumo-accent transition-all ${
            pct === undefined ? "animate-pulse w-1/3" : ""
          }`}
          style={pct === undefined ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Delegate panel (renders a sub-agent's growing message) ─────────

function RunPartRenderer({ part }: { part: RunParts[number] }) {
  if (part.type === "text") {
    return (
      <Streamdown
        className="sd-theme text-kumo-default text-xs leading-relaxed"
        plugins={{ code }}
        controls={false}
      >
        {part.text}
      </Streamdown>
    );
  }

  if (part.type === "reasoning") {
    if (!part.text) return null;
    return (
      <Surface className="p-2 rounded-lg ring ring-kumo-line bg-kumo-base">
        <div className="flex items-center gap-2 mb-1">
          <GearIcon size={12} className="text-kumo-inactive" />
          <Text size="xs" variant="secondary" bold>
            Thinking
          </Text>
        </div>
        <Streamdown
          className="sd-theme text-xs text-kumo-secondary"
          plugins={{ code }}
        >
          {part.text}
        </Streamdown>
      </Surface>
    );
  }

  if (isToolOrDynamicToolUIPart(part)) {
    const toolName = getToolOrDynamicToolName(part);
    const input = "input" in part ? part.input : undefined;
    const output = "output" in part ? part.output : undefined;
    const errorText = "errorText" in part ? part.errorText : undefined;
    const isRunning =
      part.state === "input-streaming" || part.state === "input-available";
    const isDone = part.state === "output-available";
    const isError = part.state === "output-error";

    const icon = isError ? (
      <XCircleIcon size={12} className="text-red-500" />
    ) : isDone ? (
      <CheckCircleIcon size={12} className="text-green-500" />
    ) : isRunning ? (
      <GearIcon size={12} className="text-kumo-inactive animate-spin" />
    ) : (
      <GearIcon size={12} className="text-kumo-inactive" />
    );

    return (
      <Surface className="p-2 rounded-lg ring ring-kumo-line bg-kumo-base">
        <div className="flex items-center gap-2">
          {icon}
          <Text size="xs" variant="secondary" bold>
            {toolName}
          </Text>
          {isDone ? (
            <Badge variant="secondary">Done</Badge>
          ) : isError ? (
            <Badge variant="destructive">Error</Badge>
          ) : isRunning ? (
            <Badge variant="secondary">Running</Badge>
          ) : null}
        </div>
        {input != null && (
          <pre className="mt-1 text-[11px] text-kumo-default whitespace-pre-wrap wrap-break-word max-h-32 overflow-y-auto">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}
        {isError && (
          <pre className="mt-1 text-[11px] text-red-500 whitespace-pre-wrap wrap-break-word">
            {errorText ?? "Tool execution failed"}
          </pre>
        )}
        {isDone && output != null && (
          <pre className="mt-1 text-[11px] text-kumo-default whitespace-pre-wrap wrap-break-word max-h-40 overflow-y-auto">
            {typeof output === "string"
              ? output
              : JSON.stringify(output, null, 2)}
          </pre>
        )}
      </Surface>
    );
  }

  return null;
}

function DelegatePanel({ state }: { state: DelegateState }) {
  const [open, setOpen] = useState(true);
  return (
    <Surface className="p-2 rounded-lg ring ring-kumo-line">
      <div className="w-full flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-2 cursor-pointer min-w-0 flex-1"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
          <RobotIcon size={14} className="text-kumo-inactive" />
          <Text size="xs" bold>
            {state.label}
          </Text>
          <span className="truncate min-w-0">
            <Text size="xs" variant="secondary">
              {state.task}
            </Text>
          </span>
        </button>
        {state.status === "running" ? (
          <Badge variant="secondary">Running</Badge>
        ) : state.status === "done" ? (
          <Badge variant="secondary">Done</Badge>
        ) : (
          <Badge variant="destructive">Error</Badge>
        )}
      </div>
      {state.status === "running" && state.progress && (
        <ProgressBar progress={state.progress} />
      )}
      {open && (state.parts.length > 0 || state.error) && (
        <div className="mt-2 pl-4 border-l border-kumo-line flex flex-col gap-2">
          {state.parts.map((part, i) => (
            <RunPartRenderer key={i} part={part} />
          ))}
          {state.error && (
            <span className="text-red-500">
              <Text size="xs" variant="secondary">
                {state.error}
              </Text>
            </span>
          )}
        </div>
      )}
    </Surface>
  );
}

// ── Orchestrator tool part with inline delegate panels ─────────────

function ToolPart({
  part,
  delegates
}: {
  part: RunParts[number];
  delegates: DelegateState[];
}) {
  if (!isToolOrDynamicToolUIPart(part)) return null;
  const toolName = getToolOrDynamicToolName(part);
  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";
  const isDone = part.state === "output-available";
  const isError = part.state === "output-error";

  return (
    <Surface className="p-3 rounded-xl ring ring-kumo-line overflow-hidden">
      <div className="flex items-center gap-2">
        <GearIcon
          size={14}
          className={`text-kumo-inactive ${isRunning ? "animate-spin" : ""}`}
        />
        <Text size="xs" variant="secondary" bold>
          {isRunning ? `Running ${toolName}…` : toolName}
        </Text>
        {isDone && <Badge variant="secondary">Done</Badge>}
        {isError && <Badge variant="destructive">Error</Badge>}
      </div>

      {input != null && (
        <pre className="mt-2 text-xs text-kumo-default whitespace-pre-wrap wrap-break-word">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}

      {delegates.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          {delegates.map((state) => (
            <DelegatePanel key={state.runId} state={state} />
          ))}
        </div>
      )}

      {isError && (
        <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap wrap-break-word">
          {errorText ?? "Tool execution failed"}
        </pre>
      )}

      {isDone && output != null && (
        <pre className="mt-2 text-xs text-kumo-default whitespace-pre-wrap wrap-break-word max-h-48 overflow-y-auto">
          {typeof output === "string"
            ? output
            : JSON.stringify(output, null, 2)}
        </pre>
      )}
    </Surface>
  );
}

function MessageParts({
  message,
  delegatesByToolCall
}: {
  message: UIMessage;
  delegatesByToolCall: Record<string, DelegateState[]>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <Streamdown
              key={i}
              className="sd-theme text-kumo-default text-sm leading-relaxed"
              plugins={{ code }}
              controls={false}
            >
              {part.text}
            </Streamdown>
          );
        }

        if (part.type === "reasoning") {
          if (!part.text) return null;
          return (
            <Surface
              key={i}
              className="p-2 rounded-lg ring ring-kumo-line bg-kumo-base"
            >
              <div className="flex items-center gap-2 mb-1">
                <GearIcon size={14} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Thinking
                </Text>
              </div>
              <Streamdown
                className="sd-theme text-xs text-kumo-secondary"
                plugins={{ code }}
              >
                {part.text}
              </Streamdown>
            </Surface>
          );
        }

        if (isToolOrDynamicToolUIPart(part)) {
          const toolCallId = part.toolCallId ?? "";
          return (
            <ToolPart
              key={toolCallId || i}
              part={part}
              delegates={delegatesByToolCall[toolCallId] ?? []}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────

export default function App() {
  const agent = useAgent({ agent: "CodingOrchestrator", name: USER });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const { runsByToolCallId, resetLocalState } = useAgentToolEvents<
    UIMessage["parts"][number]
  >({ agent });

  const delegatesByToolCall = useMemo<Record<string, DelegateState[]>>(() => {
    return Object.fromEntries(
      Object.entries(runsByToolCallId).map(([toolCallId, runs]) => [
        toolCallId,
        runs.map(toDelegateState)
      ])
    );
  }, [runsByToolCallId]);

  useEffect(() => {
    if (messages.length === 0) resetLocalState();
  }, [messages.length, resetLocalState]);

  const [input, setInput] = useState("");
  const send = useCallback(() => {
    const text = input.trim();
    if (!text || status !== "ready") return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, status, sendMessage]);

  const clear = useCallback(() => {
    void (async () => {
      try {
        await agent.call("clearDelegatedRuns");
      } catch (err) {
        console.warn("Failed to clear delegated runs:", err);
      }
      clearHistory();
      resetLocalState();
    })();
  }, [agent, clearHistory, resetLocalState]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages]);

  const connectionStatus =
    agent.readyState === 1
      ? "connected"
      : agent.readyState === 0
        ? "connecting"
        : "disconnected";

  return (
    <div className="h-screen flex flex-col bg-kumo-base text-kumo-default">
      <header className="border-b border-kumo-line px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <CpuIcon size={18} />
          <Text bold>Coding Orchestrator</Text>
          <Badge variant="secondary">aywson</Badge>
          <ConnectionDot status={connectionStatus} />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={clear}
            disabled={messages.length === 0}
            icon={<TrashIcon size={14} />}
          >
            Clear
          </Button>
          <ModeToggle />
        </div>
      </header>

      <div className="p-3 shrink-0">
        <Surface className="p-3 rounded-xl ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={18}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div>
              <Text size="sm" bold>
                Think orchestrates Claude Code in containers
              </Text>
              <span className="block mt-1">
                <Text size="xs" variant="secondary">
                  The orchestrator delegates each coding task to a{" "}
                  <code>Claude Code</code> sub-agent running in its own
                  Cloudflare Sandbox container. Ask for one change, or several
                  at once — each runs in parallel and streams its work and final
                  diff back here.
                </Text>
              </span>
            </div>
          </div>
        </Surface>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4"
      >
        {messages.length === 0 ? (
          <EmptyHints />
        ) : (
          messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-1">
              <Text size="xs" variant="secondary">
                {m.role}
              </Text>
              <MessageParts
                message={m}
                delegatesByToolCall={delegatesByToolCall}
              />
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-kumo-line p-3 flex gap-2 shrink-0"
      >
        <InputArea
          aria-label="Send a message to the orchestrator"
          value={input}
          onValueChange={setInput}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Describe a coding task to delegate…"
          disabled={status !== "ready"}
          rows={2}
          className="flex-1"
        />
        <Button
          type="submit"
          disabled={status !== "ready" || !input.trim()}
          icon={<PaperPlaneRightIcon size={16} />}
        >
          Send
        </Button>
      </form>

      <div className="flex justify-center pb-3 shrink-0">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </div>
    </div>
  );
}

function EmptyHints() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Empty
        icon={<GitDiffIcon size={32} />}
        title="Delegate a coding task"
        description='Try "Add a clone(json) helper that deep-copies a JSONC string, with a test" — or ask for two changes at once to watch them run in parallel containers.'
      />
    </div>
  );
}
