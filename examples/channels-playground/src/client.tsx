import "./styles.css";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  BroadcastIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  ProhibitIcon,
  RobotIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  FakeAgentBehavior,
  FakeAgentMode,
  FakeAgentTurnRecord,
  InspectedSubmission
} from "./server";

const AGENT_TARGET = "support-agent";

// -- API helpers --------------------------------------------------------

interface AcceptanceLogEntry {
  id: string;
  httpStatus: number;
  outcome: string;
  submissionId?: string;
  latencyMs: number;
  at: string;
}

interface AgentSnapshot {
  behavior: FakeAgentBehavior;
  turns: FakeAgentTurnRecord[];
}

interface InspectorSnapshot {
  submissions: InspectedSubmission[];
  nextWakeAt?: string;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body)
  });
  return response.json() as Promise<T>;
}

// -- Small display pieces ------------------------------------------------

function shortId(id: string): string {
  const [prefix, rest] = id.split("_", 2);
  return rest === undefined ? id : `${prefix}_${rest.slice(0, 8)}`;
}

function StateBadge({ state }: { state: string }) {
  const variant =
    state === "delivered"
      ? "primary"
      : state === "failed"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{state}</Badge>;
}

function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (outcome === undefined) {
    return <Badge variant="secondary">in flight</Badge>;
  }
  const variant =
    outcome === "acknowledged"
      ? "primary"
      : outcome === "permanent_error"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{outcome.replaceAll("_", " ")}</Badge>;
}

function Countdown({
  to,
  now,
  label
}: {
  to: string;
  now: number;
  label: string;
}) {
  const remaining = Math.max(0, Date.parse(to) - now);
  return (
    <Text size="xs" variant="secondary">
      {label} {remaining === 0 ? "now" : `in ${Math.ceil(remaining / 1000)}s`}
    </Text>
  );
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

// -- Inbound surface ------------------------------------------------------

function InboundSurface({ onAccepted }: { onAccepted: () => void }) {
  const [text, setText] = useState("Where is order 1234?");
  const [eventId, setEventId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [lastSent, setLastSent] = useState<{
    eventId: string;
    text: string;
  } | null>(null);
  const [log, setLog] = useState<AcceptanceLogEntry[]>([]);

  const submit = useCallback(
    async (sendEventId: string, sendText: string, freshAfter: boolean) => {
      const startedAt = performance.now();
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `playground:webchat:${sendEventId}`,
          agentTarget: AGENT_TARGET,
          payload: { type: "message", text: sendText },
          source: { type: "webchat", id: sendEventId },
          conversationHint: "webchat:demo-thread"
        })
      });
      const body = (await response.json()) as {
        outcome?: string;
        submissionId?: string;
      };
      setLog((entries) =>
        [
          {
            id: crypto.randomUUID(),
            httpStatus: response.status,
            outcome: body.outcome ?? "rejected",
            submissionId: body.submissionId,
            latencyMs: Math.round(performance.now() - startedAt),
            at: new Date().toLocaleTimeString()
          },
          ...entries
        ].slice(0, 6)
      );
      setLastSent({ eventId: sendEventId, text: sendText });
      if (freshAfter) {
        setEventId(crypto.randomUUID().slice(0, 8));
      }
      onAccepted();
    },
    [onAccepted]
  );

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <BroadcastIcon size={18} className="text-kumo-accent" />
        <Text size="sm" bold>
          Inbound surface (fake webhook)
        </Text>
      </div>
      <Text size="xs" variant="secondary">
        Pretends to be a provider webhook. Each send derives its idempotency key
        from the event ID, so replaying the same event is a duplicate and
        editing a replayed event is a conflict.
      </Text>
      <InputArea
        value={text}
        onValueChange={setText}
        placeholder="Message for the agent"
      />
      <div className="flex items-center gap-2">
        <Text size="xs" variant="secondary">
          Provider event ID:
        </Text>
        <code className="text-xs">{eventId}</code>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<PaperPlaneRightIcon size={14} />}
          onClick={() => void submit(eventId, text, true)}
        >
          Send webhook
        </Button>
        <Button
          variant="secondary"
          disabled={lastSent === null}
          onClick={() =>
            lastSent && void submit(lastSent.eventId, lastSent.text, false)
          }
        >
          Redeliver last event
        </Button>
        <Button
          variant="secondary"
          disabled={lastSent === null}
          onClick={() => lastSent && void submit(lastSent.eventId, text, false)}
        >
          Redeliver with edits
        </Button>
      </div>
      {log.length > 0 && (
        <div className="flex flex-col gap-1">
          {log.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2">
              <Badge
                variant={
                  entry.outcome === "accepted"
                    ? "primary"
                    : entry.outcome === "conflict"
                      ? "destructive"
                      : "secondary"
                }
              >
                {entry.httpStatus} {entry.outcome}
              </Badge>
              <Text size="xs" variant="secondary">
                {entry.submissionId !== undefined
                  ? `${shortId(entry.submissionId)} · `
                  : ""}
                acknowledged in {entry.latencyMs}ms · {entry.at}
              </Text>
            </div>
          ))}
        </div>
      )}
    </Surface>
  );
}

