// Chat building blocks: a feed that only follows the stream while you are at
// the bottom, a composer, and renderers for message parts. Nothing here is
// specific to this agent — copy it into your own app.
import { Button, cn } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  ProhibitIcon,
  StopIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Streamdown } from "streamdown";

// ── Feed ────────────────────────────────────────────────────────────

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 32;

/**
 * Keeps a scroll container pinned to the bottom while content grows, but
 * lets go as soon as the reader scrolls up, and re-pins when they scroll
 * back down. Growth is detected with a ResizeObserver on the content, so it
 * works for streamed text, images loading, and expanding details alike.
 */
function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const setStuck = useCallback((value: boolean) => {
    stuck.current = value;
    setIsAtBottom(value);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = scrollRef.current;
      if (!el) return;
      setStuck(true);
      el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [setStuck]
  );

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    let lastTop = el.scrollTop;
    let lastHeight = el.scrollHeight;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const movedUp = el.scrollTop < lastTop - 1;
      const shrank = el.scrollHeight < lastHeight;
      if (movedUp && !shrank && distance > BOTTOM_THRESHOLD) setStuck(false);
      else if (distance <= BOTTOM_THRESHOLD) setStuck(true);
      lastTop = el.scrollTop;
      lastHeight = el.scrollHeight;
    };

    // A wheel or touch gesture upward is an unambiguous "let me read".
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && el.scrollTop > 0) setStuck(false);
    };

    const follow = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop;
      lastHeight = el.scrollHeight;
    });
    follow.observe(content);
    follow.observe(el);
    el.scrollTop = el.scrollHeight;

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      follow.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [setStuck]);

  return { scrollRef, contentRef, isAtBottom, scrollToBottom };
}

/**
 * Scrollable message feed. Follows new content only while the reader is at
 * the bottom; scrolling up mid-stream leaves them where they are and shows
 * a "Jump to latest" button instead.
 */
