import { useAgent } from "agents/react";
import {
  ArrowClockwiseIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  ProhibitIcon,
  SunIcon
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SubmitMessagesResult,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus
} from "@cloudflare/think";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

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
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="text-xs text-kumo-subtle">{label}</span>
    </output>
  );
}

function isTerminal(status: ThinkSubmissionStatus) {
  return (
    status === "completed" ||
    status === "aborted" ||
    status === "skipped" ||
    status === "error"
  );
}

function StatusBadge({ status }: { status: ThinkSubmissionStatus }) {
  return <Badge>{status}</Badge>;
}

function formatTime(value?: number) {
  return value ? new Date(value).toLocaleTimeString() : "-";
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [prompt, setPrompt] = useState(
    "Summarize why durable async submission matters for webhook callers."
  );
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    crypto.randomUUID()
  );
  const [submissions, setSubmissions] = useState<ThinkSubmissionInspection[]>(
    []
  );
  const [lastAck, setLastAck] = useState<SubmitMessagesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent({
    agent: "TaskAgent",
    name: "demo",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback((event: Event) => {
      console.error("Agent connection error", event);
      setConnectionStatus("disconnected");
    }, [])
  });

  const refresh = useCallback(async () => {
    const next = (await agent.call(
      "listTasks",
      []
    )) as ThinkSubmissionInspection[];
    setSubmissions(next);
  }, [agent]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const activeCount = useMemo(
    () =>
      submissions.filter((submission) => !isTerminal(submission.status)).length,
    [submissions]
  );

  async function submit(retry = false) {
    setBusy(true);
    setError(null);
    try {
      const key = retry
        ? idempotencyKey
        : idempotencyKey || crypto.randomUUID();
      setIdempotencyKey(key);
      const result = (await agent.call("submitTask", [
        prompt,
        key
      ])) as SubmitMessagesResult;
      setLastAck(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(submissionId: string) {
    await agent.call("cancelTask", [submissionId]);
    await refresh();
  }

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Text size="lg" bold>
              Think Durable Submissions
            </Text>
            <span className="mt-1 block">
              <Text size="sm" variant="secondary">
                Submit a Think turn, get a durable receipt immediately, retry
                safely, and inspect status later.
              </Text>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </header>

        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                What this demo shows
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  `submitMessages()` stores pending work before the model runs.
                  Retrying with the same idempotency key returns the existing
                  submission instead of duplicating the chat turn.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <section className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Surface className="rounded-xl p-4 ring ring-kumo-line">
            <div className="space-y-4">
              <div>
                <Text size="sm" bold>
                  Prompt
                </Text>
                <textarea
                  className="mt-2 min-h-32 w-full rounded-lg border border-kumo-line bg-kumo-surface p-3 text-sm outline-none"
                  value={prompt}
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                />
              </div>

              <div>
                <Text size="sm" bold>
                  Idempotency key
                </Text>
                <input
                  className="mt-2 w-full rounded-lg border border-kumo-line bg-kumo-surface p-3 text-sm outline-none"
                  value={idempotencyKey}
                  onChange={(event) =>
                    setIdempotencyKey(event.currentTarget.value)
                  }
                />
              </div>

              {error && (
                <Text size="sm" variant="error">
                  {error}
                </Text>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || prompt.trim().length === 0}
                  onClick={() => void submit(false)}
                  icon={<PaperPlaneRightIcon size={16} />}
                >
                  Submit
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !lastAck}
                  onClick={() => void submit(true)}
                  icon={<ArrowClockwiseIcon size={16} />}
                >
                  Retry same key
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setIdempotencyKey(crypto.randomUUID())}
                >
                  New key
                </Button>
              </div>
            </div>
          </Surface>

          <Surface className="rounded-xl p-4 ring ring-kumo-line">
            <Text size="sm" bold>
              Latest ACK
            </Text>
            {lastAck ? (
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-kumo-subtle">Accepted</dt>
                  <dd>{String(lastAck.accepted)}</dd>
                </div>
                <div>
                  <dt className="text-kumo-subtle">Submission</dt>
                  <dd className="break-all">{lastAck.submissionId}</dd>
                </div>
                <div>
                  <dt className="text-kumo-subtle">Status</dt>
                  <dd>
                    <StatusBadge status={lastAck.status} />
                  </dd>
                </div>
              </dl>
            ) : (
              <span className="mt-3 block">
                <Text size="sm" variant="secondary">
                  Submit a task to see the durable receipt.
                </Text>
              </span>
            )}
          </Surface>
        </section>

        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <Text size="lg" bold>
                Submission queue
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  {activeCount} active, {submissions.length} recent total
                </Text>
              </span>
            </div>
            <Button variant="ghost" onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>

          <div className="space-y-3">
            {submissions.length === 0 ? (
              <Text size="sm" variant="secondary">
                No submissions yet.
              </Text>
            ) : (
              submissions.map((submission) => (
                <div
                  key={submission.submissionId}
                  className="rounded-lg border border-kumo-line p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={submission.status} />
                        <span className="text-sm font-medium">
                          {submission.submissionId}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-kumo-subtle">
                        Created {formatTime(submission.createdAt)} · Started{" "}
                        {formatTime(submission.startedAt)} · Completed{" "}
                        {formatTime(submission.completedAt)}
                      </p>
                    </div>
                    {!isTerminal(submission.status) && (
                      <Button
                        variant="secondary"
                        onClick={() => void cancel(submission.submissionId)}
                        icon={<ProhibitIcon size={16} />}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                  {submission.error && (
                    <p className="mt-2 text-xs text-kumo-danger">
                      {submission.error}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </Surface>

        <footer className="mt-auto flex justify-center">
          <PoweredByCloudflare />
        </footer>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(<App />);
