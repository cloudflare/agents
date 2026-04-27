/**
 * Agents-as-tools example — client.
 *
 * Renders a single chat against the `Assistant` Think agent, with one
 * extra trick: while the assistant's `research` tool is running, the
 * sub-agent it spawned (`Researcher`) streams helper-event frames to
 * the parent over DO RPC. The parent forwards those frames on the
 * same WebSocket the chat already uses. We collect those frames in
 * React state, key them by the originating chat `toolCallId`, and
 * render them inline as a live progress panel attached to the
 * matching tool part in the assistant's message.
 *
 * Architecture:
 *
 *     useAgent ──▶ raw WS ──▶ addEventListener("message") ──▶ HelperEvent[]
 *           │                                                      │
 *           ▼                                                      ▼
 *     useAgentChat ──▶ messages[] (with tool parts) ──▶ <HelperEvents toolCallId={...} />
 *
 * Two stream sources, one connection, joined in the UI by toolCallId.
 *
 * The thing to evaluate as you read this: does the `<HelperEvents>`
 * component look like a plausible shape for an eventual AI SDK
 * `UIMessagePart` of type `helper`? If yes, the v1 framework move is
 * to formalize the part type and lift the parent-forwarding pattern
 * into a small `helperTool(Cls)` helper.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
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
  ChatCircleIcon,
  InfoIcon,
  GearIcon,
  XCircleIcon,
  CheckCircleIcon,
  CaretDownIcon,
  CaretRightIcon,
  RobotIcon,
  MagnifyingGlassIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  DEMO_USER,
  type HelperEvent,
  type HelperEventMessage
} from "./protocol";

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

// ── Helper events panel ────────────────────────────────────────────
//
// This is the visual "money shot" of the demo. While the parent
// `research` tool is running, the helper's events stream in here as a
// live timeline. The structure of this component is roughly the
// shape an eventual AI SDK `UIMessagePart` of type `helper` would
// render — keeping the JSX in one place makes it easy to lift later.

function HelperEventIcon({ event }: { event: HelperEvent }) {
  switch (event.kind) {
    case "started":
      return <RobotIcon size={14} className="text-kumo-accent" />;
    case "step":
      return <CaretRightIcon size={14} className="text-kumo-inactive" />;
    case "tool-call":
      return (
        <MagnifyingGlassIcon
          size={14}
          className="text-kumo-inactive animate-pulse"
        />
      );
    case "tool-result":
      return <CheckCircleIcon size={14} className="text-kumo-inactive" />;
    case "finished":
      return <CheckCircleIcon size={14} className="text-green-500" />;
    case "error":
      return <XCircleIcon size={14} className="text-red-500" />;
  }
}

function HelperEventLine({ event }: { event: HelperEvent }) {
  const icon = <HelperEventIcon event={event} />;

  let label: React.ReactNode;
  switch (event.kind) {
    case "started":
      label = (
        <>
          <Text size="xs" bold>
            {event.helperType}
          </Text>
          <Text size="xs" variant="secondary">
            {" started — "}
            <em>{event.query}</em>
          </Text>
        </>
      );
      break;
    case "step":
      label = (
        <Text size="xs" variant="secondary">
          {`Step ${event.step}: ${event.description}`}
        </Text>
      );
      break;
    case "tool-call":
      label = (
        <Text size="xs" variant="secondary">
          {`→ ${event.toolName}(${truncateInput(event.input)})`}
        </Text>
      );
      break;
    case "tool-result":
      label = (
        <Text size="xs" variant="secondary">
          {`← ${truncateOutput(event.output)}`}
        </Text>
      );
      break;
    case "finished":
      label = (
        <Text size="xs" variant="secondary">
          Helper finished. Returning summary to the assistant.
        </Text>
      );
      break;
    case "error":
      label = (
        <Text size="xs" variant="secondary">
          {`Error: ${event.error}`}
        </Text>
      );
      break;
  }

  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{label}</div>
    </div>
  );
}

function HelperEvents({ events }: { events: HelperEvent[] }) {
  const [open, setOpen] = useState(true);
  if (events.length === 0) return null;

  const finished = events.some((e) => e.kind === "finished");
  const errored = events.some((e) => e.kind === "error");
  const stepCount = events.filter((e) => e.kind === "step").length;
  const helperType =
    events.find((e) => e.kind === "started")?.helperType ?? "Helper";

  const status = errored ? "error" : finished ? "done" : "running";

  return (
    <Surface className="mt-2 p-2 rounded-lg ring ring-kumo-line">
      <button
        type="button"
        className="w-full flex items-center gap-2 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        <RobotIcon size={14} className="text-kumo-inactive" />
        <Text size="xs" bold>
          {helperType}
        </Text>
        <Text size="xs" variant="secondary">
          {`${stepCount} step${stepCount === 1 ? "" : "s"}`}
        </Text>
        {status === "running" ? (
          <Badge variant="secondary">Running</Badge>
        ) : status === "done" ? (
          <Badge variant="secondary">Done</Badge>
        ) : (
          <Badge variant="destructive">Error</Badge>
        )}
      </button>
      {open && (
        <div className="mt-2 pl-4 border-l border-kumo-line">
          {events.map((event, i) => (
            <HelperEventLine key={i} event={event} />
          ))}
        </div>
      )}
    </Surface>
  );
}

function truncateInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return clamp(input, 60);
  try {
    return clamp(JSON.stringify(input), 60);
  } catch {
    return "[unserializable]";
  }
}

function truncateOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return clamp(output, 80);
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (typeof obj.findings === "string") return clamp(obj.findings, 80);
  }
  try {
    return clamp(JSON.stringify(output), 80);
  } catch {
    return "[unserializable]";
  }
}

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ── Tool part (chat protocol) with inline helper events ────────────

type ToolPartArg = Parameters<typeof getToolName>[0];

function ToolPart({
  part,
  helperEvents
}: {
  part: ToolPartArg;
  helperEvents: HelperEvent[];
}) {
  const toolName = getToolName(part);
  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;
  const state = part.state;
  const isRunning = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const isError = state === "output-error";

  const icon = isError ? (
    <XCircleIcon size={14} className="text-kumo-inactive" />
  ) : isRunning ? (
    <GearIcon size={14} className="text-kumo-inactive animate-spin" />
  ) : (
    <GearIcon size={14} className="text-kumo-inactive" />
  );
  const badge = isDone ? (
    <Badge variant="secondary">Done</Badge>
  ) : isError ? (
    <Badge variant="destructive">Error</Badge>
  ) : isRunning ? null : (
    <Badge variant="secondary">{state}</Badge>
  );

  return (
    <Surface className="p-3 rounded-xl ring ring-kumo-line overflow-hidden">
      <div className="flex items-center gap-2">
        {icon}
        <Text size="xs" variant="secondary" bold>
          {isRunning ? `Running ${toolName}…` : toolName}
        </Text>
        {badge}
      </div>

      {input != null && (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
            Input
          </span>
          <pre className="mt-1 text-xs text-kumo-default whitespace-pre-wrap wrap-break-word">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}

      {/*
        Inline helper events. Rendered between the tool's input and
        its final output, so the visual story reads top-to-bottom:
        what the LLM asked for → how the helper worked through it →
        what came back.
      */}
      {helperEvents.length > 0 && <HelperEvents events={helperEvents} />}

      {isError && errorText && (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
            Error
          </span>
          <pre className="mt-1 text-xs text-kumo-default whitespace-pre-wrap wrap-break-word">
            {errorText}
          </pre>
        </div>
      )}

      {isDone && output != null && (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
            Output
          </span>
          <pre className="mt-1 text-xs text-kumo-default whitespace-pre-wrap wrap-break-word">
            {typeof output === "string"
              ? output
              : JSON.stringify(output, null, 2)}
          </pre>
        </div>
      )}
    </Surface>
  );
}