// -- Fake agent control ----------------------------------------------------

const MODES: Array<{
  mode: FakeAgentMode;
  label: string;
  description: string;
}> = [
  {
    mode: "acknowledge",
    label: "Acknowledge",
    description: "Accept and acknowledge every turn immediately."
  },
  {
    mode: "fail_transient",
    label: "Fail (transient)",
    description: "Throw a retryable error — watch bounded backoff retries."
  },
  {
    mode: "reject_permanent",
    label: "Reject (permanent)",
    description: "Refuse the turn — the submission fails without retries."
  },
  {
    mode: "hang",
    label: "Hang",
    description:
      "Hold the delivery past the 5s dispatch timeout, then acknowledge late."
  },
  {
    mode: "flaky",
    label: "Flaky",
    description: "Fail the first N deliveries of a turn, then acknowledge."
  }
];

function AgentPanel({
  snapshot,
  onBehaviorChange
}: {
  snapshot: AgentSnapshot | null;
  onBehaviorChange: (behavior: FakeAgentBehavior) => void;
}) {
  const behavior = snapshot?.behavior;
  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <RobotIcon size={18} className="text-kumo-accent" />
        <Text size="sm" bold>
          Fake agent ({AGENT_TARGET})
        </Text>
      </div>
      <Text size="xs" variant="secondary">
        Choose how the agent responds to the next deliveries. It follows the
        delivery contract: once a turn is acknowledged, redelivery of the same
        turn ID is deduplicated and re-acknowledged, never re-executed.
      </Text>
      <div
        className="flex flex-col gap-1"
        role="radiogroup"
        aria-label="Agent behavior"
      >
        {MODES.map((entry) => (
          <label
            key={entry.mode}
            aria-label={entry.label}
            className="flex items-start gap-2 cursor-pointer rounded-lg p-2 hover:bg-kumo-elevated"
          >
            <input
              type="radio"
              name="agent-mode"
              aria-label={entry.label}
              className="mt-1 accent-current"
              checked={behavior?.mode === entry.mode}
              onChange={() =>
                behavior && onBehaviorChange({ ...behavior, mode: entry.mode })
              }
            />
            <span className="flex flex-col">
              <Text size="xs" bold>
                {entry.label}
              </Text>
              <Text size="xs" variant="secondary">
                {entry.description}
              </Text>
            </span>
          </label>
        ))}
        {behavior?.mode === "flaky" && (
          <label className="flex items-center gap-2 pl-8">
            <Text size="xs" variant="secondary">
              Failures before success:
            </Text>
            <input
              type="number"
              min={1}
              max={10}
              value={behavior.failuresBeforeSuccess}
              className="w-16 rounded border border-kumo-line bg-transparent px-1 py-0.5 text-xs"
              onChange={(event) =>
                onBehaviorChange({
                  ...behavior,
                  failuresBeforeSuccess: Math.max(
                    1,
                    Number(event.target.value) || 1
                  )
                })
              }
            />
          </label>
        )}
      </div>
      <Text size="xs" bold>
        Agent inbox — logical turns
      </Text>
      {snapshot === null || snapshot.turns.length === 0 ? (
        <Empty title="No turns received yet" />
      ) : (
        <div className="flex flex-col gap-2">
          {snapshot.turns.map((turn) => (
            <div
              key={turn.turnId}
              className="rounded-lg border border-kumo-line p-2 flex flex-col gap-1"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-xs">{shortId(turn.turnId)}</code>
                <Badge variant={turn.acknowledged ? "primary" : "secondary"}>
                  {turn.acknowledged ? "accepted" : "not accepted"}
                </Badge>
                <Badge
                  variant={turn.deliveries > 1 ? "destructive" : "secondary"}
                >
                  {turn.deliveries === 1
                    ? "1 delivery"
                    : `${turn.deliveries} deliveries (deduped)`}
                </Badge>
              </div>
              <Text size="xs" variant="secondary">
                “{turn.text}”
              </Text>
            </div>
          ))}
        </div>
      )}
    </Surface>
  );
}

// -- Submission inspector ---------------------------------------------------

