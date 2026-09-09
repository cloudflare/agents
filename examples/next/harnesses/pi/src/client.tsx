import {
  Badge,
  Button,
  Dialog,
  Empty,
  Input,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  BrainIcon,
  CalculatorIcon,
  CheckCircleIcon,
  ClockIcon,
  DiceFiveIcon,
  FlagIcon,
  GearIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type {
  ExtensionUiResponse,
  SlashCommand,
  ToolInfo,
  TranscriptMessage,
  TranscriptPart
} from "./protocol";
import { usePiSession } from "./use-pi-session";
import type { Notice, StatusSlot, UiDialog, Widget } from "./use-pi-session";
import "./styles.css";

const SESSION_KEY = "pi-harness-session";
const MODEL = "@cf/moonshotai/kimi-k2.7-code";

const SUGGESTIONS = [
  {
    icon: <DiceFiveIcon size={15} />,
    label: "Roll 4d12",
    value: "Roll four 12-sided dice and tell me the total."
  },
  {
    icon: <CalculatorIcon size={15} />,
    label: "Calculate 47 × 19",
    value: "Use the calculator to multiply 47 by 19."
  },
  {
    icon: <BrainIcon size={15} />,
    label: "Remember a fact",
    value: "Remember that my favourite launch snack is stroopwafels."
  },
  {
    icon: <ClockIcon size={15} />,
    label: "What time is it?",
    value: "Use a tool to tell me the current UTC time."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

function getSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
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
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ToolCallCard({
  part,
  running
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
}) {
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {part.name}
        </span>
        <Badge variant="secondary">{running ? "Running" : "Called"}</Badge>
      </summary>
      <div className="border-t border-kumo-line px-3 py-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
          Arguments
        </p>
        <JsonBlock value={part.arguments} />
      </div>
    </details>
  );
}

function ToolResultCard({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  const text = part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
  const images = part.content.filter((content) => content.type === "image");
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {part.error ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{part.name}</span>
          {text ? <span className="ml-2 text-kumo-subtle">{text}</span> : null}
        </span>
        <Badge variant={part.error ? "destructive" : "secondary"}>
          {part.error ? "Failed" : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        {text ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <JsonBlock value={text} />
          </div>
        ) : null}
        {images.map((image, index) =>
          image.type === "image" ? (
            <img
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`${part.name} output`}
              className="max-w-full rounded-lg"
            />
          ) : null
        )}
        {part.details !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Details
            </p>
            <JsonBlock value={part.details} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssistantPart({
  part,
  running
}: {
  part: TranscriptPart;
  running: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <Streamdown
          className="sd-theme text-sm leading-6"
          plugins={{ code }}
          controls={false}
        >
          {part.text}
        </Streamdown>
      );
    case "thinking":
      return (
        <details className="rounded-xl border border-kumo-line px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
            Thinking
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
            {part.text}
          </p>
        </details>
      );
    case "tool-call":
      return <ToolCallCard part={part} running={running} />;
    case "tool-result":
      return <ToolResultCard part={part} />;
    case "image":
      return (
        <img
          src={`data:${part.mimeType};base64,${part.data}`}
          alt=""
          className="max-w-full rounded-lg"
        />
      );
  }
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <BrainIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, index) => (
          <AssistantPart
            key={`${message.id}-${index}`}
            part={part}
            running={
              streaming &&
              part.type === "tool-call" &&
              runningTools.includes(part.name)
            }
          />
        ))}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolMessage({ message }: { message: TranscriptMessage }) {
  return (
    <div className="ml-11 space-y-2">
      {message.parts.map((part, index) =>
        part.type === "tool-result" ? (
          <ToolResultCard key={`${message.id}-${index}`} part={part} />
        ) : null
      )}
    </div>
  );
}

function Message({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          streaming={streaming}
          runningTools={runningTools}
        />
      );
    case "tool":
      return <ToolMessage message={message} />;
  }
}

function Sidebar({
  tools,
  activeTools,
  flags,
  onSetFlag,
  onClose
}: {
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  flags: Readonly<Record<string, boolean | string>>;
  onSetFlag: (name: string, value: boolean | string) => void;
  onClose: () => void;
}) {
  const flagNames = Object.keys(flags);
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Tools"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <Text size="sm" bold>
          Tools
        </Text>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close tools"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {flagNames.length > 0 ? (
          <Surface className="rounded-lg p-3 ring ring-kumo-line">
            <div className="flex items-center gap-2">
              <FlagIcon size={14} className="text-kumo-inactive" />
              <Text size="sm" bold>
                Extension flags
              </Text>
            </div>
            <div className="mt-2 space-y-1.5">
              {flagNames.map((name) => (
                <div key={name} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-xs">
                    {name}
                  </code>
                  {typeof flags[name] === "boolean" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onSetFlag(name, !flags[name])}
                    >
                      {flags[name] ? "on" : "off"}
                    </Button>
                  ) : (
                    <Badge variant="secondary">{String(flags[name])}</Badge>
                  )}
                </div>
              ))}
            </div>
          </Surface>
        ) : null}
        {tools.map((tool) => (
          <Surface
            key={tool.name}
            className="rounded-lg p-3 ring ring-kumo-line"
          >
            <div className="flex items-center gap-2">
              {activeTools.includes(tool.name) ? (
                <GearIcon size={14} className="animate-spin text-kumo-accent" />
              ) : (
                <WrenchIcon size={14} className="text-kumo-inactive" />
              )}
              <code className="text-xs font-semibold">{tool.name}</code>
            </div>
            <p className="mt-1 text-xs text-kumo-subtle">{tool.description}</p>
          </Surface>
        ))}
      </div>
    </aside>
  );
}

