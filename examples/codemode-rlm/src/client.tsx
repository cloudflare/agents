import {
  Banner,
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
  ArrowClockwiseIcon,
  BrainIcon,
  CircleNotchIcon,
  DatabaseIcon,
  GearIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  SunIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import {
  useRlmSession,
  type ActiveTurn,
  type FailedTurn
} from "./use-rlm-session";
import "./styles.css";

const SESSION_KEY = "codemode-rlm:session";
const TOKEN_KEY = "codemode-rlm:token";
const MAX_INPUT_CHARS = 20_000_000;
const AUTH_REQUIRED = !import.meta.env.DEV;

type Connection = {
  session: string;
  token: string;
  revision: number;
};

function stored(kind: "local" | "session", key: string): string {
  try {
    const storage = kind === "local" ? localStorage : sessionStorage;
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function store(kind: "local" | "session", key: string, value: string): void {
  try {
    const storage = kind === "local" ? localStorage : sessionStorage;
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {
    // In-memory settings still work when browser persistence is unavailable.
  }
}

function ModeToggle() {
  const [mode, setMode] = useState(() => stored("local", "theme") || "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    store("local", "theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() =>
        setMode((current) => (current === "light" ? "dark" : "light"))
      }
      icon={mode === "light" ? <MoonIcon size={17} /> : <SunIcon size={17} />}
    />
  );
}

function ConnectionDialog({
  session,
  token,
  authRequired,
  onClose,
  onSave
}: {
  session: string;
  token: string;
  authRequired: boolean;
  onClose: () => void;
  onSave: (session: string, token: string) => void;
}) {
  const [nextSession, setNextSession] = useState(session);
  const [nextToken, setNextToken] = useState(token);

  const valid =
    nextSession.trim().length > 0 &&
    nextSession.trim().length <= 120 &&
    (!authRequired || nextToken.length > 0);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="p-6" size="base">
        <Dialog.Title>{authRequired ? "Connection" : "Session"}</Dialog.Title>
        <Dialog.Description>
          {authRequired
            ? "Enter the Worker's API_TOKEN. It stays in this browser tab."
            : "Choose the durable session to use for local development."}
        </Dialog.Description>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onSave(nextSession.trim(), nextToken);
          }}
        >
          <Input
            label="Session name"
            value={nextSession}
            maxLength={120}
            onChange={(event) => setNextSession(event.currentTarget.value)}
            placeholder="demo"
            autoComplete="off"
          />
          {authRequired && (
            <Input
              label="API token"
              type="password"
              value={nextToken}
              onChange={(event) => setNextToken(event.currentTarget.value)}
              placeholder="Value configured as API_TOKEN"
              autoComplete="off"
            />
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!valid}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

function Message({ kind, content }: { kind: string; content: string }) {
  const user = kind === "user";
  return (
    <div className={`flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={
          user
            ? "max-w-[82%] rounded-2xl rounded-br-md bg-kumo-brand px-4 py-3 text-sm text-kumo-inverse"
            : "w-full max-w-[92%] px-1 py-2 text-sm text-kumo-default"
        }
      >
        {user ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <Streamdown className="sd-theme" controls={false} plugins={{ code }}>
            {content}
          </Streamdown>
        )}
      </div>
    </div>
  );
}

function TurnStatus({
  active,
  failed,
  onRetry
}: {
  active: ActiveTurn | null;
  failed: FailedTurn | null;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <Surface className="max-w-[92%] rounded-xl border border-kumo-danger bg-kumo-danger-tint px-4 py-3">
        <p className="text-sm font-medium text-kumo-danger">Turn failed</p>
        <p className="mt-1 text-sm text-kumo-subtle">{failed.error}</p>
      </Surface>
    );
  }
  if (!active) return null;
  const label =
    active.status === "submitting"
      ? "Admitting durable turn"
      : active.status === "recovering"
        ? "Recovering durable turn"
        : active.status === "admitted"
          ? "Waiting to run"
          : "RLM is thinking";
  return (
    <Surface className="flex max-w-[92%] items-start gap-3 rounded-xl px-4 py-3 ring ring-kumo-line">
      <CircleNotchIcon
        size={17}
        className={`mt-0.5 shrink-0 text-kumo-accent ${active.status === "submitting" && active.notice ? "" : "animate-spin"}`}
      />
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-kumo-subtle">
          {active.notice ??
            "The answer appears after a verified Code Mode completion."}
        </p>
        {active.notice && active.payload && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={onRetry}
            icon={<ArrowClockwiseIcon size={14} />}
          >
            Retry same request
          </Button>
        )}
      </div>
    </Surface>
  );
}

function Chat({
  connection,
  onSettings,
  onAuthRequired
}: {
  connection: Connection;
  onSettings: () => void;
  onAuthRequired: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const {
    history,
    active,
    failed,
    error,
    loading,
    submit,
    retryAdmission,
    dismissError
  } = useRlmSession({
    session: connection.session,
    token: connection.token,
    authRequired: AUTH_REQUIRED,
    connectionRevision: connection.revision,
    onAuthRequired
  });

  const pending = active ?? failed;
  const pendingPersisted = Boolean(
    pending?.inputId &&
    history.some((message) => message.metadata.inputId === pending.inputId)
  );
  const configured = !AUTH_REQUIRED || Boolean(connection.token);
  const overLimit = draft.trim().length + context.length > MAX_INPUT_CHARS;
  const empty = history.length === 0 && !active && !failed;
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length, active?.status, failed]);

  const send = useCallback(() => {
    const task = draft.trim();
    if (!task || active || overLimit) return;
    if (!configured) {
      onSettings();
      return;
    }
    if (!submit(task, context)) return;
    setDraft("");
    setContext("");
    setContextOpen(false);
  }, [active, configured, context, draft, onSettings, overLimit, submit]);

  return (
    <div className="flex h-screen flex-col bg-kumo-base text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Code Mode RLM</p>
            <p className="mt-0.5 truncate text-xs text-kumo-subtle">
              Session: {connection.session}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Connection settings"
              onClick={onSettings}
              icon={<GearIcon size={17} />}
            />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        <div className="chat-scrollbar flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
            <Surface className="mb-4 rounded-xl p-4 ring ring-kumo-line">
              <div className="flex gap-3">
                <InfoIcon
                  size={20}
                  weight="bold"
                  className="mt-0.5 shrink-0 text-kumo-accent"
                />
                <div>
                  <Text size="sm" bold>
                    Context is a variable
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      Large inputs stay durable and connector-addressable. An
                      answer appears only after verified Code Mode completion.
                    </Text>
                  </span>
                </div>
              </div>
            </Surface>
            {error && (
              <Banner
                className="mb-5"
                variant="error"
                description={error}
                action={
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    aria-label="Dismiss error"
                    onClick={dismissError}
                    icon={<XIcon size={14} />}
                  />
                }
              />
            )}

            {empty ? (
              <div className="flex flex-1 items-center justify-center">
                {loading ? (
                  <CircleNotchIcon
                    size={20}
                    className="animate-spin text-kumo-subtle"
                  />
                ) : (
                  <Empty
                    icon={<BrainIcon size={32} weight="duotone" />}
                    title="Treat context as a variable"
                    description="Give the RLM a task and optional source material. It can inspect context programmatically, keep a durable notebook, and recurse through child agents."
                  />
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {history.map((message) => (
                  <Message
                    key={message.id}
                    kind={message.role}
                    content={message.content}
                  />
                ))}
                {pending && !pendingPersisted && (
                  <Message kind="user" content={pending.task} />
                )}
                <TurnStatus
                  active={active}
                  failed={failed}
                  onRetry={retryAdmission}
                />
              </div>
            )}
            <div ref={messagesEnd} />
          </div>
        </div>

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <form
            className="mx-auto w-full max-w-3xl px-4 pt-3 sm:px-6"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            {contextOpen && (
              <InputArea
                className="mb-2 w-full"
                value={context}
                onValueChange={setContext}
                rows={5}
                placeholder="Optional external context (stored durably)"
                disabled={!configured || Boolean(active)}
              />
            )}

            <div className="rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
              <InputArea
                value={draft}
                onValueChange={setDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  configured
                    ? "Ask the RLM to investigate something…"
                    : "Configure a session and API token to begin…"
                }
                disabled={!configured || Boolean(active)}
                rows={2}
                className="w-full !bg-transparent !shadow-none !outline-none !ring-0 focus:!ring-0"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <Button
                  type="button"
                  size="sm"
                  variant={contextOpen ? "secondary" : "ghost"}
                  onClick={() => setContextOpen((current) => !current)}
                  disabled={!configured || Boolean(active)}
                  icon={<DatabaseIcon size={14} />}
                >
                  Context
                  {context.length > 0
                    ? ` (${context.length.toLocaleString()})`
                    : ""}
                </Button>
                <div className="flex items-center gap-3">
                  {overLimit && (
                    <span className="text-xs text-kumo-danger">
                      20 million character limit
                    </span>
                  )}
                  <Button
                    type="submit"
                    shape="square"
                    aria-label="Send message"
                    disabled={
                      !configured ||
                      Boolean(active) ||
                      draft.trim().length === 0 ||
                      overLimit
                    }
                    icon={<PaperPlaneRightIcon size={17} />}
                  />
                </div>
              </div>
            </div>
          </form>
          <div className="flex justify-center py-3">
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </main>
    </div>
  );
}

function App() {
  const [connection, setConnection] = useState<Connection>(() => ({
    session: stored("local", SESSION_KEY) || "demo",
    token: AUTH_REQUIRED ? stored("session", TOKEN_KEY) : "",
    revision: 0
  }));
  const [settingsOpen, setSettingsOpen] = useState(
    AUTH_REQUIRED && !connection.token
  );
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const saveConnection = useCallback((session: string, token: string) => {
    store("local", SESSION_KEY, session);
    store("session", TOKEN_KEY, token);
    setConnection((current) => ({
      session,
      token,
      revision: current.revision + 1
    }));
    setSettingsOpen(false);
  }, []);

  return (
    <>
      <Chat
        key={connection.session}
        connection={connection}
        onSettings={openSettings}
        onAuthRequired={openSettings}
      />
      {settingsOpen && (
        <ConnectionDialog
          session={connection.session}
          token={connection.token}
          authRequired={AUTH_REQUIRED}
          onClose={() => setSettingsOpen(false)}
          onSave={saveConnection}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
