import { useAgent } from "agents/react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Button, Input, Badge, Text, Empty } from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents
} from "@cloudflare/agents-ui";
import type { ConnectionStatus } from "@cloudflare/agents-ui";
import type {
  TaskAgent,
  WorkflowItem,
  WorkflowPage,
  WorkflowUpdate
} from "./server";

// Local progress type without index signature for type-safe JSX rendering
type ProgressInfo = {
  step?: string;
  status?: string;
  message?: string;
  percent?: number;
};

// UI-safe workflow type with explicit result type for rendering
type WorkflowCardData = Omit<WorkflowItem, "result" | "progress"> & {
  result?: Record<string, unknown>;
  progress: ProgressInfo | null;
};

// Client-side pagination state
type PaginationState = {
  workflows: WorkflowItem[];
  total: number;
  nextCursor: string | null;
};

const initialPagination: PaginationState = {
  workflows: [],
  total: 0,
  nextCursor: null
};

type Toast = {
  message: string;
  type: "error" | "info";
};

/** Format the "not supported in local dev" message, or fall back to a generic one. */
function localDevMessage(err: unknown, fallback: string): string {
  if (
    err instanceof Error &&
    err.message.includes("not supported in local development")
  ) {
    return `${fallback.replace("Failed to ", "")} is not supported in local dev. Deploy to Cloudflare to use this feature.`;
  }
  return fallback;
}