function SubmissionCard({
  submission,
  now,
  onAction
}: {
  submission: InspectedSubmission;
  now: number;
  onAction: () => void;
}) {
  const cancellable = ["pending", "retrying", "delivering"].includes(
    submission.state
  );
  return (
    <div className="rounded-lg border border-kumo-line p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-xs">{shortId(submission.submissionId)}</code>
        <StateBadge state={submission.state} />
        <Text size="xs" variant="secondary">
          turn {shortId(submission.turnId)} · {submission.attemptCount}{" "}
          {submission.attemptCount === 1 ? "attempt" : "attempts"}
          {submission.replayCount > 0
            ? ` · ${submission.replayCount} replay(s)`
            : ""}
        </Text>
      </div>
      {submission.state === "retrying" &&
        submission.nextAttemptAt !== undefined && (
          <Countdown
            to={submission.nextAttemptAt}
            now={now}
            label={`retry ${submission.retryCount} due`}
          />
        )}
      {submission.state === "delivering" &&
        submission.leaseExpiresAt !== undefined && (
          <Countdown
            to={submission.leaseExpiresAt}
            now={now}
            label="delivering — lease expires"
          />
        )}
      {submission.terminalError !== undefined && (
        <Text size="xs" variant="secondary">
          ✕ {submission.terminalError}
        </Text>
      )}
      {submission.attempts.length > 0 && (
        <div className="flex flex-col gap-1">
          {submission.attempts.map((attempt) => (
            <div key={attempt.attemptId} className="flex items-center gap-2">
              <Text size="xs" variant="secondary">
                #{attempt.attemptNumber}
              </Text>
              <OutcomeBadge outcome={attempt.outcome} />
              {attempt.errorDescription !== undefined && (
                <span
                  className="truncate max-w-64"
                  title={attempt.errorDescription}
                >
                  <Text size="xs" variant="secondary">
                    {attempt.errorDescription}
                  </Text>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {cancellable && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ProhibitIcon size={14} />}
            onClick={() =>
              void postJson(
                `/api/submissions/${submission.submissionId}/cancel`
              ).then(onAction)
            }
          >
            Cancel
          </Button>
        )}
        {submission.state === "failed" && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowsClockwiseIcon size={14} />}
            onClick={() =>
              void postJson(
                `/api/submissions/${submission.submissionId}/replay`,
                { requestedBy: "playground-ui" }
              ).then(onAction)
            }
          >
            Replay
          </Button>
        )}
      </div>
    </div>
  );
}

function Inspector({
  snapshot,
  now,
  onAction
}: {
  snapshot: InspectorSnapshot | null;
  now: number;
  onAction: () => void;
}) {
  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Text size="sm" bold>
          Submission state machine
        </Text>
        <span className="grow" />
        <Button
          variant="secondary"
          size="sm"
          icon={<PlayIcon size={14} />}
          onClick={() => void postJson("/api/deliver").then(onAction)}
        >
          Run delivery pass
        </Button>
      </div>
      <Text size="xs" variant="secondary">
        pending → delivering → delivered, with retrying on transient failures,
        failed on dead-letter, and cancelled on request. Attempts are physical;
        the turn ID never changes.
      </Text>
      {snapshot?.nextWakeAt !== undefined && (
        <Countdown to={snapshot.nextWakeAt} now={now} label="next alarm wake" />
      )}
      {snapshot === null || snapshot.submissions.length === 0 ? (
        <Empty title="No submissions yet — send a webhook" />
      ) : (
        <div className="flex flex-col gap-2">
          {snapshot.submissions.map((submission) => (
            <SubmissionCard
              key={submission.submissionId}
              submission={submission}
              now={now}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </Surface>
  );
}

// -- App ---------------------------------------------------------------------

function App() {
  const [agentSnapshot, setAgentSnapshot] = useState<AgentSnapshot | null>(
    null
  );
  const [inspector, setInspector] = useState<InspectorSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const [agentResponse, inspectorResponse] = await Promise.all([
      fetch("/api/agent"),
      fetch("/api/inspector")
    ]);
    setAgentSnapshot((await agentResponse.json()) as AgentSnapshot);
    setInspector((await inspectorResponse.json()) as InspectorSnapshot);
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 1_500);
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const onBehaviorChange = useMemo(
    () => (behavior: FakeAgentBehavior) => {
      setAgentSnapshot((current) =>
        current === null ? current : { ...current, behavior }
      );
      void postJson("/api/agent/behavior", behavior).then(() => refresh());
    },
    [refresh]
  );

  return (
    <div className="max-w-5xl mx-auto p-4 flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <BroadcastIcon size={22} className="text-kumo-accent" />
        <Text size="lg" bold>
          Channels Playground
        </Text>
        <span className="grow" />
        <Button
          variant="ghost"
          icon={<TrashIcon size={16} />}
          onClick={() => void postJson("/api/reset").then(() => refresh())}
        >
          Reset demo
        </Button>
        <ModeToggle />
      </header>

      <Surface className="p-4 rounded-xl ring ring-kumo-line">
        <div className="flex gap-3">
          <InfoIcon
            size={20}
            weight="bold"
            className="text-kumo-accent shrink-0 mt-0.5"
          />
          <div>
            <Text size="sm" bold>
              Durable at-least-once agent delivery
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                This playground drives the @cloudflare/channels submission state
                machine end to end. Send fake inbound messages, make the fake
                agent fail, hang, or reject, and watch acceptance, idempotency,
                retries with backoff, leases, dead-lettering, replay, and
                turn-ID deduplication happen live.
              </Text>
            </span>
          </div>
        </div>
      </Surface>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <InboundSurface onAccepted={() => void refresh()} />
          <AgentPanel
            snapshot={agentSnapshot}
            onBehaviorChange={onBehaviorChange}
          />
        </div>
        <Inspector
          snapshot={inspector}
          now={now}
          onAction={() => void refresh()}
        />
      </div>

      <footer className="flex justify-center py-2">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
