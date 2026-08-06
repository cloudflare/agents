import {
  Badge,
  Button,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  BrainIcon,
  CaretDownIcon,
  CircleNotchIcon,
  CodeIcon,
  DatabaseIcon,
  GearIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  ShieldCheckIcon,
  SunIcon,
  TreeStructureIcon,
  XIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import {
  RlmApi,
  RlmApiError,
  type ChildRecord,
  type ExecutionRecord,
  type HistoryMessage,
  type SessionSummary
} from "./api";
import "./styles.css";

const SESSION_KEY = "codemode-rlm:session";
const TOKEN_KEY = "codemode-rlm:token";
const MAX_INPUT_CHARS = 20_000_000;
const ACTIVE_TASK_PREVIEW_CHARS = 2_000;

type ActiveTurn = {
  requestId: string;
  inputId: string;
  task: string;
  status: "submitting" | "admitted" | "running";
  context?: string;
};

type FailedTurn = {
  requestId: string;
  error: string;
};

function activeKey(session: string): string {
  return `codemode-rlm:active:${session}`;
}

function readActive(session: string): ActiveTurn | null {
  try {
    const raw = sessionStorage.getItem(activeKey(session));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ActiveTurn>;
    if (
      typeof value.requestId !== "string" ||
      typeof value.inputId !== "string" ||
      typeof value.task !== "string" ||
      (value.status !== "admitted" && value.status !== "running")
    ) {
      return null;
    }
    return value as ActiveTurn;
  } catch {
    return null;
  }
}

function writeActive(session: string, active: ActiveTurn | null): void {
  const key = activeKey(session);
  try {
    if (!active) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(
      key,
      JSON.stringify({
        requestId: active.requestId,
        inputId: active.inputId,
        task: active.task.slice(0, ACTIVE_TASK_PREVIEW_CHARS),
        status: active.status
      })
    );
  } catch {
    // Browser-side recovery is best effort in storage-constrained contexts;
    // this does not affect the already-durable server request.
  }
}

function messageInputId(message: HistoryMessage): string | undefined {
  return typeof message.metadata.inputId === "string"
    ? message.metadata.inputId
    : undefined;
}

function statusTone(status: string): string {
  if (status === "completed") return "text-green-500";
  if (status === "error" || status === "interrupted") return "text-red-500";
  return "text-amber-500";
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
      onClick={() =>
        setMode((current) => (current === "light" ? "dark" : "light"))
      }
      icon={mode === "light" ? <MoonIcon size={17} /> : <SunIcon size={17} />}
    />
  );
}

function SettingsPanel({
  session,
  token,
  onClose,
  onSave
}: {
  session: string;
  token: string;
  onClose: () => void;
  onSave: (session: string, token: string) => void;
}) {
  const [nextSession, setNextSession] = useState(session);
  const [nextToken, setNextToken] = useState(token);
  const valid =
    nextSession.trim().length > 0 && nextSession.trim().length <= 120;

  return (
    <>
      <button
        type="button"
        aria-label="Close settings"
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-[25rem] max-w-[92vw] flex-col border-l border-kumo-line bg-kumo-base shadow-2xl">
        <div className="flex items-center justify-between border-b border-kumo-line px-5 py-4">
          <div>
            <Text size="lg" bold>
              Connection
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                Select a durable session and authenticate this browser tab.
              </Text>
            </span>
          </div>
          <Button
            variant="ghost"
            shape="square"
            aria-label="Close settings"
            onClick={onClose}
            icon={<XIcon size={17} />}
          />
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-kumo-default">
              Session name
            </span>
            <input
              value={nextSession}
              maxLength={120}
              onChange={(event) => setNextSession(event.currentTarget.value)}
              className="w-full rounded-lg border border-kumo-line bg-kumo-surface px-3 py-2.5 text-sm text-kumo-default outline-none focus:ring-2 focus:ring-kumo-ring"
              placeholder="demo"
              autoComplete="off"
            />
            <span className="block text-xs text-kumo-subtle">
              Session names route to independent durable RLM state.
            </span>
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-kumo-default">
              API token
            </span>
            <input
              type="password"
              value={nextToken}
              onChange={(event) => setNextToken(event.currentTarget.value)}
              className="w-full rounded-lg border border-kumo-line bg-kumo-surface px-3 py-2.5 text-sm text-kumo-default outline-none focus:ring-2 focus:ring-kumo-ring"
              placeholder="Value configured as API_TOKEN"
              autoComplete="off"
            />
            <span className="block text-xs text-kumo-subtle">
              Kept only in this tab&apos;s session storage. It is never bundled
              into the Vite application.
            </span>
          </label>

          <Surface className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
            <div className="flex gap-3">
              <ShieldCheckIcon
                size={19}
                className="mt-0.5 shrink-0 text-amber-500"
              />
              <Text size="xs" variant="secondary">
                This is a single-operator example. The same token can submit
                work and call administrative harness routes; use separate roles
                in a multi-user deployment.
              </Text>
            </div>
          </Surface>
        </div>

        <div className="flex justify-end gap-2 border-t border-kumo-line px-5 py-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => onSave(nextSession.trim(), nextToken)}
          >
            Save
          </Button>
        </div>
      </aside>
    </>
  );
}