// ── Message rendering ──────────────────────────────────────────────

function MessageParts({
  message,
  helperEventsByToolCall
}: {
  message: UIMessage;
  helperEventsByToolCall: Record<
    string,
    Array<{ sequence: number; event: HelperEvent }>
  >;
}) {
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          // Render text via Streamdown so the assistant's markdown
          // (lists, headings, fenced code, links, …) and the user's
          // message text share a consistent renderer. `sd-theme`
          // bridges Streamdown's shadcn-style color tokens to Kumo's
          // semantics (see `styles.css`); `plugins={{ code }}` adds
          // syntax-highlighted fenced code blocks via Shiki.
          return (
            <Streamdown
              key={i}
              className="sd-theme text-kumo-default text-sm leading-relaxed"
              plugins={{ code }}
            >
              {part.text}
            </Streamdown>
          );
        }

        if (part.type === "reasoning") {
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

        if (isToolUIPart(part)) {
          const toolCallId = part.toolCallId ?? "";
          // Strip the `sequence` discriminator at the boundary —
          // downstream rendering only cares about the events.
          const helperEvents = (helperEventsByToolCall[toolCallId] ?? []).map(
            (e) => e.event
          );
          return (
            <ToolPart
              key={toolCallId || i}
              part={part}
              helperEvents={helperEvents}
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
  // One Assistant DO for this single-user demo. A real app would
  // authenticate first and use the user's id.
  const agent = useAgent({ agent: "Assistant", name: DEMO_USER });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  // Map of `parentToolCallId` → ordered events. Events arrive on
  // the same WebSocket as the chat stream, but as separate
  // `helper-event` frames; we sieve them out here, dedupe by
  // sequence, and key by the originating chat tool-call ID so the
  // message renderer can attach them inline.
  //
  // Each entry stores `{ sequence, event }` tuples instead of bare
  // events because frames can arrive out of order during the
  // reconnect window: `onConnect` runs replays inside an `await`,
  // and live broadcasts from the still-running tool execute can
  // reach the new connection during that await. So we
  //
  //   1. dedupe by `(parentToolCallId, sequence)` (Set semantics —
  //      same event arriving twice is silently ignored)
  //   2. insert at the right position to keep the array sorted by
  //      sequence (so the rendered timeline is always in the order
  //      the helper actually emitted, regardless of wire order)
  //
  // The sequence is helper-local (== `chunk_index` in the helper's
  // `ResumableStream`), so it's unique within a single helper run,
  // and `parentToolCallId` is unique per chat tool-call → unique per
  // helper run. No cross-helper collisions even with parallel
  // helpers in the same turn.
  const [helperEventsByToolCall, setHelperEventsByToolCall] = useState<
    Record<string, Array<{ sequence: number; event: HelperEvent }>>
  >({});

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { type?: unknown }).type !== "helper-event"
      ) {
        return;
      }
      const message = parsed as HelperEventMessage;

      setHelperEventsByToolCall((prev) => {
        const existing = prev[message.parentToolCallId] ?? [];

        // Dedup by sequence within this helper's bucket.
        if (existing.some((e) => e.sequence === message.sequence)) {
          return prev;
        }

        // Sorted insertion. Keeps the panel rendering in helper-emit
        // order even if a live broadcast races ahead of a replay frame.
        const inserted = {
          sequence: message.sequence,
          event: message.event
        };
        const insertIdx = existing.findIndex(
          (e) => e.sequence > message.sequence
        );
        const next =
          insertIdx === -1
            ? [...existing, inserted]
            : [
                ...existing.slice(0, insertIdx),
                inserted,
                ...existing.slice(insertIdx)
              ];

        return { ...prev, [message.parentToolCallId]: next };
      });
    };

    agent.addEventListener("message", handler);
    return () => agent.removeEventListener("message", handler);
  }, [agent]);

  useEffect(() => {
    if (messages.length === 0) {
      setHelperEventsByToolCall({});
    }
  }, [messages.length]);

  const [input, setInput] = useState("");
  const send = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;
      sendMessage({ text: input });
      setInput("");
    },
    [input, sendMessage]
  );

  const clear = useCallback(() => {
    void (async () => {
      // Delete retained helper facets before broadcasting the chat
      // clear. Otherwise another tab could reconnect in the small
      // window between clearHistory() and helper-run cleanup and see
      // a replay of helper panels the user just cleared.
      try {
        await agent.call("clearHelperRuns");
      } catch (err) {
        console.warn("[agents-as-tools] Failed to clear helper runs:", err);
      }
      clearHistory();
      setHelperEventsByToolCall({});
    })();
  }, [agent, clearHistory]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages.length]);

  const connectionStatus =
    agent.readyState === 1
      ? "connected"
      : agent.readyState === 0
        ? "connecting"
        : "disconnected";

  return (
    <div className="h-full flex flex-col bg-kumo-base text-kumo-default">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-kumo-line px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <ChatCircleIcon size={18} />
          <Text bold>Agents as Tools</Text>
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

      {/* ── Explainer ───────────────────────────────────────────── */}
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
                Helper events stream live, inline
              </Text>
              <span className="block mt-1">
                <Text size="xs" variant="secondary">
                  Ask for research on a topic. The assistant calls the{" "}
                  <code>research</code> tool, which spawns a{" "}
                  <code>Researcher</code> sub-agent. The helper's lifecycle
                  events stream into the chat WebSocket on a side channel and
                  render inline under the tool call as it runs.
                </Text>
              </span>
            </div>
          </div>
        </Surface>
      </div>

      {/* ── Message stream ──────────────────────────────────────── */}
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
                helperEventsByToolCall={helperEventsByToolCall}
              />
            </div>
          ))
        )}
      </div>

      {/* ── Composer ───────────────────────────────────────────── */}
      <form
        onSubmit={send}
        className="border-t border-kumo-line p-3 flex gap-2 shrink-0"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask for research on a topic…"
          disabled={status !== "ready"}
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

      <PoweredByCloudflare />
    </div>
  );
}

function EmptyHints() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Surface className="max-w-lg p-4 rounded-xl ring ring-kumo-line">
        <Text size="sm" bold>
          Try asking for research:
        </Text>
        <ul className="mt-2 ml-4 list-disc">
          <li>
            <Text size="xs" variant="secondary">
              Research the top three Rust web frameworks and compare their
              throughput.
            </Text>
          </li>
          <li>
            <Text size="xs" variant="secondary">
              Find me three good arguments for and against monorepos.
            </Text>
          </li>
          <li>
            <Text size="xs" variant="secondary">
              What changed in HTTP/3 versus HTTP/2?
            </Text>
          </li>
          <li>
            <Text size="xs" variant="secondary">
              What are the key differences between OAuth 2.0 and OIDC?
            </Text>
          </li>
        </ul>
        <span className="block mt-3">
          <Text size="xs" variant="secondary">
            Plain chat works too — the helper only spawns when the model decides
            to call the <code>research</code> tool.
          </Text>
        </span>
      </Surface>
    </div>
  );
}
