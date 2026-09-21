import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  ClockIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  StopIcon,
  SunIcon,
  TrayIcon,
  UsersIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import type { AudienceReceipt, BriefRun, NoteReceipt } from "./server";
import "./styles.css";

const STORAGE_KEY = "next-task-events-session-v2";
const MAX_NOTES = 10;
const NOTE_PRESETS = [
  "Lead with the mailbox guarantee.",
  "Mention that consumption is replay-safe.",
  "Call out that receipts confirm durable acceptance."
];
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

type QueuedNote = {
  eventId: string;
  text: string;
  createdAt: number;
};

type NoteAttempt = {
  text: string;
  deliveryId: string;
};

type AudienceAttempt = {
  audience: string;
  decision: string;
};

type StartAttempt = {
  topic: string;
  requestId: string;
};

type StoredSession = {
  version: 2;
  instanceName: string;
  activeRunId: string | null;
  queuedNotes: QueuedNote[];
  pendingStart: StartAttempt | null;
  pendingNote: NoteAttempt | null;
  pendingAudience: AudienceAttempt | null;
  audienceSubmitted: boolean;
};

type Operation = "start" | "note" | "audience" | "cancel" | null;

type UiError = {
  message: string;
  retryableDelivery: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function freshSession(): StoredSession {
  return {
    version: 2,
    instanceName: crypto.randomUUID(),
    activeRunId: null,
    queuedNotes: [],
    pendingStart: null,
    pendingNote: null,
    pendingAudience: null,
    audienceSubmitted: false
  };
}

function resetStoredSession(): StoredSession {
  const session = freshSession();
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

function loadSession(): StoredSession {
  try {
    const parsed: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? ""
    );
    if (
      !isRecord(parsed) ||
      parsed.version !== 2 ||
      typeof parsed.instanceName !== "string"
    ) {
      return resetStoredSession();
    }

    const queuedNotes = Array.isArray(parsed.queuedNotes)
      ? parsed.queuedNotes.flatMap((value): QueuedNote[] => {
          if (
            !isRecord(value) ||
            typeof value.eventId !== "string" ||
            typeof value.text !== "string" ||
            typeof value.createdAt !== "number"
          ) {
            return [];
          }
          return [
            {
              eventId: value.eventId,
              text: value.text,
              createdAt: value.createdAt
            }
          ];
        })
      : [];

    const pendingStart = isRecord(parsed.pendingStart)
      ? typeof parsed.pendingStart.topic === "string" &&
        typeof parsed.pendingStart.requestId === "string"
        ? {
            topic: parsed.pendingStart.topic,
            requestId: parsed.pendingStart.requestId
          }
        : null
      : null;
    const pendingNote = isRecord(parsed.pendingNote)
      ? typeof parsed.pendingNote.text === "string" &&
        typeof parsed.pendingNote.deliveryId === "string"
        ? {
            text: parsed.pendingNote.text,
            deliveryId: parsed.pendingNote.deliveryId
          }
        : null
      : null;
    const pendingAudience = isRecord(parsed.pendingAudience)
      ? typeof parsed.pendingAudience.audience === "string" &&
        typeof parsed.pendingAudience.decision === "string"
        ? {
            audience: parsed.pendingAudience.audience,
            decision: parsed.pendingAudience.decision
          }
        : null
      : null;

    return {
      version: 2,
      instanceName: parsed.instanceName,
      activeRunId:
        typeof parsed.activeRunId === "string" ? parsed.activeRunId : null,
      queuedNotes: queuedNotes.slice(0, MAX_NOTES),
      pendingStart,
      pendingNote,
      pendingAudience,
      audienceSubmitted: parsed.audienceSubmitted === true
    };
  } catch {
    return resetStoredSession();
  }
}

function isTerminal(run: BriefRun | null): boolean {
  return run ? TERMINAL_STATES.has(run.state) : false;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

function runTopic(run: BriefRun): string {
  const topic = run.metadata?.topic;
  return typeof topic === "string" ? topic : "Untitled brief";
}

function stateLabel(run: BriefRun): string {
  if (run.state === "waiting" && run.reason === "event") {
    return "Input needed";
  }
  return run.state.charAt(0).toUpperCase() + run.state.slice(1);
}

function stateVariant(
  run: BriefRun
): "primary" | "secondary" | "success" | "destructive" {
  switch (run.state) {
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "running":
    case "waiting":
      return "primary";
    default:
      return "secondary";
  }
}

function currentPhase(run: BriefRun): number {
  if (run.state === "completed") return 4;
  if (run.state === "failed" || run.state === "cancelled") return 0;
  if (
    run.state === "running" &&
    run.statusMessage?.startsWith("Reviewing") === true
  ) {
    return 2;
  }
  if (run.state === "waiting" && run.reason === "event") return 1;
  return 0;
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

function ConnectionIndicator({
  identified,
  failed
}: {
  identified: boolean;
  failed: boolean;
}) {
  const label = failed
    ? "Unavailable"
    : identified
      ? "Connected"
      : "Connecting";
  return (
    <Badge
      variant={failed ? "destructive" : identified ? "success" : "secondary"}
    >
      <span
        className={`mr-1.5 inline-block size-1.5 rounded-full ${identified ? "bg-kumo-success" : "bg-kumo-inactive"}`}
      />
      {label}
    </Badge>
  );
}

function PhaseRow({
  number,
  title,
  description,
  phase,
  current
}: {
  number: number;
  title: string;
  description: string;
  phase: number;
  current: number;
}) {
  const complete = current > phase;
  const active = current === phase;
  return (
    <li className="flex gap-3" aria-current={active ? "step" : undefined}>
      <div
        className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${complete ? "border-kumo-accent bg-kumo-accent text-white" : active ? "border-kumo-accent text-kumo-accent" : "border-kumo-line text-kumo-subtle"}`}
      >
        {complete ? <CheckCircleIcon size={15} weight="fill" /> : number}
      </div>
      <div className="pb-4">
        <p className="text-sm font-medium text-kumo-default">
          <span className="sr-only">
            {complete ? "Completed: " : active ? "Current: " : "Upcoming: "}
          </span>
          {title}
        </p>
        <p className="mt-0.5 text-xs text-kumo-subtle">{description}</p>
      </div>
    </li>
  );
}

function App() {
  const [session, setSession] = useState(loadSession);
  const [run, setRun] = useState<BriefRun | null>(null);
  const [topic, setTopic] = useState(
    session.pendingStart?.topic ?? "Durable task events"
  );
  const [note, setNote] = useState(session.pendingNote?.text ?? "");
  const [audience, setAudience] = useState(
    session.pendingAudience?.audience ?? "engineering leaders"
  );
  const [decision, setDecision] = useState(
    session.pendingAudience?.decision ?? "whether to adopt this pattern"
  );
  const [operation, setOperation] = useState<Operation>(null);
  const [loadingRun, setLoadingRun] = useState(session.activeRunId !== null);
  const [error, setError] = useState<UiError>();
  const [notice, setNotice] = useState<string>();
  const sessionRef = useRef(session);
  const activeRunRef = useRef(session.activeRunId);
  const refreshSequence = useRef(0);

  const agent = useAgent({
    agent: "task-events-agent",
    name: session.instanceName
  });

  const saveSession = useCallback(
    (update: (current: StoredSession) => StoredSession) => {
      const next = update(sessionRef.current);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      sessionRef.current = next;
      activeRunRef.current = next.activeRunId;
      setSession(next);
    },
    []
  );

  const refreshRun = useCallback(
    async (runId: string, foreground = false) => {
      const request = ++refreshSequence.current;
      if (foreground) setLoadingRun(true);
      try {
        const next = await agent.call<BriefRun | null>("getBrief", [runId]);
        if (
          activeRunRef.current !== runId ||
          refreshSequence.current !== request
        ) {
          return;
        }
        setError((current) =>
          current?.retryableDelivery ? current : undefined
        );
        setRun(next);
        if (!next) {
          saveSession((current) => ({
            ...current,
            activeRunId: null,
            queuedNotes: [],
            pendingNote: null,
            pendingAudience: null,
            audienceSubmitted: false
          }));
          setNotice("The saved run no longer exists. Start a new brief.");
        } else if (isTerminal(next)) {
          saveSession((current) => ({
            ...current,
            pendingNote: null,
            pendingAudience: null
          }));
        }
      } catch (cause) {
        if (refreshSequence.current === request) {
          setError({
            message: cause instanceof Error ? cause.message : String(cause),
            retryableDelivery: false
          });
        }
      } finally {
        if (refreshSequence.current === request) {
          setLoadingRun(false);
        }
      }
    },
    [agent, saveSession]
  );

  useEffect(() => {
    if (!agent.identified || !session.activeRunId) return;
    void refreshRun(session.activeRunId, true);
  }, [agent.identified, refreshRun, session.activeRunId]);

  useEffect(() => {
    const runId = session.activeRunId;
    if (!agent.identified || !runId || isTerminal(run)) return;

    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") await refreshRun(runId);
      if (!stopped) {
        const delay = run?.state === "waiting" ? 2_500 : 1_000;
        timer = window.setTimeout(() => void poll(), delay);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agent.identified, refreshRun, run, session.activeRunId]);

  useEffect(() => {
    const refreshVisibleRun = () => {
      if (
        document.visibilityState === "visible" &&
        agent.identified &&
        activeRunRef.current
      ) {
        void refreshRun(activeRunRef.current);
      }
    };
    document.addEventListener("visibilitychange", refreshVisibleRun);
    return () =>
      document.removeEventListener("visibilitychange", refreshVisibleRun);
  }, [agent.identified, refreshRun]);

  const startBrief = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agent.identified || operation) return;
    const cleanTopic = topic.trim();
    if (!cleanTopic) return;

    const attempt = session.pendingStart ?? {
      topic: cleanTopic,
      requestId: crypto.randomUUID()
    };
    saveSession((current) => ({ ...current, pendingStart: attempt }));
    setOperation("start");
    setError(undefined);
    setNotice(undefined);
    try {
      const receipt = await agent.call<{
        runId: string;
        accepted: boolean;
      }>("startBrief", [attempt.topic, attempt.requestId]);
      setRun(null);
      saveSession((current) => ({
        ...current,
        activeRunId: receipt.runId,
        queuedNotes: [],
        pendingStart: null,
        pendingNote: null,
        pendingAudience: null,
        audienceSubmitted: false
      }));
      setNotice(
        receipt.accepted
          ? "Briefing started. Add editor notes while the Task drafts."
          : "Retry joined the already accepted brief."
      );
      await refreshRun(receipt.runId, true);
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : String(cause),
        retryableDelivery: true
      });
    } finally {
      setOperation(null);
    }
  };

  const sendNote = async (text: string) => {
    const runId = session.activeRunId;
    if (!agent.identified || !runId || operation) return;

    const attempt = session.pendingNote ?? {
      text: text.trim(),
      deliveryId: crypto.randomUUID()
    };
    if (!attempt.text) return;
    saveSession((current) => ({ ...current, pendingNote: attempt }));
    setOperation("note");
    setError(undefined);
    setNotice(undefined);
    try {
      const receipt = await agent.call<NoteReceipt>("sendNote", [
        runId,
        attempt.text,
        attempt.deliveryId
      ]);
      saveSession((current) => ({
        ...current,
        pendingNote: null,
        queuedNotes: current.queuedNotes.some(
          (queued) => queued.eventId === receipt.eventId
        )
          ? current.queuedNotes
          : [
              ...current.queuedNotes,
              {
                eventId: receipt.eventId,
                text: receipt.payload.text,
                createdAt: receipt.createdAt
              }
            ]
      }));
      setNote((current) => (current.trim() === attempt.text ? "" : current));
      setNotice(
        receipt.accepted
          ? "Note durably accepted into the run mailbox."
          : "Retry matched the note already in the mailbox."
      );
      await refreshRun(runId);
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : String(cause),
        retryableDelivery: true
      });
    } finally {
      setOperation(null);
    }
  };

  const deliverReaderContext = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const runId = session.activeRunId;
    if (!agent.identified || !runId || operation) return;

    const attempt = session.pendingAudience ?? {
      audience: audience.trim(),
      decision: decision.trim()
    };
    if (!attempt.audience || !attempt.decision) return;
    saveSession((current) => ({ ...current, pendingAudience: attempt }));
    setOperation("audience");
    setError(undefined);
    setNotice(undefined);
    try {
      const receipt = await agent.call<AudienceReceipt>("answerAudience", [
        runId,
        attempt.audience,
        attempt.decision
      ]);
      saveSession((current) => ({
        ...current,
        pendingAudience: null,
        audienceSubmitted: true
      }));
      setNotice(
        receipt.accepted
          ? "Reader context accepted for the final outline."
          : "Retry matched the reader context already delivered."
      );
      await refreshRun(runId);
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : String(cause),
        retryableDelivery: true
      });
    } finally {
      setOperation(null);
    }
  };

  const cancelBrief = async () => {
    const runId = session.activeRunId;
    if (!agent.identified || !runId || operation) return;
    setOperation("cancel");
    setError(undefined);
    try {
      const cancelled = await agent.call<boolean>("cancelBrief", [runId]);
      setNotice(
        cancelled ? "Cancellation requested." : "The run already settled."
      );
      await refreshRun(runId);
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : String(cause),
        retryableDelivery: false
      });
    } finally {
      setOperation(null);
    }
  };

  const terminal = isTerminal(run);
  const waitingForAudience = run?.state === "waiting" && run.reason === "event";
  const canStart =
    session.activeRunId === null || (run !== null && terminal === true);
  const notesLocked =
    !run ||
    terminal ||
    session.audienceSubmitted ||
    session.pendingAudience !== null ||
    session.queuedNotes.length >= MAX_NOTES;
  const phase = run ? currentPhase(run) : 0;

  return (
    <div className="min-h-screen bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-kumo-accent p-2 text-white">
              <TrayIcon size={20} weight="bold" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Task event desk</h1>
              <p className="text-xs text-kumo-subtle">
                Durable input for an active briefing Task
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionIndicator
              identified={agent.identified}
              failed={agent.connectionError !== null}
            />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-5 py-6">
        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                Agent job: prepare a technical briefing outline
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Give the Agent a topic. Its Task drafts three core sections
                  while editor notes arrive, then pauses for reader context,
                  tailors every section, and reviews the notes in FIFO order.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <Surface className="rounded-xl p-5 ring ring-kumo-line">
          <form
            onSubmit={(event) => void startBrief(event)}
            className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end"
          >
            <label htmlFor="brief-topic">
              <span className="mb-1 block text-xs font-medium text-kumo-subtle">
                Technical briefing topic
              </span>
              <Input
                id="brief-topic"
                value={topic}
                maxLength={120}
                disabled={!canStart || session.pendingStart !== null}
                onChange={(event) => setTopic(event.currentTarget.value)}
                placeholder="What should the briefing explain?"
                required
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !agent.identified ||
                !canStart ||
                operation !== null ||
                topic.trim() === ""
              }
              icon={<PlayIcon size={16} weight="fill" />}
            >
              {operation === "start"
                ? "Starting..."
                : session.pendingStart
                  ? "Retry start"
                  : "Start brief"}
            </Button>
          </form>
          {run && !terminal ? (
            <p className="mt-3 text-xs text-kumo-subtle">
              Finish or cancel the current briefing before starting another.
            </p>
          ) : null}
        </Surface>

        {error ? (
          <Surface
            className="rounded-xl p-4 ring ring-kumo-danger"
            role="alert"
          >
            <p className="text-sm font-medium text-kumo-danger">
              {error.message}
            </p>
            {error.retryableDelivery ? (
              <p className="mt-1 text-xs text-kumo-subtle">
                Retry keeps the same delivery key, so an ambiguous response does
                not create a duplicate event.
              </p>
            ) : null}
          </Surface>
        ) : null}

        {notice ? (
          <output aria-live="polite" className="block text-xs text-kumo-subtle">
            {notice}
          </output>
        ) : null}
        <output aria-live="polite" className="block text-xs text-kumo-subtle">
          {run
            ? `Task status: ${stateLabel(run)}${"statusMessage" in run && run.statusMessage ? `. ${run.statusMessage}` : ""}`
            : " "}
        </output>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)]">
          <Surface className="rounded-xl p-5 ring ring-kumo-line">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <Text size="sm" bold>
                  Technical briefing Task
                </Text>
                <p className="mt-1 text-xs text-kumo-subtle">
                  The snapshot below is read from durable Task state.
                </p>
              </div>
              {run ? (
                <div className="flex items-center gap-2">
                  <Badge variant={stateVariant(run)}>{stateLabel(run)}</Badge>
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Refresh task run"
                    disabled={!agent.identified || operation !== null}
                    onClick={() =>
                      session.activeRunId &&
                      void refreshRun(session.activeRunId, true)
                    }
                    icon={<ArrowClockwiseIcon size={16} />}
                  />
                </div>
              ) : null}
            </div>

            {loadingRun && !run ? (
              <div className="py-12 text-center text-sm text-kumo-subtle">
                Loading durable run...
              </div>
            ) : !run ? (
              <Empty
                icon={<ClockIcon size={24} />}
                title="No briefing in progress"
                description="Start a briefing to watch the Task draft, collect input, and tailor its outline."
              />
            ) : (
              <div className="space-y-5">
                <div className="rounded-lg border border-kumo-line bg-kumo-elevated p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="break-words font-semibold">
                        {runTopic(run)}
                      </h2>
                      <p className="mt-1 break-all font-mono text-xs text-kumo-subtle">
                        {run.runId}
                      </p>
                    </div>
                    {!terminal ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!agent.identified || operation !== null}
                        onClick={() => void cancelBrief()}
                        icon={<StopIcon size={14} weight="fill" />}
                      >
                        {operation === "cancel" ? "Cancelling..." : "Cancel"}
                      </Button>
                    ) : null}
                  </div>
                  {"statusMessage" in run && run.statusMessage ? (
                    <p className="mt-3 break-words rounded-md bg-kumo-base px-3 py-2 text-sm">
                      {run.statusMessage}
                    </p>
                  ) : null}
                </div>

                {run.state !== "failed" && run.state !== "cancelled" ? (
                  <ol aria-label="Task progress">
                    <PhaseRow
                      number={1}
                      title="Draft core outline"
                      description="The Task works for eight seconds while editor note events arrive."
                      phase={0}
                      current={phase}
                    />
                    <PhaseRow
                      number={2}
                      title="Add reader context"
                      description="waitForEvent() pauses until the Task knows who will read the brief and what they need to decide."
                      phase={1}
                      current={phase}
                    />
                    <PhaseRow
                      number={3}
                      title="Review editor notes"
                      description="takeEvents() consumes the buffered notes in FIFO order."
                      phase={2}
                      current={phase}
                    />
                    <PhaseRow
                      number={4}
                      title="Finalize briefing"
                      description="Every section uses the reader context, and the result retains each consumed event."
                      phase={3}
                      current={phase}
                    />
                  </ol>
                ) : null}

                {run.state === "completed" ? (
                  <div className="space-y-4 rounded-xl border border-kumo-line bg-kumo-base p-4">
                    <div className="flex items-center gap-2">
                      <CheckCircleIcon
                        size={18}
                        weight="fill"
                        className="text-kumo-success"
                      />
                      <h3 className="font-semibold">
                        Technical briefing outline
                      </h3>
                    </div>
                    <p className="break-words text-sm">{run.result.summary}</p>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
                        Reader and decision context
                      </p>
                      <div className="mt-2 rounded-lg border border-kumo-line p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <UsersIcon size={16} className="text-kumo-accent" />
                          <span className="break-words text-sm font-medium">
                            {run.result.audience.payload.audience}
                          </span>
                          <time
                            className="text-xs text-kumo-subtle"
                            dateTime={new Date(
                              run.result.audience.createdAt
                            ).toISOString()}
                          >
                            received {formatTime(run.result.audience.createdAt)}
                          </time>
                        </div>
                        <p className="mt-2 break-words text-sm text-kumo-subtle">
                          <span className="font-medium text-kumo-default">
                            Decision to support:
                          </span>{" "}
                          {run.result.audience.payload.decision}
                        </p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
                        Audience-tailored sections
                      </p>
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                        {run.result.research.map((item) => (
                          <li key={item} className="break-words">
                            {item}
                          </li>
                        ))}
                      </ol>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
                        Editor notes reviewed later
                      </p>
                      {run.result.notes.length === 0 ? (
                        <p className="mt-2 text-sm text-kumo-subtle">
                          No notes were queued.
                        </p>
                      ) : (
                        <ol className="mt-2 space-y-2">
                          {run.result.notes.map((item, index) => (
                            <li
                              key={item.eventId}
                              className="rounded-lg border border-kumo-line p-3"
                            >
                              <div className="flex justify-between gap-3">
                                <span className="text-xs font-semibold text-kumo-accent">
                                  #{index + 1}
                                </span>
                                <time
                                  className="text-xs text-kumo-subtle"
                                  dateTime={new Date(
                                    item.createdAt
                                  ).toISOString()}
                                >
                                  {formatTime(item.createdAt)}
                                </time>
                              </div>
                              <p className="mt-1 break-words text-sm">
                                {item.payload.text}
                              </p>
                              <p className="mt-2 break-all font-mono text-[10px] text-kumo-subtle">
                                {item.eventId}
                              </p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </div>
                ) : null}

                {run.state === "failed" ? (
                  <div
                    className="rounded-lg border border-kumo-line p-4"
                    role="alert"
                  >
                    <p className="font-medium text-kumo-danger">
                      {run.error.name}
                    </p>
                    <p className="mt-1 text-sm text-kumo-subtle">
                      {run.error.message}
                    </p>
                  </div>
                ) : null}

                {run.state === "cancelled" ? (
                  <p className="rounded-lg border border-kumo-line p-4 text-sm text-kumo-subtle">
                    {run.reason ?? "This run was cancelled."}
                  </p>
                ) : null}
              </div>
            )}
          </Surface>

          <Surface className="rounded-xl p-5 ring ring-kumo-line">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <Text size="sm" bold>
                  Event mailbox
                </Text>
                <p className="mt-1 text-xs text-kumo-subtle">
                  Acceptance receipts appear before the Task consumes anything.
                </p>
              </div>
              <Badge variant="secondary">
                {session.queuedNotes.length}/{MAX_NOTES} accepted
              </Badge>
            </div>

            {!run ? (
              <Empty
                icon={<TrayIcon size={24} />}
                title="Mailbox not open"
                description="Start a briefing, then send editor notes while the Task drafts."
              />
            ) : (
              <div className="space-y-5">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendNote(note);
                  }}
                >
                  <fieldset className="mb-4">
                    <legend className="mb-2 text-xs font-medium text-kumo-subtle">
                      Quick notes
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {NOTE_PRESETS.map((preset) => (
                        <Button
                          key={preset}
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={
                            !agent.identified ||
                            notesLocked ||
                            session.pendingNote !== null ||
                            operation !== null
                          }
                          onClick={() => void sendNote(preset)}
                        >
                          {preset}
                        </Button>
                      ))}
                    </div>
                  </fieldset>
                  <label htmlFor="mailbox-note">
                    <span className="mb-1 block text-xs font-medium text-kumo-subtle">
                      Editor note for later review
                    </span>
                    <Textarea
                      id="mailbox-note"
                      value={note}
                      rows={3}
                      maxLength={280}
                      disabled={
                        notesLocked ||
                        session.pendingNote !== null ||
                        operation !== null
                      }
                      onChange={(event) => setNote(event.currentTarget.value)}
                      placeholder="Add context without interrupting the active step..."
                      required
                    />
                  </label>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-xs text-kumo-subtle">
                      {notesLocked
                        ? session.queuedNotes.length >= MAX_NOTES
                          ? "Demo note limit reached"
                          : "Note intake is closed"
                        : "Each send gets a durable receipt"}
                    </span>
                    <Button
                      type="submit"
                      size="sm"
                      variant="primary"
                      disabled={
                        !agent.identified ||
                        notesLocked ||
                        operation !== null ||
                        (!session.pendingNote && note.trim() === "")
                      }
                      icon={<PaperPlaneRightIcon size={14} />}
                    >
                      {operation === "note"
                        ? "Sending..."
                        : session.pendingNote
                          ? "Retry note"
                          : "Queue note"}
                    </Button>
                  </div>
                </form>

                {session.queuedNotes.length > 0 ? (
                  <ol className="space-y-2" aria-label="Accepted note events">
                    {session.queuedNotes.map((item, index) => (
                      <li
                        key={item.eventId}
                        className="rounded-lg border border-kumo-line bg-kumo-elevated p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <CheckCircleIcon
                              size={14}
                              weight="fill"
                              className="text-kumo-success"
                            />
                            <span className="text-xs font-medium">
                              Note #{index + 1}{" "}
                              {run.state === "completed" &&
                              run.result.notes.some(
                                (note) => note.eventId === item.eventId
                              )
                                ? "reviewed"
                                : "accepted"}
                            </span>
                          </div>
                          <time
                            className="text-xs text-kumo-subtle"
                            dateTime={new Date(item.createdAt).toISOString()}
                          >
                            {formatTime(item.createdAt)}
                          </time>
                        </div>
                        <p className="mt-2 break-words text-sm">{item.text}</p>
                        <p className="mt-2 truncate font-mono text-[10px] text-kumo-subtle">
                          {item.eventId}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="rounded-lg border border-dashed border-kumo-line p-4 text-center text-xs text-kumo-subtle">
                    No note receipts yet.
                  </p>
                )}

                <div className="border-t border-kumo-line pt-5">
                  <div className="mb-3 flex items-center gap-2">
                    <UsersIcon size={16} className="text-kumo-accent" />
                    <p className="text-sm font-semibold">Reader context</p>
                    {waitingForAudience ? (
                      <Badge variant="primary">Answer needed</Badge>
                    ) : null}
                  </div>
                  {session.audienceSubmitted ? (
                    <div className="flex items-center gap-2 rounded-lg border border-kumo-line p-3 text-sm">
                      <CheckCircleIcon
                        size={16}
                        weight="fill"
                        className="text-kumo-success"
                      />
                      Reader context delivered for the final outline.
                    </div>
                  ) : waitingForAudience || session.pendingAudience ? (
                    <form
                      onSubmit={(event) => void deliverReaderContext(event)}
                    >
                      <div className="space-y-3">
                        <label htmlFor="brief-audience">
                          <span className="mb-1 block text-xs text-kumo-subtle">
                            Who will read this brief?
                          </span>
                          <Input
                            id="brief-audience"
                            value={audience}
                            maxLength={80}
                            aria-describedby="brief-audience-help"
                            disabled={
                              session.pendingAudience !== null ||
                              operation !== null
                            }
                            onChange={(event) =>
                              setAudience(event.currentTarget.value)
                            }
                            required
                          />
                        </label>
                        <label htmlFor="brief-decision">
                          <span className="mb-1 block text-xs text-kumo-subtle">
                            What decision are they making?
                          </span>
                          <Input
                            id="brief-decision"
                            value={decision}
                            maxLength={120}
                            aria-describedby="brief-audience-help"
                            disabled={
                              session.pendingAudience !== null ||
                              operation !== null
                            }
                            onChange={(event) =>
                              setDecision(event.currentTarget.value)
                            }
                            required
                          />
                        </label>
                      </div>
                      <p
                        id="brief-audience-help"
                        className="mt-2 text-xs text-kumo-subtle"
                      >
                        These answers set the lens for the opening, relevance,
                        and decision-support sections.
                      </p>
                      <Button
                        className="mt-3 w-full"
                        type="submit"
                        variant="primary"
                        disabled={
                          !agent.identified ||
                          operation !== null ||
                          session.pendingNote !== null ||
                          (!session.pendingAudience &&
                            (audience.trim() === "" || decision.trim() === ""))
                        }
                        icon={<UsersIcon size={15} />}
                      >
                        {operation === "audience"
                          ? "Delivering..."
                          : session.pendingAudience
                            ? "Retry context"
                            : "Deliver context"}
                      </Button>
                      <p className="mt-2 text-xs text-kumo-subtle">
                        Note intake closes before this event is delivered, then
                        the Task drains the mailbox.
                      </p>
                    </form>
                  ) : (
                    <p className="rounded-lg border border-dashed border-kumo-line p-4 text-xs text-kumo-subtle">
                      This form appears when the run reaches waitForEvent(). You
                      can add editor notes until then; the answer will shape the
                      completed outline.
                    </p>
                  )}
                </div>
              </div>
            )}
          </Surface>
        </div>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base px-5 py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
