import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  CodeExplanation,
  ConnectionStatus,
  LogPanel,
  type CodeSection
} from "../../components";
import { useLogs, useToast, useUserId } from "../../hooks";
import type {
  DurableExecutionAgent,
  DurableExecutionState,
  ResearchJob
} from "./durable-execution-agent";

const codeSections: CodeSection[] = [
  {
    title: "Start durable work with runFiber",
    description:
      "runFiber records the job in the agent's SQLite storage before it starts. While the function runs, keepAlive prevents ordinary idle eviction and ctx.stash writes checkpoints.",
    code: `class ReportAgent extends Agent<Env> {
  @callable()
  async startResearchReport(topic: string) {
    const id = crypto.randomUUID();

    void this.runFiber(\`research-report:\${id}\`, async (ctx) => {
      for (const step of steps) {
        ctx.stash({ id, topic, step, updatedAt: Date.now() });
        await runStep(step);
      }
    });

    return id;
  }
}`
  },
  {
    title: "Recover interrupted fibers",
    description:
      "If the Durable Object restarts while a fiber row still exists, the framework calls onFiberRecovered with the last checkpoint. Your app decides whether to resume, mark stale, or ask a user.",
    code: `async onFiberRecovered(ctx: FiberRecoveryContext) {
  const snapshot = ctx.snapshot as {
    id: string;
    step: string;
  } | null;

  await this.notifyClients({
    status: "recovered",
    jobId: snapshot?.id,
    lastCheckpoint: snapshot?.step,
  });
}`
  },
  {
    title: "Use the right durable primitive",
    description:
      "Fibers are best for one long-running operation with checkpoints. Queue is best for many small tasks with retries. Workflows are best when the process itself is the durable product object.",
    code: `// One long-running operation
await this.runFiber("index-docs", async (ctx) => {
  ctx.stash({ phase: "embedding" });
  await embedDocuments();
});

// Many independent tasks
await this.queue("processItem", { id }, {
  retry: { maxAttempts: 5 }
});

// A product-level durable process
await this.runWorkflow("ApprovalWorkflow", { requestId });`
  }
];

function formatTime(timestamp?: number) {
  if (!timestamp) return "Not yet";
  return new Date(timestamp).toLocaleTimeString();
}

function statusClass(status: ResearchJob["status"]) {
  switch (status) {
    case "completed":
      return "bg-kumo-success-tint text-kumo-success";
    case "failed":
      return "bg-kumo-danger-tint text-kumo-danger";
    case "recovered":
      return "bg-kumo-warning-tint text-kumo-warning";
    default:
      return "bg-kumo-info-tint text-kumo-info";
  }
}

function JobCard({ job }: { job: ResearchJob }) {
  const progress = Math.round((job.currentStep / job.totalSteps) * 100);

  return (
    <Surface className="p-4 rounded-lg ring ring-kumo-line">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text bold>{job.topic}</Text>
          <p className="mt-1 text-xs text-kumo-subtle">
            Started {formatTime(job.startedAt)} · Completed{" "}
            {formatTime(job.completedAt)}
          </p>
        </div>
        <span
          className={`text-xs font-semibold px-2 py-1 rounded ${statusClass(job.status)}`}
        >
          {job.status}
        </span>
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-xs text-kumo-subtle mb-1">
          <span>
            Step {job.currentStep} of {job.totalSteps}
          </span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 rounded bg-kumo-fill overflow-hidden">
          <div
            className="h-full bg-kumo-accent transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <p className="mt-3 text-sm text-kumo-default">{job.checkpoint}</p>
      {job.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {job.notes.slice(-3).map((note, index) => (
            <li key={`${job.id}-${index}`} className="text-xs text-kumo-subtle">
              {note}
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

export function DurableExecutionDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [topic, setTopic] = useState("Compare MCP transports for my app");

  const agent = useAgent<DurableExecutionAgent, DurableExecutionState>({
    agent: "durable-execution-agent",
    name: `durable-execution-${userId}`,
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data as string) as {
          type?: string;
          payload?: unknown;
        };
        if (data.type) {
          addLog("in", data.type, data.payload);
        }
      } catch {
        // Ignore protocol messages that are not JSON.
      }
    }
  });

  const jobs = agent.state?.jobs ?? [];
  const recoveries = agent.state?.recoveries ?? [];
  const isRunning = jobs.some((job) => job.status === "running");

  const startJob = async () => {
    if (!topic.trim()) return;
    addLog("out", "startResearchReport", { topic });
    try {
      const id = await agent.call("startResearchReport", [topic]);
      addLog("in", "job_id", { id });
      toast("Durable research job started", "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    clearLogs();
    try {
      await agent.call("clearJobs", []);
    } catch {
      // Ignore cleanup failures while disconnected.
    }
  };

  return (
    <DemoWrapper
      title="Durable Execution"
      description={
        <>
          Use durable execution when an agent needs to keep working after the
          user navigates away, the Worker sleeps, or a long task needs
          checkpoints. This demo starts a report job with{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            runFiber()
          </code>
          , writes checkpoints with{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            ctx.stash()
          </code>
          , and shows where recovery hooks fit.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Fiber Research Job
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              Start a multi-step job, then refresh the page while it runs. The
              agent state and event history reconnect through the same Durable
              Object instance.
            </p>
            <div className="space-y-3">
              <Input
                aria-label="Research topic"
                value={topic}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setTopic(e.target.value)
                }
                placeholder="Topic"
                className="w-full"
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={startJob}
                  disabled={!topic.trim()}
                  className="flex-1"
                >
                  Start Durable Job
                </Button>
                <Button variant="secondary" onClick={clear}>
                  Clear
                </Button>
              </div>
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-3">
              <Text variant="heading3" as="h3">
                Which Primitive Should I Use?
              </Text>
            </div>
            <div className="space-y-3">
              {[
                [
                  "Fiber",
                  "One long-running operation with checkpoints and custom recovery."
                ],
                [
                  "Queue",
                  "Many small callbacks that need retry, backoff, batching, or dedupe."
                ],
                [
                  "Workflow",
                  "A product-level process that needs progress, approvals, listing, and external visibility."
                ]
              ].map(([name, description]) => (
                <div key={name} className="p-3 rounded bg-kumo-elevated">
                  <Text bold size="sm">
                    {name}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">{description}</p>
                </div>
              ))}
            </div>
          </Surface>
        </div>

        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="260px" />

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <Text variant="heading3" as="h3">
                Jobs
              </Text>
              <span className="text-xs text-kumo-subtle">
                {isRunning ? "Working" : "Idle"}
              </span>
            </div>
            {jobs.length === 0 ? (
              <p className="text-sm text-kumo-subtle">
                Start a job to see checkpoints and completion state.
              </p>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <JobCard key={job.id} job={job} />
                ))}
              </div>
            )}
          </Surface>

          {recoveries.length > 0 && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-3">
                <Text variant="heading3" as="h3">
                  Recoveries
                </Text>
              </div>
              <div className="space-y-2">
                {recoveries.map((recovery) => (
                  <div
                    key={recovery.id}
                    className="p-3 rounded bg-kumo-elevated text-xs"
                  >
                    <div className="font-mono text-kumo-default">
                      {recovery.name}
                    </div>
                    <div className="mt-1 text-kumo-subtle">
                      Recovered {formatTime(recovery.recoveredAt)}
                    </div>
                  </div>
                ))}
              </div>
            </Surface>
          )}
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