export function ChatFeed({
  children,
  userMessageCount
}: {
  children: ReactNode;
  /** Increases when the user sends a message, which always scrolls down. */
  userMessageCount: number;
}) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } =
    useStickToBottom();

  const previousCount = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount > previousCount.current) scrollToBottom();
    previousCount.current = userMessageCount;
  }, [userMessageCount, scrollToBottom]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto">
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-8 pb-6 sm:px-6"
        >
          {children}
        </div>
      </div>
      {/* Soft edge so text fades out above the composer instead of clipping. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-kumo-base" />
      {!isAtBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto rounded-full shadow-sm"
            icon={<ArrowDownIcon size={14} />}
            onClick={() => scrollToBottom()}
          >
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Messages ────────────────────────────────────────────────────────

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-kumo-tint px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-kumo-default">
        {children}
      </div>
    </div>
  );
}

export function AssistantMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-3">{children}</div>;
}

export function Markdown({
  text,
  streaming
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <Streamdown
      className="sd-theme text-sm leading-relaxed text-kumo-default"
      plugins={{ code }}
      controls={false}
      isAnimating={streaming}
    >
      {text}
    </Streamdown>
  );
}

/** Collapsed-by-default model reasoning. */
export function Reasoning({
  text,
  streaming
}: {
  text: string;
  streaming: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <details className="group text-sm">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-kumo-subtle select-none hover:text-kumo-default">
        <CaretRightIcon
          size={12}
          className="transition-transform group-open:rotate-90"
        />
        <span className={cn(streaming && "animate-pulse")}>
          {streaming ? "Thinking…" : "Thought process"}
        </span>
      </summary>
      <div className="mt-2 ml-1.5 border-l border-kumo-line pl-4 text-xs leading-relaxed whitespace-pre-wrap text-kumo-subtle">
        {text}
      </div>
    </details>
  );
}

/** Shown after sending, until the first part of the reply arrives. */
export function Pending() {
  return (
    <div className="animate-pulse text-sm text-kumo-subtle">Thinking…</div>
  );
}

// ── Tool calls ──────────────────────────────────────────────────────

export type ToolCallState = "running" | "done" | "error" | "denied";

/**
 * One quiet line per tool call. Click it to see what went in and came out;
 * `children` (an image preview, say) always shows.
 */
export function ToolCall({
  label,
  state,
  input,
  output,
  error,
  children
}: {
  label: ReactNode;
  state: ToolCallState;
  input?: ReactNode;
  output?: ReactNode;
  error?: string;
  children?: ReactNode;
}) {
  const icon = {
    running: <CircleNotchIcon size={12} className="animate-spin" />,
    done: <CheckIcon size={12} className="text-kumo-success" />,
    error: <WarningCircleIcon size={12} className="text-kumo-danger" />,
    denied: <ProhibitIcon size={12} />
  }[state];
  const hasDetails = input != null || output != null || error != null;

  return (
    <div className="flex flex-col gap-2">
      <details className="group text-sm">
        <summary
          className={cn(
            "flex w-fit list-none items-center gap-2 text-kumo-subtle select-none",
            hasDetails && "cursor-pointer hover:text-kumo-default"
          )}
        >
          {icon}
          <span>{label}</span>
          {hasDetails && (
            <CaretRightIcon
              size={10}
              className="transition-transform group-open:rotate-90"
            />
          )}
        </summary>
        {hasDetails && (
          <div className="mt-2 flex flex-col gap-3 rounded-lg bg-kumo-recessed p-3">
            {input != null && <ToolPayload title="Input">{input}</ToolPayload>}
            {error != null && (
              <ToolPayload title="Error" tone="danger">
                {error}
              </ToolPayload>
            )}
            {output != null && (
              <ToolPayload title="Output">{output}</ToolPayload>
            )}
          </div>
        )}
      </details>
      {children}
    </div>
  );
}

function ToolPayload({
  title,
  tone,
  children
}: {
  title: string;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium tracking-wide text-kumo-inactive uppercase">
        {title}
      </div>
      <pre
        className={cn(
          "max-h-64 overflow-auto font-mono text-xs break-all whitespace-pre-wrap",
          tone === "danger" ? "text-kumo-danger" : "text-kumo-subtle"
        )}
      >
        {children}
      </pre>
    </div>
  );
}

/** A tool call waiting for the user to allow it. */
export function ToolApproval({
  title,
  children,
  onApprove,
  onReject
}: {
  title: ReactNode;
  children?: ReactNode;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-kumo-base p-4 ring-1 ring-kumo-line">
      <div className="flex items-center gap-2 text-sm">
        <WarningCircleIcon size={16} className="text-kumo-warning" />
        <span className="font-medium text-kumo-default">{title}</span>
      </div>
      {children && (
        <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-xs whitespace-pre-wrap text-kumo-subtle">
          {children}
        </pre>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={onApprove}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" onClick={onReject}>
          Deny
        </Button>
      </div>
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────

/**
 * Message box. Enter sends, Shift+Enter adds a line. While a turn is
 * running, the send button becomes a stop button.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  disabled,
  placeholder = "Ask anything…"
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to max-h, then scroll inside the textarea.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || disabled || !value.trim()) return;
    onSubmit();
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 rounded-2xl bg-kumo-control p-2 pl-4 shadow-xs ring-1 ring-kumo-line transition-shadow has-[textarea:focus]:ring-kumo-brand/60"
    >
      {/* leading-6 + py-1.5 = 36px, the send button's height, so one line
          of text sits on the button's centre line. */}
      <textarea
        ref={textareaRef}
        aria-label="Message"
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            submit(event);
          }
        }}
        className="max-h-48 flex-1 resize-none bg-transparent py-1.5 text-sm leading-6 text-kumo-default outline-none placeholder:text-kumo-placeholder disabled:cursor-not-allowed"
      />
      {busy && onStop ? (
        <Button
          type="button"
          shape="circle"
          variant="secondary"
          aria-label="Stop"
          icon={<StopIcon size={14} weight="fill" />}
          onClick={onStop}
        />
      ) : (
        <Button
          type="submit"
          shape="circle"
          variant="primary"
          aria-label="Send"
          disabled={busy || disabled || !value.trim()}
          icon={<ArrowUpIcon size={16} weight="bold" />}
        />
      )}
    </form>
  );
}

// ── Chrome ──────────────────────────────────────────────────────────

export function ConnectionDot({
  status
}: {
  status: "connecting" | "connected" | "disconnected";
}) {
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting…"
        : "Disconnected";
  return (
    <output className="flex items-center gap-2 text-xs text-kumo-subtle">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "connected" && "bg-kumo-success",
          status === "connecting" && "animate-pulse bg-kumo-warning",
          status === "disconnected" && "bg-kumo-danger"
        )}
      />
      <span className="hidden sm:inline">{label}</span>
    </output>
  );
}

/** Theme toggle backed by `data-mode` on <html> (set early in index.html). */
export function useColorMode() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);
  const toggle = useCallback(
    () => setMode((m) => (m === "light" ? "dark" : "light")),
    []
  );
  return [mode, toggle] as const;
}

/** Tracks a CSS media query, e.g. `useMediaQuery("(min-width: 1024px)")`. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