function ActivityPanel({
  summary,
  childAgents,
  executions
}: {
  summary: SessionSummary | null;
  childAgents: ChildRecord[];
  executions: ExecutionRecord[];
}) {
  return (
    <aside className="chat-scrollbar hidden w-72 shrink-0 overflow-y-auto border-l border-kumo-line bg-kumo-surface/40 px-4 py-5 lg:block">
      <div className="space-y-6">
        <section>
          <div className="mb-3 flex items-center gap-2">
            <CodeIcon size={15} className="text-kumo-accent" />
            <Text size="sm" bold>
              Runtime
            </Text>
          </div>
          <Surface className="space-y-3 rounded-xl p-3 ring ring-kumo-line">
            <div>
              <p className="text-xs text-kumo-subtle">Model</p>
              <p className="mt-1 break-all font-mono text-xs text-kumo-default">
                {summary?.model ?? "—"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-kumo-subtle">Model tools</p>
                <p className="mt-1 font-medium">
                  {summary?.modelFacingTools.join(", ") ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-kumo-subtle">Max depth</p>
                <p className="mt-1 font-medium">
                  {summary?.limits.maxDepth ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-kumo-subtle">Max calls</p>
                <p className="mt-1 font-medium">
                  {summary?.limits.maxRlmCalls ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-kumo-subtle">Harness rev</p>
                <p className="mt-1 font-medium">
                  {summary?.harness.revision ?? 0}
                </p>
              </div>
            </div>
          </Surface>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <TreeStructureIcon size={15} className="text-kumo-accent" />
            <Text size="sm" bold>
              Retained children
            </Text>
          </div>
          <div className="space-y-2">
            {childAgents.length === 0 ? (
              <Text size="xs" variant="secondary">
                No child agents yet.
              </Text>
            ) : (
              childAgents.slice(0, 6).map((child) => (
                <Surface
                  key={child.id}
                  className="rounded-lg p-3 ring ring-kumo-line"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {child.name}
                    </span>
                    <span
                      className={`size-2 shrink-0 rounded-full bg-current ${statusTone(child.status)}`}
                    />
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-kumo-subtle">
                    {child.mode} · {child.status}
                  </p>
                </Surface>
              ))
            )}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <DatabaseIcon size={15} className="text-kumo-accent" />
            <Text size="sm" bold>
              Code executions
            </Text>
          </div>
          <div className="space-y-2">
            {executions.length === 0 ? (
              <Text size="xs" variant="secondary">
                No executions yet.
              </Text>
            ) : (
              executions.slice(0, 8).map((execution) => (
                <div
                  key={execution.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-kumo-line px-3 py-2"
                >
                  <span className="truncate font-mono text-[11px] text-kumo-subtle">
                    {execution.id}
                  </span>
                  <Badge>{execution.status}</Badge>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}

function ChatMessage({
  message,
  override
}: {
  message: HistoryMessage;
  override?: string;
}) {
  const user = message.role === "user";
  return (
    <div className={`flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={
          user
            ? "max-w-[82%] rounded-2xl rounded-br-md bg-kumo-brand px-4 py-3 text-sm text-white"
            : "w-full max-w-[92%] px-1 py-2 text-sm text-kumo-default"
        }
      >
        {user ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <Streamdown className="sd-theme" controls={false}>
            {override ?? message.content}
          </Streamdown>
        )}
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState(
    () => localStorage.getItem(SESSION_KEY) || "demo"
  );
  const [token, setToken] = useState(
    () => sessionStorage.getItem(TOKEN_KEY) || ""
  );
  const [settingsOpen, setSettingsOpen] = useState(() => !token);
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [children, setChildren] = useState<ChildRecord[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [active, setActive] = useState<ActiveTurn | null>(() =>
    readActive(session)
  );
  const [failed, setFailed] = useState<FailedTurn | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const viewGeneration = useRef(0);
  const viewVersion = viewGeneration.current;

  const api = useMemo(
    () => (token ? new RlmApi(session, token) : null),
    [session, token]
  );

  const refreshHistory = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    const nextHistory = await api.history();
    if (viewGeneration.current !== viewVersion) return false;
    setHistory(nextHistory);
    return true;
  }, [api, viewVersion]);

  const refreshInspection = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    const [nextSummary, nextChildren, nextExecutions] = await Promise.all([
      api.summary(),
      api.children(),
      api.executions()
    ]);
    if (viewGeneration.current !== viewVersion) return false;
    setSummary(nextSummary);
    setChildren(nextChildren);
    setExecutions(nextExecutions);
    return true;
  }, [api, viewVersion]);

  useEffect(() => {
    setHistory([]);
    setSummary(null);
    setChildren([]);
    setExecutions([]);
    setFailed(null);
    setAnswers({});
    setAdmissionError(null);
    setActive(readActive(session));
  }, [session]);

  useEffect(() => {
    if (!api) return;
    const loadingView = viewVersion;
    setLoading(true);
    setError(null);
    void Promise.all([refreshHistory(), refreshInspection()])
      .catch((cause: unknown) => {
        if (viewGeneration.current !== loadingView) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (cause instanceof RlmApiError && cause.status === 401) {
          setSettingsOpen(true);
        }
      })
      .finally(() => {
        if (viewGeneration.current === loadingView) setLoading(false);
      });
  }, [api, refreshHistory, refreshInspection, viewVersion]);

  useEffect(() => {
    const current = active;
    if (!api || !current || current.status === "submitting") return;
    const requestId = current.requestId;
    const pollingView = viewVersion;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const result = await api.request(requestId);
        if (cancelled || viewGeneration.current !== pollingView) return;
        await refreshHistory();
        if (cancelled || viewGeneration.current !== pollingView) return;
        if (result.status === "completed") {
          if (result.answer) {
            setAnswers((current) => ({
              ...current,
              [result.inputId]: result.answer as string
            }));
          }
          writeActive(session, null);
          setActive(null);
          setFailed(null);
          setAdmissionError(null);
          await refreshInspection();
          return;
        }
        if (result.status === "error") {
          writeActive(session, null);
          setActive(null);
          setAdmissionError(null);
          setFailed({
            requestId,
            error: result.error || "The RLM turn failed."
          });
          await refreshInspection();
          return;
        }
        const next: ActiveTurn = {
          requestId,
          inputId: result.inputId,
          task: current.task,
          status: result.status
        };
        writeActive(session, next);
        setActive((existing) =>
          existing?.inputId === next.inputId &&
          existing.status === next.status &&
          existing.task === next.task
            ? existing
            : next
        );
        setAdmissionError(null);
        setError(null);
        timer = window.setTimeout(
          () => void poll(),
          document.hidden ? 2_500 : 1_000
        );
      } catch (cause) {
        if (cancelled || viewGeneration.current !== pollingView) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (
          cause instanceof RlmApiError &&
          (cause.status === 401 || cause.status === 503)
        ) {
          setError(message);
          setSettingsOpen(true);
          return;
        }
        if (
          cause instanceof RlmApiError &&
          cause.status >= 400 &&
          cause.status < 500
        ) {
          writeActive(session, null);
          setActive(null);
          setAdmissionError(null);
          setError(null);
          setFailed({
            requestId,
            error: `Unable to resume the durable request: ${message}`
          });
          return;
        }
        setError(message);
        timer = window.setTimeout(() => void poll(), 2_500);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, api, refreshHistory, refreshInspection, session, viewVersion]);

  const chatHistory = useMemo(
    () =>
      [...history]
        .filter(
          (message) => message.role === "user" || message.role === "assistant"
        )
        .reverse(),
    [history]
  );

  const persistedInputIds = useMemo(
    () => new Set(chatHistory.map(messageInputId).filter(Boolean)),
    [chatHistory]
  );
  const activePersisted = Boolean(
    active?.inputId && persistedInputIds.has(active.inputId)
  );

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory.length, active?.status, failed]);

  async function admit(turn: ActiveTurn) {
    if (!api) return;
    const admissionView = viewVersion;
    setAdmissionError(null);
    try {
      const result = await api.submit(
        turn.requestId,
        turn.task,
        turn.context ?? ""
      );
      if (viewGeneration.current !== admissionView) return;
      if (result.status === "completed") {
        if (result.answer) {
          setAnswers((current) => ({
            ...current,
            [result.inputId]: result.answer as string
          }));
        }
        writeActive(session, null);
        setActive(null);
        setAdmissionError(null);
        await Promise.all([refreshHistory(), refreshInspection()]);
        return;
      }
      if (result.status === "error") {
        writeActive(session, null);
        setActive(null);
        setAdmissionError(null);
        setFailed({
          requestId: turn.requestId,
          error: result.error || "The RLM turn failed."
        });
        await refreshHistory();
        return;
      }
      const admitted: ActiveTurn = {
        requestId: turn.requestId,
        inputId: result.inputId,
        task: turn.task,
        status: result.status
      };
      writeActive(session, admitted);
      setActive(admitted);
      await refreshHistory();
    } catch (cause) {
      if (viewGeneration.current !== admissionView) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const retryable =
        !(cause instanceof RlmApiError) ||
        cause.status >= 500 ||
        cause.status === 401;
      if (!retryable) {
        setActive(null);
        setDraft(turn.task);
        setContext(turn.context ?? "");
        setContextOpen(Boolean(turn.context));
        setError(message);
        return;
      }
      setAdmissionError(
        `Admission outcome is unknown: ${message}. Retry with the same request ID and unchanged payload.`
      );
      if (
        cause instanceof RlmApiError &&
        (cause.status === 401 || cause.status === 503)
      ) {
        setSettingsOpen(true);
      }
    }
  }

  async function send() {
    const task = draft.trim();
    if (!task || !api || active) {
      if (!api) setSettingsOpen(true);
      return;
    }
    if (task.length + context.length > MAX_INPUT_CHARS) {
      setError("Task and context may contain at most 20 million characters.");
      return;
    }

    const next: ActiveTurn = {
      requestId: crypto.randomUUID(),
      inputId: "",
      task,
      context,
      status: "submitting"
    };
    setActive(next);
    setFailed(null);
    setError(null);
    setAdmissionError(null);
    setDraft("");
    setContext("");
    setContextOpen(false);
    await admit(next);
  }

  function saveSettings(nextSession: string, nextToken: string) {
    if (nextSession !== session || nextToken !== token) {
      viewGeneration.current += 1;
    }
    try {
      localStorage.setItem(SESSION_KEY, nextSession);
    } catch {
      // The in-memory session still works when browser persistence is blocked.
    }
    try {
      if (nextToken) sessionStorage.setItem(TOKEN_KEY, nextToken);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Keep the token in React state for the lifetime of this page.
    }
    setSession(nextSession);
    setToken(nextToken);
    setSettingsOpen(false);
    setError(null);
  }

  const configured = Boolean(api);
  const empty = chatHistory.length === 0 && !active;
  const connectionStatus =
    active?.status ??
    (error ? "error" : summary ? "ready" : configured ? "connecting" : "setup");

  return (
    <div className="flex h-screen flex-col bg-kumo-base text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-500 ring ring-purple-500/20">
              <BrainIcon size={20} weight="duotone" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Text size="sm" bold>
                  Code Mode RLM
                </Text>
                <Badge>{connectionStatus}</Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-kumo-subtle">
                Session: {session}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Connection settings"
              onClick={() => setSettingsOpen(true)}
              icon={<GearIcon size={17} />}
            />
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="chat-scrollbar flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
              {error && (
                <Surface className="mb-5 rounded-xl border border-red-500/25 bg-red-500/5 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <Text size="xs" variant="error">
                      {error}
                    </Text>
                    <button
                      type="button"
                      aria-label="Dismiss error"
                      className="text-kumo-subtle hover:text-kumo-default"
                      onClick={() => setError(null)}
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                </Surface>
              )}

              {empty ? (
                <div className="flex flex-1 items-center justify-center py-12">
                  <div className="max-w-lg text-center">
                    <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-purple-500/10 text-purple-500 ring ring-purple-500/20">
                      <BrainIcon size={29} weight="duotone" />
                    </div>
                    <div className="mt-5">
                      <Text size="lg" bold>
                        Treat context as a variable
                      </Text>
                    </div>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-kumo-subtle">
                      Give the RLM a task and optional source material. It can
                      inspect that context programmatically, keep a durable JSON
                      notebook, and recurse through retained child agents.
                    </p>
                    {!configured && (
                      <Button
                        className="mt-5"
                        onClick={() => setSettingsOpen(true)}
                        icon={<GearIcon size={16} />}
                      >
                        Configure connection
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {chatHistory.map((message) => {
                    const inputId = messageInputId(message);
                    return (
                      <ChatMessage
                        key={message.id}
                        message={message}
                        override={inputId ? answers[inputId] : undefined}
                      />
                    );
                  })}

                  {active && !activePersisted && (
                    <div className="flex justify-end">
                      <div className="max-w-[82%] rounded-2xl rounded-br-md bg-kumo-brand px-4 py-3 text-sm text-white">
                        <p className="whitespace-pre-wrap">{active.task}</p>
                      </div>
                    </div>
                  )}

                  {active && (
                    <div className="flex justify-start">
                      <Surface className="flex max-w-[92%] items-start gap-3 rounded-xl px-4 py-3 ring ring-kumo-line">
                        <CircleNotchIcon
                          size={17}
                          className={`mt-0.5 shrink-0 text-purple-500 ${admissionError ? "" : "animate-spin"}`}
                        />
                        <div>
                          <p className="text-sm font-medium">
                            {active.status === "submitting"
                              ? "Admitting durable turn"
                              : active.status === "admitted"
                                ? "Waiting to run"
                                : "RLM is thinking"}
                          </p>
                          <p className="mt-0.5 text-xs text-kumo-subtle">
                            {admissionError ??
                              "The answer appears only after a verified Code Mode completion."}
                          </p>
                          {admissionError && active.status === "submitting" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="mt-3"
                              onClick={() => void admit(active)}
                              icon={<ArrowClockwiseIcon size={14} />}
                            >
                              Retry same request
                            </Button>
                          )}
                        </div>
                      </Surface>
                    </div>
                  )}

                  {failed && (
                    <div className="flex justify-start">
                      <Surface className="max-w-[92%] rounded-xl border border-red-500/25 bg-red-500/5 px-4 py-3">
                        <p className="text-sm font-medium text-red-500">
                          Turn failed
                        </p>
                        <p className="mt-1 text-sm text-kumo-subtle">
                          {failed.error}
                        </p>
                        <p className="mt-2 font-mono text-[11px] text-kumo-subtle">
                          request {failed.requestId}
                        </p>
                      </Surface>
                    </div>
                  )}
                </div>
              )}

              {loading && empty && (
                <div className="flex justify-center py-3 text-kumo-subtle">
                  <CircleNotchIcon size={18} className="animate-spin" />
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
                void send();
              }}
            >
              {contextOpen && (
                <Surface className="mb-2 rounded-xl p-3 ring ring-kumo-line">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <DatabaseIcon size={15} className="text-kumo-accent" />
                      <Text size="xs" bold>
                        External context
                      </Text>
                    </div>
                    <span className="text-[11px] tabular-nums text-kumo-subtle">
                      {context.length.toLocaleString()} characters
                    </span>
                  </div>
                  <InputArea
                    value={context}
                    onValueChange={setContext}
                    rows={5}
                    placeholder="Paste large source material here. It is chunked into durable storage rather than inserted into the active model context."
                    disabled={!configured || Boolean(active)}
                  />
                </Surface>
              )}

              <div className="rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
                <InputArea
                  value={draft}
                  onValueChange={setDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    configured
                      ? "Ask the RLM to investigate something…"
                      : "Configure a session and API token to begin…"
                  }
                  disabled={!configured || Boolean(active)}
                  rows={2}
                  className="!bg-transparent !shadow-none !outline-none !ring-0 focus:!ring-0"
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
                    <CaretDownIcon
                      size={12}
                      className={contextOpen ? "rotate-180" : ""}
                    />
                  </Button>
                  <Button
                    type="submit"
                    shape="square"
                    aria-label="Send message"
                    disabled={
                      !configured ||
                      Boolean(active) ||
                      draft.trim().length === 0 ||
                      draft.trim().length + context.length > MAX_INPUT_CHARS
                    }
                    icon={<PaperPlaneRightIcon size={17} />}
                  />
                </div>
              </div>
            </form>
            <div className="flex justify-center py-3">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          </div>
        </main>

        <ActivityPanel
          summary={summary}
          childAgents={children}
          executions={executions}
        />
      </div>

      {settingsOpen && (
        <SettingsPanel
          key={`${session}:${settingsOpen ? "open" : "closed"}`}
          session={session}
          token={token}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