export default function App() {
  const [taskName, setTaskName] = useState("");
  const [pagination, setPagination] =
    useState<PaginationState>(initialPagination);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [toast, setToast] = useState<Toast | null>(null);
  const [loading, setLoading] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connected = connectionStatus === "connected";

  const showToast = useCallback(
    (message: string, type: Toast["type"] = "error") => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast({ message, type });
      toastTimer.current = setTimeout(() => setToast(null), 5000);
    },
    []
  );

  // Handle real-time updates from server
  const handleMessage = useCallback(
    (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data);

        if (data?.type === "warning" && data?.message) {
          showToast(data.message, "error");
          return;
        }

        if (data?.type === "workflows:cleared") {
          setPagination((prev) => ({
            ...prev,
            workflows: prev.workflows.filter(
              (w) => w.status !== "complete" && w.status !== "errored"
            ),
            total: prev.total - (data.count || 0)
          }));
          return;
        }

        const update = data as WorkflowUpdate;
        if (update?.type === "workflow:added") {
          setPagination((prev) => {
            const exists = prev.workflows.some(
              (w) => w.workflowId === update.workflow.workflowId
            );
            if (exists) return prev;
            return {
              ...prev,
              workflows: [update.workflow, ...prev.workflows],
              total: prev.total + 1
            };
          });
        } else if (update?.type === "workflow:updated") {
          setPagination((prev) => ({
            ...prev,
            workflows: prev.workflows.map((w) =>
              w.workflowId === update.workflowId
                ? { ...w, ...update.updates }
                : w
            )
          }));
        } else if (update?.type === "workflow:removed") {
          setPagination((prev) => ({
            ...prev,
            workflows: prev.workflows.filter(
              (w) => w.workflowId !== update.workflowId
            ),
            total: Math.max(0, prev.total - 1)
          }));
        }
      } catch {
        // Ignore non-JSON messages
      }
    },
    [showToast]
  );

  const agent = useAgent<TaskAgent, Record<string, never>>({
    agent: "TaskAgent",
    onMessage: handleMessage,
    onOpen: () => setConnectionStatus("connected"),
    onClose: () => setConnectionStatus("disconnected")
  });

  /** Wrapper around agent.call with try/catch and local-dev error handling. */
  const callAgent = useCallback(
    async (method: string, args: unknown[], errorLabel?: string) => {
      try {
        // @ts-expect-error - callable method typing
        return await agent.call(method, args);
      } catch (err) {
        if (errorLabel) {
          showToast(localDevMessage(err, errorLabel));
        } else {
          console.error(`Failed to call ${method}:`, err);
        }
      }
    },
    [agent, showToast]
  );

  // Fetch initial page on connect
  useEffect(() => {
    if (!connected) return;

    const fetchInitial = async () => {
      const page = (await callAgent("listWorkflows", [])) as
        | WorkflowPage
        | undefined;
      if (page) {
        setPagination({
          workflows: page.workflows,
          total: page.total,
          nextCursor: page.nextCursor
        });
      }
    };

    fetchInitial();
  }, [connected, callAgent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskName.trim()) return;
    await callAgent("submitTask", [taskName]);
    setTaskName("");
  };

  const handleLoadMore = async () => {
    if (!pagination.nextCursor || loading) return;
    setLoading(true);
    try {
      const page = (await callAgent("listWorkflows", [
        pagination.nextCursor,
        5
      ])) as WorkflowPage | undefined;
      if (page) {
        // Silently deduplicate in case of pagination overlap
        const existingIds = new Set(
          pagination.workflows.map((w) => w.workflowId)
        );
        const newWorkflows = page.workflows.filter(
          (w) => !existingIds.has(w.workflowId)
        );
        setPagination((prev) => ({
          workflows: [...prev.workflows, ...newWorkflows],
          total: page.total,
          nextCursor: page.nextCursor
        }));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClearCompleted = () => callAgent("clearCompleted", []);

  const hasCompletedWorkflows = pagination.workflows.some(
    (w) => w.status === "complete" || w.status === "errored"
  );

  return (
    <div className="min-h-screen bg-kumo-elevated">
      <div className="mx-auto max-w-2xl px-5 py-10">
        {/* Header */}
        <header className="mb-10 flex items-start justify-between">
          <div>
            <Text variant="heading1">Workflow Demo</Text>
            <p className="mt-1 text-kumo-inactive">
              Multiple Concurrent Workflows with Human-in-the-Loop Approval
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
          </div>
        </header>

        {/* Task submission form */}
        <form onSubmit={handleSubmit} className="mb-8 flex items-center gap-4">
          <Input
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder="Enter task name (e.g., 'Generate Report')"
            aria-label="Task name"
            className="flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!taskName.trim()}
            className="shrink-0"
          >
            Start Task
          </Button>
        </form>

        {/* Workflow list header */}
        {pagination.workflows.length > 0 && (
          <div className="mb-4 flex items-center justify-between">
            <Text variant="heading3">
              Workflows ({pagination.workflows.length}
              {pagination.total > pagination.workflows.length &&
                ` of ${pagination.total}`}
              )
            </Text>
            {hasCompletedWorkflows && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleClearCompleted}
              >
                Clear Completed
              </Button>
            )}
          </div>
        )}

        {/* Workflow list */}
        <div className="flex flex-col gap-3">
          {pagination.workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.workflowId}
              workflow={workflow}
              callAgent={callAgent}
            />
          ))}
        </div>

        {/* Load more button */}
        {pagination.nextCursor && (
          <div className="mt-4 border-t border-kumo-line pt-5 text-center">
            <Button
              variant="secondary"
              onClick={handleLoadMore}
              loading={loading}
            >
              Load More ({pagination.total - pagination.workflows.length}{" "}
              remaining)
            </Button>
          </div>
        )}

        {/* Empty state */}
        {pagination.workflows.length === 0 && (
          <Empty
            title="No workflows yet"
            description="Start a task above to begin!"
          />
        )}

        {/* Feature list */}
        <footer className="mt-12 border-t border-kumo-line pt-6">
          <h4 className="mb-3 font-medium text-kumo-inactive">
            This demo shows:
          </h4>
          <ul className="list-inside list-disc space-y-1 text-kumo-inactive">
            <li>
              Multiple concurrent workflows with{" "}
              <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-kumo-brand">
                runWorkflow()
              </code>
            </li>
            <li>
              Paginated workflow list via{" "}
              <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-kumo-brand">
                getWorkflows()
              </code>
            </li>
            <li>
              Typed progress reporting with{" "}
              <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-kumo-brand">
                reportProgress()
              </code>
            </li>
            <li>
              Human-in-the-loop with{" "}
              <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-kumo-brand">
                waitForApproval()
              </code>
            </li>
            <li>
              Per-workflow approve/reject via{" "}
              <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-kumo-brand">
                approveWorkflow()
              </code>
            </li>
            <li>
              Workflow termination via{" "}
              <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-kumo-brand">
                terminateWorkflow()
              </code>
            </li>
          </ul>

          <div className="mt-8 flex justify-center">
            <PoweredByAgents />
          </div>
        </footer>

        {/* Toast notification */}
        {toast && (
          <div
            className={`animate-toast-in fixed bottom-6 right-6 z-50 flex max-w-sm items-center gap-3 rounded-lg border bg-kumo-base p-4 shadow-lg ${
              toast.type === "error"
                ? "border-l-4 border-l-kumo-brand border-kumo-line"
                : "border-l-4 border-l-kumo-secondary border-kumo-line"
            }`}
          >
            <span className="flex-1 text-kumo-default">{toast.message}</span>
            <button
              type="button"
              className="text-kumo-inactive transition-colors hover:text-kumo-default"
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Status badge variant mapping
const statusBadgeConfig: Record<
  WorkflowItem["status"],
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "primary" },
  waiting: { label: "Awaiting Approval", variant: "beta" },
  complete: { label: "Complete", variant: "outline" },
  errored: { label: "Error", variant: "destructive" },
  paused: { label: "Paused", variant: "secondary" }
};

function StatusBadge({ status }: { status: WorkflowItem["status"] }) {
  const { label, variant } = statusBadgeConfig[status];
  return <Badge variant={variant}>{label}</Badge>;
}

