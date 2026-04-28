/**
 * Agents-as-tools example — client.
 *
 * Renders a single chat against the `Assistant` Think agent, with one
 * extra trick: while the assistant's `research` tool is running, the
 * sub-agent it spawned (`Researcher`, itself a Think) streams its
 * chat-stream chunks to the parent over DO RPC. The parent forwards
 * those chunks on the same WebSocket the chat already uses, wrapped
 * in a `helper-event` envelope. We collect those frames in React
 * state, key them by the originating chat `toolCallId`, and render a
 * mini-message panel attached to the matching tool part in the
 * assistant's message.
 *
 * Architecture:
 *
 *     useAgent ──▶ raw WS ──▶ addEventListener("message") ──▶ HelperEvent[]
 *           │                                                      │
 *           ▼                                                      ▼
 *     useAgentChat ──▶ messages[] (with tool parts) ──▶ <HelperPanel toolCallId={...} />
 *
 * Two stream sources, one connection, joined in the UI by toolCallId.
 *
 * The helper's chat chunks are AI SDK `UIMessageChunk` shapes — same
 * vocabulary `useAgentChat` uses for the assistant's main message.
 * We accumulate them per-helper through `applyChunkToParts` (exported
 * from `agents/chat`) into a parts array, then render the parts the
 * same way the assistant's message renders.
 *
 * Per-helper drill-in is wired here via `<DrillInPanel>`: clicking
 * the ↗ button on any helper panel opens a side panel that runs a
 * full `useAgentChat` against the helper's own sub-agent connection
 * (`useAgent({ agent: "Assistant", name: DEMO_USER, sub: [{ agent:
 * "Researcher", name: helperId }] })`). Because the helper IS a
 * Think, drill-in is real chat, not a custom event view — the
 * routing primitive does all the work.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { applyChunkToParts } from "agents/chat";
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
  TrashIcon,
  ArrowSquareOutIcon,
  XIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  DEMO_USER,
  type HelperEvent,
  type HelperEventMessage
} from "./protocol";

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
  /** AI SDK `UIMessage.parts` reconstructed from chunk-events via `applyChunkToParts`. */
  parts: HelperParts;
  /** Final synthesized summary, set on `finished`. */
  summary?: string;
  error?: string;
};

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

// ── Helper-state reducer ───────────────────────────────────────────

/**
 * Apply a single helper event to the helper's accumulated state.
 * Returns the next state (or the same reference if nothing changed,
 * so React's reference equality short-circuits a re-render).
 *
 * `started` initializes; `chunk` parses the body and runs it through
 * `applyChunkToParts`; `finished`/`error` flip the status and stash
 * the terminal payload. Out-of-order frames are tolerated — the
 * sequence-based dedup in the parent state ensures we apply each
 * event exactly once.
 */
