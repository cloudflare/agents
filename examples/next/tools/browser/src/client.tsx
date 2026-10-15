import {
  Button,
  Dialog,
  PoweredByCloudflare,
  Tooltip,
  TooltipProvider
} from "@cloudflare/kumo";
import {
  AppWindowIcon,
  CompassIcon,
  InfoIcon,
  MoonIcon,
  NotePencilIcon,
  SunIcon,
  XIcon
} from "@phosphor-icons/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AboutDialog, HostChip, HOSTS } from "./about-dialog";
import { BrowserPanel, useBrowserState } from "./browser-panel";
import {
  ChatFeed,
  Composer,
  ConnectionDot,
  Pending,
  useColorMode
} from "./chat-ui";
import {
  AgentTurn,
  groupTurns,
  messageText,
  resultsById,
  TurnError,
  UserMessage,
  type ZoomImage
} from "./messages";
import { MODEL_ID } from "./shared";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

const SESSION_KEY = "browser-tool-session";

const SUGGESTIONS = [
  {
    title: "Build the demo site",
    prompt:
      "Build the site the docs describe, run it on the dev server, and show it to me in your browser."
  },
  {
    title: "Preview a production build",
    prompt:
      "Make a production build of the site and open it on files.internal. Check the Launch button still works."
  },
  {
    title: "Try vinext",
    prompt:
      "In /workspace, run `npm create vinext-app@latest vinext-app -- --yes --use-npm --platform node --disable-git`. Set up its dev server for preview.internal the way the docs say, start it, and show me the home page."
  }
];

function getSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function EmptyState({
  disabled,
  onPick
}: {
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-kumo-tint text-kumo-brand">
          <CompassIcon size={20} weight="duotone" />
        </div>
        <h2 className="text-xl font-semibold text-kumo-default">
          What should the agent build?
        </h2>
        <p className="max-w-md text-sm text-kumo-subtle">
          It builds in a container and checks its work in a browser that can
          open sites nobody else can reach:
        </p>
        <div className="flex flex-wrap justify-center gap-1.5">
          {HOSTS.map(({ host }) => (
            <HostChip key={host} host={host} />
          ))}
        </div>
      </div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            disabled={disabled}
            onClick={() => onPick(suggestion.prompt)}
            className="flex flex-col gap-1 rounded-xl bg-kumo-base p-3 text-left ring-1 ring-kumo-line hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="text-sm font-medium text-kumo-default">
              {suggestion.title}
            </span>
            <span className="line-clamp-2 text-xs text-kumo-subtle">
              {suggestion.prompt}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Asks before a new chat replaces the current one. */
function NewChatDialog({
  open,
  onOpenChange,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={onOpenChange}>
      <Dialog className="flex flex-col gap-4 px-5 py-4 sm:w-[26rem]">
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="text-base font-semibold text-kumo-default">
            Start a new chat?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            This replaces the current chat with a new agent that has an empty
            workspace and a fresh browser. You can't go back to this
            conversation or its files.
          </Dialog.Description>
        </div>
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button variant="secondary" />}>
            Cancel
          </Dialog.Close>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Start new chat
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

/** A screenshot at full size. */
function ImageDialog({
  image,
  open,
  onOpenChange
}: {
  image: ZoomImage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[min(72rem,calc(100vw-2rem))]">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line py-2 pr-2 pl-4">
          <Dialog.Title className="text-sm font-medium text-kumo-default">
            {image?.alt ?? "Screenshot"}
          </Dialog.Title>
          <Dialog.Close
            render={
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                aria-label="Close"
                icon={<XIcon size={14} />}
              />
            }
          />
        </div>
        <div className="min-h-0 overflow-auto bg-kumo-recessed p-2">
          {image ? (
            <img
              src={image.src}
              alt={image.alt}
              className="mx-auto block h-auto max-w-full bg-white"
            />
          ) : null}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState("");
  const [mode, toggleMode] = useColorMode();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  // Narrow screens only: the browser covers the chat while open.
  const [browserOpen, setBrowserOpen] = useState(false);
  // Kept after closing, so the dialog has its image while it animates out.
  const [zoom, setZoom] = useState<ZoomImage | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);

  const {
    status,
    messages,
    live,
    running,
    tools: runningTools,
    catalog,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession(session);
  const browser = useBrowserState(session, running);

  const connected = status === "open";
  const transcript = live ? [...messages, live] : messages;
  const turns = groupTurns(transcript);
  const results = resultsById(transcript);
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const empty = transcript.length === 0 && !running;
  // Something is happening, but nothing on screen shows it yet.
  const waiting =
    running &&
    runningTools.length === 0 &&
    (live === null || live.parts.length === 0);

  /** Idle: starts a turn. Busy: queued as a follow-up, or steers the turn. */
  const send = (text: string, whenBusy: "followUp" | "steer" = "followUp") => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    setPrompt("");
    submitPrompt(trimmed, whenBusy);
  };

  const newChat = () => {
    const next = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
  };

  const zoomImage = (image: ZoomImage) => {
    setZoom(image);
    setZoomOpen(true);
  };

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-kumo-base">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-sm font-semibold whitespace-nowrap text-kumo-default">
              Browser tool
            </h1>
            <span
              className="hidden truncate text-sm text-kumo-subtle sm:inline"
              title={`Workers AI model: ${MODEL_ID}`}
            >
              pi · {MODEL_ID.split("/").at(-1)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <ConnectionDot
              status={
                connected
                  ? "connected"
                  : status === "connecting"
                    ? "connecting"
                    : "disconnected"
              }
            />
            <div className="mx-2 h-4 w-px bg-kumo-line" />
            {/* Narrow screens show icons only; the tooltip names each one. */}
            <Tooltip
              content="Show the agent's browser"
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="lg:hidden"
                  aria-label="Browser"
                  icon={<AppWindowIcon size={14} />}
                  onClick={() => setBrowserOpen(true)}
                />
              }
            >
              <span className="hidden sm:inline">Browser</span>
            </Tooltip>
            <Tooltip
              content="What this demo does, and the agent's tools"
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="How it works"
                  icon={<InfoIcon size={14} />}
                  onClick={() => setAboutOpen(true)}
                />
              }
            >
              <span className="hidden sm:inline">How it works</span>
            </Tooltip>
            <Tooltip
              content="Replace this chat with a new agent, workspace, and browser"
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="New chat"
                  icon={<NotePencilIcon size={14} />}
                  disabled={empty}
                  onClick={() => setNewChatOpen(true)}
                />
              }
            >
              <span className="hidden sm:inline">New chat</span>
            </Tooltip>
            <Tooltip
              content={
                mode === "light"
                  ? "Switch to dark mode"
                  : "Switch to light mode"
              }
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  shape="square"
                  aria-label={
                    mode === "light"
                      ? "Switch to dark mode"
                      : "Switch to light mode"
                  }
                  icon={
                    mode === "light" ? (
                      <MoonIcon size={14} />
                    ) : (
                      <SunIcon size={14} />
                    )
                  }
                  onClick={toggleMode}
                />
              }
            />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
            <ChatFeed userMessageCount={userMessageCount}>
              {empty ? (
                <EmptyState disabled={!connected} onPick={send} />
              ) : (
                turns.map((turn, index) => {
                  switch (turn.kind) {
                    case "user":
                      return (
                        <UserMessage key={turn.message.id}>
                          {messageText(turn.message)}
                        </UserMessage>
                      );
                    case "notice":
                      return (
                        <p
                          key={turn.message.id}
                          className="text-center text-xs text-kumo-inactive"
                        >
                          {messageText(turn.message)}
                        </p>
                      );
                    case "agent": {
                      const last = index === turns.length - 1;
                      return (
                        <AgentTurn
                          key={turn.id}
                          messages={turn.messages}
                          results={results}
                          runningTools={runningTools}
                          turnRunning={running && last}
                          streaming={live !== null && last}
                          onZoom={zoomImage}
                        />
                      );
                    }
                  }
                })
              )}
              {waiting ? (
                <Pending
                  label={retry ? `Retrying: ${retry.error}` : "Thinking…"}
                />
              ) : null}
              {queued > 0 ? (
                <p className="text-xs text-kumo-subtle">
                  {queued === 1
                    ? "1 message queued after this turn"
                    : `${queued} messages queued after this turn`}
                </p>
              ) : null}
              {error ? <TurnError message={error} /> : null}
            </ChatFeed>
            {/* `relative` keeps the composer's ring above the feed's fade. */}
            <div className="relative mx-auto w-full max-w-3xl px-4 pt-1 pb-3 sm:px-6">
              <Composer
                value={prompt}
                onChange={setPrompt}
                onSubmit={() => send(prompt)}
                onSteer={() => send(prompt, "steer")}
                onStop={abort}
                busy={running}
                disabled={!connected}
                placeholder={
                  running
                    ? "Queue a follow-up, or steer this turn…"
                    : "Ask the agent to build something…"
                }
              />
              <div className="mt-2 flex items-center justify-center gap-3">
                <span className="hidden text-xs text-kumo-inactive sm:inline">
                  {running
                    ? "Enter queues a follow-up · Steer sends it into this turn"
                    : "Enter to send · Shift+Enter for a new line"}
                </span>
                <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
              </div>
            </div>
          </main>

          {/* Wide screens: always beside the chat. Narrow screens: opened
              from the header, covering the chat. Stays mounted either way,
              so Live View doesn't reload. */}
          <aside
            aria-label="Browser"
            className={`${
              browserOpen ? "fixed inset-0 z-40 flex" : "hidden"
            } flex-col lg:static lg:z-auto lg:flex lg:w-[52%] lg:max-w-[60rem] lg:shrink-0 lg:border-l lg:border-kumo-line`}
          >
            <BrowserPanel
              state={browser.state}
              busy={browser.busy}
              error={browser.error}
              onRefresh={() => void browser.refresh()}
              onCloseBrowser={() => void browser.close()}
              onClose={() => setBrowserOpen(false)}
            />
          </aside>
        </div>

        <AboutDialog
          open={aboutOpen}
          onOpenChange={setAboutOpen}
          tools={catalog}
          activeTools={runningTools.map((tool) => tool.name)}
        />
        <NewChatDialog
          open={newChatOpen}
          onOpenChange={setNewChatOpen}
          onConfirm={newChat}
        />
        <ImageDialog image={zoom} open={zoomOpen} onOpenChange={setZoomOpen} />
      </div>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