/**
 * The dialog half of the extension UI protocol: one `select`, `confirm`,
 * `input` or `editor` request at a time. Dismissing answers `cancelled`, which
 * is what the harness's bridge would settle with on its own timeout anyway.
 */
function ExtensionDialog({
  dialog,
  onAnswer
}: {
  dialog: UiDialog;
  onAnswer: (requestId: string, response: ExtensionUiResponse) => void;
}) {
  const [draft, setDraft] = useState(
    dialog.method === "editor" ? (dialog.prefill ?? "") : ""
  );
  const answer = (response: ExtensionUiResponse) =>
    onAnswer(dialog.requestId, response);
  const cancel = () => answer({ cancelled: true });

  return (
    <Dialog.Root
      open
      onOpenChange={(open: boolean) => {
        if (!open) cancel();
      }}
    >
      <Dialog className="p-6" size={dialog.method === "editor" ? "lg" : "base"}>
        <Dialog.Title>{dialog.title}</Dialog.Title>
        {dialog.method === "confirm" ? (
          <Dialog.Description>{dialog.message}</Dialog.Description>
        ) : (
          <Dialog.Description>
            Requested by an extension on this session.
          </Dialog.Description>
        )}

        {dialog.method === "select" ? (
          <div className="mt-4 flex flex-col gap-2">
            {dialog.options.map((option) => (
              <Button
                key={option}
                variant="secondary"
                className="justify-start"
                onClick={() => answer({ value: option })}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : null}

        {dialog.method === "input" ? (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              answer({ value: draft });
            }}
          >
            <Input
              value={draft}
              onValueChange={setDraft}
              placeholder={dialog.placeholder}
              aria-label={dialog.title}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Send
              </Button>
            </div>
          </form>
        ) : null}

        {dialog.method === "editor" ? (
          <div className="mt-4 flex flex-col gap-3">
            <InputArea
              value={draft}
              onValueChange={setDraft}
              rows={10}
              aria-label={dialog.title}
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={cancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => answer({ value: draft })}
              >
                Save
              </Button>
            </div>
          </div>
        ) : null}

        {dialog.method === "confirm" ? (
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => answer({ confirmed: false })}
            >
              No
            </Button>
            <Button
              variant="primary"
              onClick={() => answer({ confirmed: true })}
            >
              Yes
            </Button>
          </div>
        ) : null}
      </Dialog>
    </Dialog.Root>
  );
}

/** `notify` messages and failed hooks, newest last, dismissable. */
function NoticeToasts({
  notices,
  onDismiss
}: {
  notices: readonly Notice[];
  onDismiss: (id: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {notices.map((notice) => (
        <Surface
          key={notice.id}
          aria-live="polite"
          className={`pointer-events-auto rounded-xl p-3 ring ${
            notice.level === "error"
              ? "ring-kumo-danger"
              : notice.level === "warning"
                ? "ring-kumo-warning"
                : "ring-kumo-line"
          }`}
        >
          <div className="flex items-start gap-2">
            {notice.level === "info" ? (
              <InfoIcon size={15} className="mt-0.5 text-kumo-accent" />
            ) : (
              <WarningCircleIcon
                size={15}
                className={`mt-0.5 ${
                  notice.level === "error"
                    ? "text-kumo-danger"
                    : "text-kumo-warning"
                }`}
              />
            )}
            <div className="min-w-0 flex-1">
              {notice.source ? (
                <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
                  {notice.source}
                </p>
              ) : null}
              <p className="break-words text-xs leading-5">{notice.message}</p>
            </div>
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              aria-label="Dismiss"
              onClick={() => onDismiss(notice.id)}
              icon={<XIcon size={13} />}
            />
          </div>
        </Surface>
      ))}
    </div>
  );
}

/** `setStatus` slots and `setWidget` lines, shown above the composer. */
function StatusStrip({
  statuses,
  widgets
}: {
  statuses: readonly StatusSlot[];
  widgets: readonly Widget[];
}) {
  if (statuses.length === 0 && widgets.length === 0) return null;
  return (
    <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-5 pt-3 text-xs text-kumo-subtle">
      {statuses.map((slot) => (
        <Badge key={slot.key} variant="secondary">
          {slot.text}
        </Badge>
      ))}
      {widgets.map((widget) => (
        <span key={widget.key} className="truncate">
          {widget.lines.join(" · ")}
        </span>
      ))}
    </div>
  );
}

/** Autocomplete over the lane's extension, template and skill commands. */
function CommandMenu({
  commands,
  active,
  onPick
}: {
  commands: readonly SlashCommand[];
  active: number;
  onPick: (command: SlashCommand) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <Surface
      className="mb-2 max-h-56 overflow-y-auto rounded-xl p-1 ring ring-kumo-line"
      aria-label="Slash commands"
    >
      {commands.map((command, index) => (
        <button
          key={`${command.source}-${command.name}`}
          type="button"
          aria-current={index === active}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(command);
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${
            index === active ? "bg-kumo-elevated" : ""
          }`}
        >
          <TerminalWindowIcon size={13} className="text-kumo-inactive" />
          <code className="text-xs font-semibold">/{command.name}</code>
          <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">
            {command.description}
          </span>
          <Badge variant="secondary">{command.source}</Badge>
        </button>
      ))}
    </Surface>
  );
}

/** `/name rest` — null when the text is not a slash command. */
function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text);
  return match?.[1] === undefined
    ? null
    : { name: match[1], args: match[2] ?? "" };
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState("");
  const [toolsOpen, setToolsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const [activeCommand, setActiveCommand] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    messages,
    live,
    running,
    runningTools,
    tools,
    error,
    commands,
    flags,
    dialog,
    notices,
    statuses,
    widgets,
    title,
    editorText,
    submit: submitPrompt,
    abort,
    answerUi,
    runCommand,
    setFlag,
    dismissNotice,
    clearEditorText
  } = usePiSession(session);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

  // An extension pushed text into the editor; the composer owns it from here.
  useEffect(() => {
    if (editorText === undefined) return;
    setPrompt(editorText);
    clearEditorText();
  }, [editorText, clearEditorText]);

  const connected = status === "open";

  const slash = prompt.startsWith("/") ? parseSlash(prompt) : null;
  const suggestions =
    slash && !prompt.includes(" ")
      ? commands.filter((command) => command.name.startsWith(slash.name))
      : [];

  const pickCommand = (command: SlashCommand) => {
    setPrompt(`/${command.name} `);
    setActiveCommand(0);
  };

  const submit = () => {
    const text = prompt.trim();
    if (!text || running || !connected) return;
    const parsed = parseSlash(text);
    if (parsed && commands.some((command) => command.name === parsed.name)) {
      setPrompt("");
      runCommand(parsed.name, parsed.args);
      return;
    }
    setPrompt("");
    submitPrompt(text);
  };

  const newSession = () => {
    const next = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
  };

  const empty = messages.length === 0 && !live && !running;

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        toolsOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,26vw)]"
          : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
                <BrainIcon size={20} weight="bold" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">
                  {title ?? "Pi harness"}
                </h1>
                <p className="truncate text-xs text-kumo-subtle">
                  Session <code>{session.slice(0, 8)}</code>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {MODEL.split("/").at(-1)}
              </Badge>
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="Tools"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
                icon={<WrenchIcon size={16} />}
              />
              <Button
                variant="ghost"
                shape="square"
                aria-label="New session"
                onClick={newSession}
                disabled={running}
                icon={<PlusIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="Ask Pi something that needs a tool"
                  description="Tool calls and results stream in as they happen."
                />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.label}
                      variant="secondary"
                      size="sm"
                      icon={suggestion.icon}
                      disabled={!connected}
                      onClick={() => setPrompt(suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                runningTools={runningTools}
              />
            ))}

            {live ? (
              <Message message={live} streaming runningTools={runningTools} />
            ) : null}

            {running && !live ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
                  <BrainIcon size={17} weight="bold" />
                </div>
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    {runningTools.length > 0
                      ? `Running ${runningTools.join(", ")}`
                      : "Waking the durable operation"}
                  </div>
                </Surface>
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                {error}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </main>

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <StatusStrip statuses={statuses} widgets={widgets} />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mx-auto max-w-3xl px-5 pt-4"
          >
            <CommandMenu
              commands={suggestions}
              active={activeCommand}
              onPick={pickCommand}
            />
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
              <InputArea
                value={prompt}
                onValueChange={(value: string) => {
                  setPrompt(value);
                  setActiveCommand(0);
                }}
                onKeyDown={(event) => {
                  const open = suggestions.length > 0;
                  if (open && event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveCommand((index) =>
                      Math.min(index + 1, suggestions.length - 1)
                    );
                    return;
                  }
                  if (open && event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveCommand((index) => Math.max(index - 1, 0));
                    return;
                  }
                  if (
                    open &&
                    (event.key === "Tab" ||
                      (event.key === "Enter" && !event.shiftKey))
                  ) {
                    const picked = suggestions[activeCommand];
                    if (picked) {
                      event.preventDefault();
                      pickCommand(picked);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask Pi to use a tool, or / for a command"
                aria-label="Message Pi"
                disabled={!connected || running}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {running ? (
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Stop"
                  onClick={abort}
                  icon={<StopIcon size={18} weight="fill" />}
                  className="mb-0.5"
                />
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!connected || prompt.trim() === ""}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex items-center justify-center gap-2 px-5 py-3">
            <span className="hidden text-[10px] text-kumo-inactive sm:inline">
              Enter to send · Shift+Enter for a new line
            </span>
            <span className="hidden text-kumo-line sm:inline">·</span>
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </section>

      {toolsOpen ? (
        <Sidebar
          tools={tools}
          activeTools={runningTools}
          flags={flags}
          onSetFlag={setFlag}
          onClose={() => setToolsOpen(false)}
        />
      ) : null}

      <NoticeToasts notices={notices} onDismiss={dismissNotice} />
      {dialog ? (
        <ExtensionDialog
          key={dialog.requestId}
          dialog={dialog}
          onAnswer={answerUi}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