function applyHelperEvent(
  prev: HelperState | undefined,
  event: HelperEvent
): HelperState {
  switch (event.kind) {
    case "started":
      return {
        helperId: event.helperId,
        helperType: event.helperType,
        query: event.query,
        order: event.order,
        status: "running",
        parts: prev?.parts ?? []
      };
    case "chunk": {
      const parts = prev?.parts ? [...prev.parts] : [];
      try {
        const chunk = JSON.parse(event.body);
        // applyChunkToParts mutates the array in place.
        applyChunkToParts(parts, chunk);
      } catch {
        // Malformed chunk — skip silently; the lifecycle event will
        // surface any real failure.
      }
      return {
        helperId: event.helperId,
        helperType: prev?.helperType ?? "Helper",
        query: prev?.query ?? "",
        order: prev?.order ?? 0,
        status: prev?.status ?? "running",
        parts,
        summary: prev?.summary,
        error: prev?.error
      };
    }
    case "finished":
      return {
        helperId: event.helperId,
        helperType: prev?.helperType ?? "Helper",
        query: prev?.query ?? "",
        order: prev?.order ?? 0,
        status: "done",
        parts: prev?.parts ?? [],
        summary: event.summary
      };
    case "error":
      return {
        helperId: event.helperId,
        helperType: prev?.helperType ?? "Helper",
        query: prev?.query ?? "",
        order: prev?.order ?? 0,
        status: "error",
        parts: prev?.parts ?? [],
        error: event.error
      };
  }
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
type HelperBucket = Record<string /* helperId */, HelperState>;

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
          const bucket = helperStateByToolCall[toolCallId] ?? {};
          // Sort by the `order` field stamped on each helper's
          // `started` event — for `compare`, that's 0 (a) and 1 (b),
          // matching the input position the LLM specified. Falls
          // back to insertion order via the stable-sort guarantee
          // when two helpers share an `order` value (e.g. two
          // single-helper tool calls that both used 0).
          const helperStates = Object.values(bucket).sort(
            (a, b) => a.order - b.order
          );
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
  // Direct WS to the helper sub-agent. URL shape:
  // `/agents/assistant/{DEMO_USER}/sub/{kebab(helperType)}/{helperId}`.
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
  const helperAgent = useAgent({
    agent: "Assistant",
    name: DEMO_USER,
    sub: [{ agent: helperType, name: helperId }]
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
      <Surface className="w-full max-w-2xl flex flex-col border-l border-kumo-line">
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
          {messages.length === 0 ? (
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Continue the conversation with this helper…"
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
      </Surface>
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

  // Map of `parentToolCallId` → `helperId` → accumulated helper state.
  // Helper events arrive on the same WebSocket as the chat stream,
  // but as separate `helper-event` frames; we sieve them out here,
  // dedupe by `(parentToolCallId, helperId, sequence)`, fold them
  // into per-helper state via `applyHelperEvent`, and key by the
  // originating chat tool-call ID so the message renderer can attach
  // panels inline.
  //
  // The two-level shape (rather than `Record<parentToolCallId, …>`)
  // is what makes parallel fan-out work: a single tool call can
  // dispatch several helpers (the `compare` tool's `Promise.all`),
  // and each helper has its own `helperId` but shares the chat tool
  // call's `parentToolCallId`. Without per-helper keys the second
  // helper's `started` event would clobber the first's panel.
  //
  // We also track which sequence numbers we've already applied per
  // helper so out-of-order replay-vs-live frames don't double-apply.
  // (The same event can arrive twice during the reconnect window:
  // once from `onConnect` replay and once from the in-flight live
  // broadcast. Each event is idempotent in shape, but `applyChunkToParts`
  // mutates the parts array — applying twice would double-emit text.)
  // Sequence numbers are per-helper-run, so the dedup key is also
  // `(parentToolCallId, helperId)` — two parallel helpers under one
  // tool call both legitimately emit a `sequence: 0` started event.
  const [helperStateByToolCall, setHelperStateByToolCall] = useState<
    Record<string, HelperBucket>
  >({});
  const seenSequencesRef = useRef<Map<string, Set<number>>>(new Map());

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
      const parentKey = message.parentToolCallId;
      const helperId = message.event.helperId;
      // `JSON.stringify([a, b])` rather than a `${a}::${b}` template:
      // the array form is collision-proof regardless of what
      // characters the ids contain. AI SDK tool-call ids and nanoid
      // helper ids both happen to be alphanumeric in practice, but
      // this keeps the dedup correctness independent of that.
      const dedupKey = JSON.stringify([parentKey, helperId]);

      const seenForKey =
        seenSequencesRef.current.get(dedupKey) ?? new Set<number>();
      if (seenForKey.has(message.sequence)) {
        return;
      }
      seenForKey.add(message.sequence);
      seenSequencesRef.current.set(dedupKey, seenForKey);

      setHelperStateByToolCall((prev) => {
        const bucket = prev[parentKey] ?? {};
        const nextBucket = {
          ...bucket,
          [helperId]: applyHelperEvent(bucket[helperId], message.event)
        };
        return { ...prev, [parentKey]: nextBucket };
      });
    };

    agent.addEventListener("message", handler);
    return () => agent.removeEventListener("message", handler);
  }, [agent]);

  // When messages.length drops to 0 (chat cleared in this tab or
  // another tab via `clearHistory`), reset all helper state too so
  // the panels disappear in lockstep with the messages they were
  // attached to. Also closes any open drill-in — the helper it was
  // pointing at has been deleted, and rendering would noop anyway.
  useEffect(() => {
    if (messages.length === 0) {
      setHelperStateByToolCall({});
      seenSequencesRef.current.clear();
      setDrillInHelperId(null);
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
      setHelperStateByToolCall({});
      seenSequencesRef.current.clear();
      setDrillInHelperId(null);
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
          // The map is `parentToolCallId → helperId → HelperState`,
          // so we have to scan buckets — there's no reverse index
          // and the state is small (one entry per helper run in the
          // current chat history).
          let helperState: HelperState | undefined;
          for (const bucket of Object.values(helperStateByToolCall)) {
            if (bucket[drillInHelperId]) {
              helperState = bucket[drillInHelperId];
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
