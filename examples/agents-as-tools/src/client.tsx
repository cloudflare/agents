/**
 * Agents-as-tools example — client.
 *
 * Renders a single chat against the `Assistant` Think agent, with one
 * extra trick: while the assistant's `research` or `plan` tool is running, the
 * child agent it spawned (`Researcher` / `Planner`, themselves Think agents)
 * streams its chat chunks to the parent. The framework forwards those chunks on
 * the same WebSocket as `agent-tool-event` frames. `useAgentToolEvents` groups
 * them by the originating chat `toolCallId`, and the UI renders a mini-message
 * panel attached to the matching tool part.
 *
 * Architecture:
 *
 *     useAgent ──▶ raw WS ──▶ useAgentToolEvents ──▶ AgentToolRunState[]
 *           │                                                      │
 *           ▼                                                      ▼
 *     useAgentChat ──▶ messages[] (with tool parts) ──▶ <HelperPanel toolCallId={...} />
 *
 * Two stream sources, one connection, joined in the UI by toolCallId.
 *
 * The helper's chat chunks are AI SDK `UIMessageChunk` shapes — same
 * vocabulary `useAgentChat` uses for the assistant's main message.
 * `useAgentToolEvents` accumulates them per-helper into a parts array,
 * then we render those parts the same way the assistant's message renders.
 *
 * Per-helper drill-in is wired here via `<DrillInPanel>`: clicking
 * the ↗ button on any helper panel opens a side panel that runs a
 * full `useAgentChat` against the helper's own sub-agent connection
 * (`useAgent({ agent: "Assistant", name: USER, sub: [{ agent:
 * helperType, name: runId }] })`). Because the helper IS a
 * Think, drill-in is real chat, not a custom event view — the
 * routing primitive does all the work.
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
  ChatCircleIcon,
  InfoIcon,
  GearIcon,
  XCircleIcon,
  CheckCircleIcon,
  CaretDownIcon,
  CaretRightIcon,
  RobotIcon,
  TrashIcon,
  ArrowSquareOutIcon,
  XIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { DEMO_USER } from "./protocol";

/**
 * Resolve the Assistant DO's "user name" for this page. Defaults to
 * `DEMO_USER` so the production demo is single-user; an optional
 * `?user=…` query param overrides it.
 *
 * The override is the hook the e2e suite uses to make tests
 * hermetic — Playwright opens each test against a fresh
 * `?user=test-<uuid>` URL so each test gets its own Assistant DO,
 * which means no helper-row state leaks across tests AND the
 * "alarms inside facets lose `ctx.id.name` when the alarm fires
 * after the dev server restarts" framework gap can't bite us
 * (each test's DO is fresh — no in-flight alarms from a previous
 * session).
 *
 * Real users would never set this; production code should
 * authenticate the user and pass the canonical id explicitly.
 */
function resolveUser(): string {
  if (typeof window === "undefined") return DEMO_USER;
  const params = new URLSearchParams(window.location.search);
  return params.get("user") ?? DEMO_USER;
}

const USER = resolveUser();

/**
 * Helper class names that drill-in knows how to route to. Mirrors
 * the server's `helperClassByType` keys — adding a class server-side
 * means adding it here too. Using a set rather than a free string
 * lets `<DrillInPanel>` render an explicit error state instead of
 * the silent "Connecting to helper…" hang we hit in 2026-04-28
 * before the routing fix (and would still hit if a row ever stored
 * an unknown `helper_type`).
 */
const KNOWN_HELPER_TYPES: ReadonlySet<string> = new Set([
  "Researcher",
  "Planner"
]);

type HelperParts = UIMessage["parts"];

/**
 * Per-helper accumulated state. Reconstructs the helper's growing
 * `UIMessage` from the forwarded chunk firehose, plus lifecycle metadata
 * (status, helperType, query, summary, error) from the parent's
 * synthesized `started`/`finished`/`error` events.
 */