/** Restart + Dismiss buttons used for both completed and errored workflows. */
function WorkflowEndActions({
  workflowId,
  callAgent
}: {
  workflowId: string;
  callAgent: (
    method: string,
    args: unknown[],
    errorLabel?: string
  ) => Promise<unknown>;
}) {
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="primary"
        onClick={() =>
          callAgent("restart", [workflowId], "Failed to restart workflow")
        }
      >
        Restart
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => callAgent("dismissWorkflow", [workflowId])}
      >
        Dismiss
      </Button>
    </div>
  );
}

// Workflow card component
function WorkflowCard({
  workflow: rawWorkflow,
  callAgent
}: {
  workflow: WorkflowItem;
  callAgent: (
    method: string,
    args: unknown[],
    errorLabel?: string
  ) => Promise<unknown>;
}) {
  const [rejectReason, setRejectReason] = useState("");

  // Transform WorkflowItem to UI-safe types for rendering
  const workflow: WorkflowCardData = {
    ...rawWorkflow,
    result:
      rawWorkflow.result != null &&
      typeof rawWorkflow.result === "object" &&
      !Array.isArray(rawWorkflow.result)
        ? (rawWorkflow.result as Record<string, unknown>)
        : undefined,
    progress: rawWorkflow.progress as ProgressInfo | null
  };

  const percent = workflow.progress?.percent ?? 0;
  const message = workflow.progress?.message ?? "Processing...";
  const id = workflow.workflowId;

  const borderClass =
    workflow.status === "waiting"
      ? "border-kumo-brand/40"
      : workflow.status === "complete"
        ? "border-green-500/30"
        : workflow.status === "errored"
          ? "border-red-500/30"
          : "border-kumo-line";

  return (
    <div
      className={`rounded-xl border bg-kumo-base p-5 transition-colors hover:border-kumo-interact ${borderClass}`}
    >
      {/* Header with task name and status */}
      <div className="mb-3 flex items-start justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-kumo-default">
            {workflow.taskName}
          </span>
          <span className="font-mono text-xs text-kumo-inactive">
            {id.slice(0, 8)}
          </span>
        </div>
        <StatusBadge status={workflow.status} />
      </div>

      {/* Progress bar for running/waiting/queued workflows */}
      {(workflow.status === "running" ||
        workflow.status === "waiting" ||
        workflow.status === "queued") && (
        <div className="mb-3">
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-kumo-tint">
            <div
              className={`h-full rounded-full bg-kumo-brand transition-all duration-300 ease-out ${
                workflow.waitingForApproval ? "animate-pulse-glow" : ""
              }`}
              style={{ width: `${percent * 100}%` }}
            />
          </div>
          <span className="text-sm text-kumo-inactive">
            {Math.round(percent * 100)}% – {message}
          </span>
        </div>
      )}

      {/* Action buttons for running/queued workflows */}
      {(workflow.status === "running" || workflow.status === "queued") &&
        !workflow.waitingForApproval && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                callAgent("pause", [id], "Failed to pause workflow")
              }
            >
              Pause
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                callAgent("terminate", [id], "Failed to terminate workflow")
              }
            >
              Terminate
            </Button>
          </div>
        )}

      {/* Resume button for paused workflows */}
      {workflow.status === "paused" && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              callAgent("resume", [id], "Failed to resume workflow")
            }
          >
            Resume
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              callAgent("terminate", [id], "Failed to terminate workflow")
            }
          >
            Terminate
          </Button>
        </div>
      )}

      {/* Approval buttons */}
      {workflow.waitingForApproval && (
        <div className="flex flex-wrap items-stretch gap-3 border-t border-kumo-line pt-3">
          <Button
            variant="primary"
            onClick={() => callAgent("approve", [id, "Approved via UI"])}
          >
            Approve
          </Button>
          <div className="flex flex-1 items-stretch gap-2">
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason (optional)"
              aria-label="Rejection reason"
              className="min-w-[120px] flex-1"
            />
            <Button
              variant="destructive"
              onClick={() => {
                callAgent("reject", [id, rejectReason || "Rejected via UI"]);
                setRejectReason("");
              }}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {/* Completed result */}
      {workflow.status === "complete" && workflow.result && (
        <div className="border-t border-kumo-line pt-3">
          <pre className="mb-3 max-h-[150px] overflow-auto rounded-lg border border-kumo-line bg-kumo-elevated p-3 font-mono text-sm text-kumo-inactive">
            {JSON.stringify(workflow.result, null, 2)}
          </pre>
          <WorkflowEndActions workflowId={id} callAgent={callAgent} />
        </div>
      )}

      {/* Error display */}
      {workflow.status === "errored" && (
        <div className="border-t border-kumo-line pt-3">
          <p className="mb-3 text-kumo-danger">{workflow.error?.message}</p>
          <WorkflowEndActions workflowId={id} callAgent={callAgent} />
        </div>
      )}
    </div>
  );
}