type HelperState = {
  helperId: string;
  helperType: string;
  query: string;
  /**
   * Display order within a parent tool call's bucket. Set by the
   * `started` event the parent stamps from its dispatch position
   * (`compare` passes 0 for `a`, 1 for `b`). The renderer sorts by
   * this so panels appear left-to-right in the order the LLM
   * specified, not in race-determined arrival order.
   */
  order: number;
  status: "running" | "done" | "error";
  /** AI SDK `UIMessage.parts` reconstructed from agent-tool chunk events. */
  parts: HelperParts;
  /** Final synthesized summary, set on `finished`. */
  summary?: string;
  error?: string;
};

function toHelperState(run: AgentToolRunState): HelperState {
  const label = run.display?.name ?? run.agentType;
  const preview =
    typeof run.inputPreview === "string"
      ? run.inputPreview
      : run.inputPreview === undefined
        ? ""
        : JSON.stringify(run.inputPreview);
  return {
    helperId: run.runId,
    helperType: label,
    query: preview,
    order: run.order,
    status:
      run.status === "completed"
        ? "done"
        : run.status === "running"
          ? "running"
          : "error",
    parts: run.parts,
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

// ── Helper panel (renders the helper's growing UIMessage) ─────────
//
// This is the visual "money shot" of the demo. While the parent
// `research` tool is running, the helper's chat stream is rebuilt
// here as a live mini-message: text, reasoning blocks, tool calls.
// The shape mirrors how `useAgentChat` renders the assistant's own
// message, because it IS the same chunk vocabulary — Think's
// `_streamResult` produces these `UIMessageChunk` shapes for both.

function HelperPartRenderer({ part }: { part: HelperParts[number] }) {
  if (part.type === "text") {
    return (
      <Streamdown
        className="sd-theme text-kumo-default text-xs leading-relaxed"
        plugins={{ code }}
      >
        {part.text}
      </Streamdown>
    );
  }

  if (part.type === "reasoning") {
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

  if (isToolUIPart(part)) {
    const toolName = getToolName(part);
    const input = "input" in part ? part.input : undefined;
    const output = "output" in part ? part.output : undefined;
    const errorText = "errorText" in part ? part.errorText : undefined;
    const state = part.state;
    const isRunning =
      state === "input-streaming" || state === "input-available";
    const isDone = state === "output-available";
    const isError = state === "output-error";

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
          <pre className="mt-1 text-[11px] text-kumo-default whitespace-pre-wrap wrap-break-word">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}
        {isError && errorText && (
          <pre className="mt-1 text-[11px] text-red-500 whitespace-pre-wrap wrap-break-word">
            {errorText}
          </pre>
        )}
        {isDone && output != null && (
          <pre className="mt-1 text-[11px] text-kumo-default whitespace-pre-wrap wrap-break-word">
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

function HelperPanel({
  state,
  onDrillIn
}: {
  state: HelperState;
  /**
   * Opens the drill-in side panel for this helper. Single argument
   * is the helper id; the App owns the side-panel state. Optional —
   * `null` disables the drill-in affordance entirely (e.g. when a
   * future renderer reuses this component in a non-drill-in
   * context).
   */
  onDrillIn?: (helperId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const partsCount = state.parts.length;

  return (
    <Surface
      className="p-2 rounded-lg ring ring-kumo-line"
      data-testid="helper-panel"
      data-helper-type={state.helperType}
      data-helper-id={state.helperId}
      data-helper-status={state.status}
    >
      <div className="w-full flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-2 cursor-pointer min-w-0 flex-1"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
          <RobotIcon size={14} className="text-kumo-inactive" />
          <Text size="xs" bold>
            {state.helperType}
          </Text>
          <span className="truncate min-w-0">
            <Text size="xs" variant="secondary">
              {state.query}
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
        {onDrillIn && (
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={`Drill in to ${state.helperType}`}
            onClick={() => onDrillIn(state.helperId)}
            icon={<ArrowSquareOutIcon size={14} />}
          />
        )}
      </div>
      {open && (partsCount > 0 || state.error) && (
        <div className="mt-2 pl-4 border-l border-kumo-line flex flex-col gap-2">
          {state.parts.map((part, i) => (
            <HelperPartRenderer key={i} part={part} />
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

// ── Tool part (chat protocol) with inline helper panel ────────────

type ToolPartArg = Parameters<typeof getToolName>[0];

function ToolPart({
  part,
  helperStates,
  onDrillIn
}: {
  part: ToolPartArg;
  /**
   * Helpers attached to this tool call. Multiple panels render when
   * the parent dispatched several helpers under one tool call (the
   * `compare` tool, or any future fan-out tool). Each panel is keyed
   * by `helperId`. Single-helper tool calls just pass a one-entry
   * array; the array case handles the GLips-style fan-out from
   * cloudflare/agents#1377-comment-4328296343 (image 3).
   */
  helperStates: HelperState[];
  /** Forwarded to each `<HelperPanel>` so the ↗ button has somewhere to call. */
  onDrillIn?: (helperId: string) => void;
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
        Inline helper panels. Rendered between the tool's input and
        its final output, so the visual story reads top-to-bottom:
        what the LLM asked for → how the helpers worked through it →
        what came back. Multiple panels appear when the tool's
        execute fanned out to several helpers (e.g. `compare`).
      */}
      {helperStates.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          {helperStates.map((state) => (
            <HelperPanel
              key={state.helperId}
              state={state}
              onDrillIn={onDrillIn}
            />
          ))}
        </div>
      )}

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

/**
 * Per-tool-call bucket of helper states, keyed by helperId. A tool
 * call typically has one helper (the `research` tool) but can have
 * several when the tool's execute dispatched a fan-out (the
 * `compare` tool's `Promise.all`).
 */
type HelperBucket = HelperState[];

function MessageParts({
  message,
  helperStateByToolCall,
  onDrillIn
}: {
  message: UIMessage;
  helperStateByToolCall: Record<string, HelperBucket>;
  /** Forwarded to each `<ToolPart>` for its helper panels. */
  onDrillIn?: (helperId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
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
          const helperStates = helperStateByToolCall[toolCallId] ?? [];
          return (
            <ToolPart
              key={toolCallId || i}
              part={part}
              helperStates={helperStates}
              onDrillIn={onDrillIn}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

// ── Drill-in side panel ────────────────────────────────────────────
//
// A click on a helper panel's ↗ button opens a side panel that runs
// a full `useAgentChat` against the helper's own sub-agent connection.
// Because the helper IS a Think, this is real chat — not a custom
// event view. The routing primitive (`sub: [{agent, name}]`) does all
// the work; this component is mostly the presentation layer.
//
// Mounting the panel triggers a fresh `useAgent` connection to the
// helper. Unmounting (close, switch helpers) cleans up the WebSocket.
// We render it only when `helperId` is set, so the side effect is
// scoped to "while the user is looking at this helper."

function DrillInPanel({
  helperId,
  helperType,
  query,
  helperStatus,
  onClose
}: {
  helperId: string;
  helperType: string;
  query: string;
  /**
   * The helper's lifecycle status as the parent has observed it
   * ("running", "done", "error"). Mirrors the badge on the inline
   * `<HelperPanel>` — keeps the side-panel header consistent with
   * the inline panel the user just clicked through from. Named
   * `helperStatus` to avoid colliding with `useAgentChat`'s `status`
   * (which is the chat-protocol "ready"/"submitted"/... state).
   */
  helperStatus: HelperState["status"];
  onClose: () => void;
}) {
  // Guard against unknown helper class names BEFORE opening the
  // useAgent connection. Without this, a row whose `helper_type`
  // doesn't match any class registered in the framework (typo,
  // class removed in a later release, accidentally-mutated state)
  // would route to a 404 path; useAgentChat would show an empty
  // `messages` array and the UI would hang on "Connecting to
  // helper…" with no surfaced cause — the same silent failure we
  // shipped on 2026-04-28 from a different root cause.
  const isKnownHelperType = KNOWN_HELPER_TYPES.has(helperType);

  // Direct WS to the helper sub-agent. URL shape:
  // `/agents/assistant/{USER}/sub/{kebab(helperType)}/{helperId}`.
  // The framework routes this through Assistant (which has no
  // `onBeforeSubAgent` gate, so any known helperId works) and into
  // the matching helper facet. The helper's `onConnect` (Think's
  // default protocol setup) sends MSG_CHAT_MESSAGES; useAgentChat
  // picks it up.
  //
  // `agent: helperType` (rather than the class name string verbatim)
  // is what makes drill-in work for both `Researcher` and `Planner`
  // panels. Hardcoding `agent: "Researcher"` would route a Planner
  // drill-in into a fresh empty Researcher facet (because
  // `onBeforeSubAgent` is open) and the UI would hang on
  // "Connecting to helper…" with no error to surface.
  //
  // We pass a safe fallback type when `helperType` isn't recognized
  // — the connection won't be used (we render the error state
  // below) but the hook needs SOMETHING to compute its URL with so
  // we don't violate the rules-of-hooks by conditionally calling.
  const helperAgent = useAgent<{ readonly state: unknown }, unknown>({
    agent: "Assistant",
    name: USER,
    sub: [
      {
        agent: isKnownHelperType ? helperType : "Researcher",
        name: helperId
      }
    ]
  });
  const { messages, sendMessage, status } = useAgentChat({
    agent: helperAgent
  });

  const [input, setInput] = useState("");
  const send = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;
      // Sending here is a real new turn on the helper. Useful
      // affordance — drill-in IS chat. Note: the helper's history
      // already contains the parent's original query, so a follow-up
      // "explain more" works naturally.
      sendMessage({ text: input });
      setInput("");
    },
    [input, sendMessage]
  );

  // Close on Escape so the panel feels like a modal rather than a
  // permanent fixture.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        className="flex-1 bg-black/40 cursor-pointer"
        onClick={onClose}
        aria-label="Close drill-in"
      />
      <Surface
        className="w-full max-w-2xl flex flex-col border-l border-kumo-line"
        data-testid="drill-in-panel"
        data-drill-in-helper-type={helperType}
        data-drill-in-helper-id={helperId}
      >
        <header className="border-b border-kumo-line px-4 py-2 flex items-center gap-2 shrink-0">
          <RobotIcon size={18} className="text-kumo-accent shrink-0" />
          <div className="min-w-0 flex-1">
            <Text size="sm" bold>
              {helperType}
            </Text>
            <span className="block truncate">
              <Text size="xs" variant="secondary">
                {query}
              </Text>
            </span>
          </div>
          {helperStatus === "running" ? (
            <Badge variant="secondary">Running</Badge>
          ) : helperStatus === "done" ? (
            <Badge variant="secondary">Done</Badge>
          ) : (
            <Badge variant="destructive">Error</Badge>
          )}
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            onClick={onClose}
            aria-label="Close drill-in"
            icon={<XIcon size={16} />}
          />
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
          {!isKnownHelperType ? (
            <div className="flex-1 flex items-center justify-center">
              <Surface className="p-4 rounded-xl ring ring-kumo-line max-w-md">
                <Text size="sm" bold>
                  Unknown helper class: {helperType}
                </Text>
                <span className="block mt-1">
                  <Text size="xs" variant="secondary">
                    Drill-in only knows how to route to helper classes bound on
                    the server (currently: {[...KNOWN_HELPER_TYPES].join(", ")}
                    ). The row in <code>cf_agent_tool_runs</code> may have been
                    written by a removed class — clearing chat history will
                    reset it.
                  </Text>
                </span>
              </Surface>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <Text size="xs" variant="secondary">
                Connecting to helper…
              </Text>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="flex flex-col gap-1">
                <Text size="xs" variant="secondary">
                  {m.role}
                </Text>
                {/*
                  Helpers don't dispatch their own helpers in this
                  example, so `helperStateByToolCall={}` is correct.
                  Recursive drill-in (helper→helper→helper) is a
                  Stage 5 question; for now the inner tool calls in
                  the helper's own message render as ordinary tool
                  parts without nested panels.
                */}
                <MessageParts
                  message={m}
                  helperStateByToolCall={{}}
                  // No drill-in from inside drill-in — keeps the
                  // navigation model single-level for now.
                />
              </div>
            ))
          )}
        </div>

        <form
          onSubmit={send}
          className="border-t border-kumo-line p-3 flex gap-2 shrink-0"
        >
          <Input
            aria-label={`Continue conversation with ${helperType}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isKnownHelperType
                ? "Continue the conversation with this helper…"
                : "Composer disabled — unknown helper class."
            }
            disabled={!isKnownHelperType || status !== "ready"}
            className="flex-1"
          />
          <Button
            type="submit"
            disabled={!isKnownHelperType || status !== "ready" || !input.trim()}
            icon={<PaperPlaneRightIcon size={16} />}
          >
            Send
          </Button>
        </form>
      </Surface>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────

export default function App() {
  // One Assistant DO for this single-user demo. A real app would
  // authenticate first and use the user's id.
  const agent = useAgent({ agent: "Assistant", name: USER });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });
  const agentTools = useAgentToolEvents({ agent });
  const { runsByToolCallId, resetLocalState } = agentTools;
  const helperStateByToolCall = useMemo<Record<string, HelperBucket>>(() => {
    return Object.fromEntries(
      Object.entries(runsByToolCallId).map(([toolCallId, runs]) => [
        toolCallId,
        runs.map(toHelperState)
      ])
    );
  }, [runsByToolCallId]);

  // Drill-in side panel target. We store just the helper id; the
  // panel's metadata (helperType, query) is looked up from the
  // existing helper state. The panel itself opens its own
  // `useAgent({ sub: [...] })` connection to the helper; we don't
  // need to pre-resolve anything here.
  const [drillInHelperId, setDrillInHelperId] = useState<string | null>(null);
  const openDrillIn = useCallback(
    (helperId: string) => setDrillInHelperId(helperId),
    []
  );
  const closeDrillIn = useCallback(() => setDrillInHelperId(null), []);

  // When messages.length drops to 0 (chat cleared in this tab or
  // another tab via `clearHistory`), reset all helper state too so
  // the panels disappear in lockstep with the messages they were
  // attached to. Also closes any open drill-in — the helper it was
  // pointing at has been deleted, and rendering would noop anyway.
  useEffect(() => {
    if (messages.length === 0) {
      resetLocalState();
      setDrillInHelperId(null);
    }
  }, [messages.length, resetLocalState]);

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
      resetLocalState();
      setDrillInHelperId(null);
    })();
  }, [agent, clearHistory, resetLocalState]);

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
                  <code>Researcher</code> sub-agent. The helper is itself a
                  Think instance running its own inference loop; its chat stream
                  is forwarded onto this WebSocket and rendered inline under the
                  tool call as it runs.
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
                helperStateByToolCall={helperStateByToolCall}
                onDrillIn={openDrillIn}
              />
            </div>
          ))
        )}
      </div>

      {/* ── Drill-in side panel ─────────────────────────────────── */}
      {drillInHelperId &&
        (() => {
          // Find this helper's state to populate the panel header.
          // The map is `parentToolCallId → HelperState[]`, so we scan
          // buckets. The state is small: one entry per retained run in
          // the current chat history.
          let helperState: HelperState | undefined;
          for (const bucket of Object.values(helperStateByToolCall)) {
            helperState = bucket.find(
              (run) => run.helperId === drillInHelperId
            );
            if (helperState) {
              break;
            }
          }
          if (!helperState) {
            // Helper id refers to a state that's been cleared or
            // never tracked — close cleanly. Shouldn't happen in
            // practice (drill-in is triggered from a panel that is
            // already in the state map).
            return null;
          }
          return (
            <DrillInPanel
              // Key on helperId so switching from one drill-in to
              // another fully unmounts/remounts: tears down the
              // previous useAgent WS, resets the composer's input
              // state, and avoids any prop-vs-hook-arg drift.
              key={helperState.helperId}
              helperId={helperState.helperId}
              helperType={helperState.helperType}
              query={helperState.query}
              helperStatus={helperState.status}
              onClose={closeDrillIn}
            />
          );
        })()}

      {/* ── Composer ───────────────────────────────────────────── */}
      <form
        onSubmit={send}
        className="border-t border-kumo-line p-3 flex gap-2 shrink-0"
      >
        <Input
          aria-label="Send a message to the assistant"
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
