import { useAgent } from "agents/react";
import { useState, useEffect, useCallback } from "react";
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

export default function App() {
  const [taskName, setTaskName] = useState("");
  const [pagination, setPagination] =
    useState<PaginationState>(initialPagination);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [loading, setLoading] = useState(false);

  const showToast = (message: string, type: Toast["type"] = "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  };

  // Handle real-time updates from server
  const handleMessage = useCallback((message: MessageEvent) => {
    try {
      const data = JSON.parse(message.data);

      if (data?.type === "warning" && data?.message) {
        showToast(data.message, "error");
        return;
      }

      if (data?.type === "workflows:cleared") {
        // Refresh the list after bulk clear
        setPagination((prev) => ({
          ...prev,
          workflows: prev.workflows.filter(
            (w) => w.status !== "complete" && w.status !== "errored"
          ),
          total: prev.total - (data.count || 0)
        }));
        return;
      }

      // Handle workflow updates
      const update = data as WorkflowUpdate;
      if (update?.type === "workflow:added") {
        // Only add if not already in list (caller adds directly from return value)
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
            w.workflowId === update.workflowId ? { ...w, ...update.updates } : w
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
  }, []);

  const agent = useAgent<TaskAgent, Record<string, never>>({
    agent: "TaskAgent",
    onMessage: handleMessage,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false)
  });

  // Fetch initial page on connect
  useEffect(() => {
    if (!connected) return;

    const fetchInitial = async () => {
      try {
        // @ts-expect-error - callable method typing
        const page = (await agent.call("listWorkflows", [])) as WorkflowPage;
        setPagination({
          workflows: page.workflows,
          total: page.total,
          nextCursor: page.nextCursor
        });
      } catch (err) {
        console.error("Failed to load workflows:", err);
      }
    };

    fetchInitial();
  }, [connected]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskName.trim()) return;

    try {
      // @ts-expect-error - callable method typing
      await agent.call("submitTask", [taskName]);
      // Workflow will be added via broadcast message
      setTaskName("");
    } catch (err) {
      console.error("Failed to submit task:", err);
    }
  };

  const handleLoadMore = async () => {
    if (!pagination.nextCursor || loading) return;
    setLoading(true);
    try {
      // @ts-expect-error - callable method typing
      const page = (await agent.call("listWorkflows", [
        pagination.nextCursor,
        5
      ])) as WorkflowPage;

      // Check for duplicates
      const existingIds = new Set(
        pagination.workflows.map((w) => w.workflowId)
      );
      const duplicates = page.workflows.filter((w) =>
        existingIds.has(w.workflowId)
      );
      if (duplicates.length > 0) {
        showToast(
          `Pagination bug: ${duplicates.length} duplicate workflow(s)`,
          "error"
        );
      }

      setPagination((prev) => ({
        workflows: [...prev.workflows, ...page.workflows],
        total: page.total,
        nextCursor: page.nextCursor
      }));
    } catch (err) {
      console.error("Failed to load more:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (workflowId: string) => {
    try {
      await agent.call("approve", [workflowId, "Approved via UI"]);
    } catch (err) {
      console.error("Failed to approve:", err);
    }
  };

  const handleReject = async (workflowId: string, reason: string) => {
    try {
      await agent.call("reject", [workflowId, reason || "Rejected via UI"]);
    } catch (err) {
      console.error("Failed to reject:", err);
    }
  };

  const handleDismiss = async (workflowId: string) => {
    try {
      await agent.call("dismissWorkflow", [workflowId]);
    } catch (err) {
      console.error("Failed to dismiss:", err);
    }
  };

  const handleTerminate = async (workflowId: string) => {
    try {
      await agent.call("terminate", [workflowId]);
    } catch (err) {
      const message =
        err instanceof Error &&
        err.message.includes("not supported in local development")
          ? "Terminate is not supported in local dev. Deploy to Cloudflare to use this feature."
          : "Failed to terminate workflow";
      showToast(message);
    }
  };

  const handlePause = async (workflowId: string) => {
    try {
      await agent.call("pause", [workflowId]);
    } catch (err) {
      const message =
        err instanceof Error &&
        err.message.includes("not supported in local development")
          ? "Pause is not supported in local dev. Deploy to Cloudflare to use this feature."
          : "Failed to pause workflow";
      showToast(message);
    }
  };

  const handleResume = async (workflowId: string) => {
    try {
      await agent.call("resume", [workflowId]);
    } catch (err) {
      const message =
        err instanceof Error &&
        err.message.includes("not supported in local development")
          ? "Resume is not supported in local dev. Deploy to Cloudflare to use this feature."
          : "Failed to resume workflow";
      showToast(message);
    }
  };

  const handleRestart = async (workflowId: string) => {
    try {
      await agent.call("restart", [workflowId]);
    } catch (err) {
      const message =
        err instanceof Error &&
        err.message.includes("not supported in local development")
          ? "Restart is not supported in local dev. Deploy to Cloudflare to use this feature."
          : "Failed to restart workflow";
      showToast(message);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await agent.call("clearCompleted", []);
    } catch (err) {
      console.error("Failed to clear:", err);
    }
  };

  const hasCompletedWorkflows = pagination.workflows.some(
    (w) => w.status === "complete" || w.status === "errored"
  );

  return (
    <div className="container">
      <header>
        <h1>Workflow Demo</h1>
        <p className="subtitle">
          Multiple Concurrent Workflows with Human-in-the-Loop Approval
        </p>
      </header>

      {/* Connection status */}
      <div
        className={`connection-status ${connected ? "connected" : "disconnected"}`}
      >
        {connected ? "Connected" : "Connecting..."}
      </div>

      {/* Task submission form - always visible */}
      <form onSubmit={handleSubmit} className="task-form">
        <input
          type="text"
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
          placeholder="Enter task name (e.g., 'Generate Report')"
          className="task-input"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!taskName.trim()}
        >
          Start Task
        </button>
      </form>

      {/* Workflow list header */}
      {pagination.workflows.length > 0 && (
        <div className="workflow-list-header">
          <h2>
            Workflows ({pagination.workflows.length}
            {pagination.total > pagination.workflows.length &&
              ` of ${pagination.total}`}
            )
          </h2>
          {hasCompletedWorkflows && (
            <button
              type="button"
              onClick={handleClearCompleted}
              className="btn btn-small btn-secondary"
            >
              Clear Completed
            </button>
          )}
        </div>
      )}

      {/* Workflow list */}
      <div className="workflow-list">
        {pagination.workflows.map((workflow) => (
          <WorkflowCard
            key={workflow.workflowId}
            workflow={workflow}
            onApprove={handleApprove}
            onReject={handleReject}
            onDismiss={handleDismiss}
            onTerminate={handleTerminate}
            onPause={handlePause}
            onResume={handleResume}
            onRestart={handleRestart}
          />
        ))}
      </div>

      {/* Load more button */}
      {pagination.nextCursor && (
        <div className="load-more-section">
          <button
            type="button"
            onClick={handleLoadMore}
            className="btn btn-secondary"
          >
            Load More ({pagination.total - pagination.workflows.length}{" "}
            remaining)
          </button>
        </div>
      )}

      {/* Empty state */}
      {pagination.workflows.length === 0 && (
        <div className="empty-state">
          <p>No workflows yet. Start a task above to begin!</p>
        </div>
      )}

      {/* Feature list */}
      <footer className="features">
        <h4>This demo shows:</h4>
        <ul>
          <li>
            Multiple concurrent workflows with <code>runWorkflow()</code>
          </li>
          <li>
            Paginated workflow list via <code>getWorkflows()</code>
          </li>
          <li>
            Typed progress reporting with <code>reportProgress()</code>
          </li>
          <li>
            Human-in-the-loop with <code>waitForApproval()</code>
          </li>
          <li>
            Per-workflow approve/reject via <code>approveWorkflow()</code>
          </li>
          <li>
            Workflow termination via <code>terminateWorkflow()</code>
          </li>
        </ul>
      </footer>

      {/* Toast notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// Workflow card component
function WorkflowCard({
  workflow: rawWorkflow,
  onApprove,
  onReject,
  onDismiss,
  onTerminate,
  onPause,
  onResume,
  onRestart
}: {
  workflow: WorkflowItem;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  onDismiss: (id: string) => void;
  onTerminate: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRestart: (id: string) => void;
}) {
  const [rejectReason, setRejectReason] = useState("");
  // Cast to UI-safe type for rendering
  const workflow = rawWorkflow as WorkflowCardData;
  const percent = workflow.progress?.percent ?? 0;
  const message = workflow.progress?.message ?? "Processing...";

  return (
    <div className={`workflow-card status-${workflow.status}`}>
      {/* Header with task name and status */}
      <div className="workflow-header">
        <div className="workflow-title">
          <span className="task-name">{workflow.taskName}</span>
          <span className="workflow-id">{workflow.workflowId.slice(0, 8)}</span>
        </div>
        <StatusBadge status={workflow.status} />
      </div>

      {/* Progress bar for running/waiting workflows */}
      {(workflow.status === "running" ||
        workflow.status === "waiting" ||
        workflow.status === "queued") && (
        <div className="workflow-progress">
          <div className="progress-bar-container">
            <div
              className={`progress-bar ${workflow.waitingForApproval ? "waiting" : ""}`}
              style={{ width: `${percent * 100}%` }}
            />
          </div>
          <div className="progress-text">
            {Math.round(percent * 100)}% - {message}
          </div>
        </div>
      )}

      {/* Action buttons for running/queued workflows (not waiting for approval) */}
      {(workflow.status === "running" || workflow.status === "queued") &&
        !workflow.waitingForApproval && (
          <div className="workflow-actions">
            <button
              type="button"
              onClick={() => onPause(workflow.workflowId)}
              className="btn btn-secondary btn-small"
            >
              Pause
            </button>
            <button
              type="button"
              onClick={() => onTerminate(workflow.workflowId)}
              className="btn btn-danger btn-small"
            >
              Terminate
            </button>
          </div>
        )}

      {/* Resume button for paused workflows */}
      {workflow.status === "paused" && (
        <div className="workflow-actions">
          <button
            type="button"
            onClick={() => onResume(workflow.workflowId)}
            className="btn btn-primary btn-small"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={() => onTerminate(workflow.workflowId)}
            className="btn btn-danger btn-small"
          >
            Terminate
          </button>
        </div>
      )}

      {/* Approval buttons */}
      {workflow.waitingForApproval && (
        <div className="approval-actions">
          <button
            type="button"
            onClick={() => onApprove(workflow.workflowId)}
            className="btn btn-success btn-small"
          >
            Approve
          </button>
          <div className="reject-group">
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason (optional)"
              className="reject-input"
            />
            <button
              type="button"
              onClick={() => {
                onReject(workflow.workflowId, rejectReason);
                setRejectReason("");
              }}
              className="btn btn-danger btn-small"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Completed result */}
      {workflow.status === "complete" && workflow.result && (
        <div className="workflow-result">
          <pre className="result-data">
            {JSON.stringify(workflow.result, null, 2)}
          </pre>
          <div className="workflow-actions">
            <button
              type="button"
              onClick={() => onRestart(workflow.workflowId)}
              className="btn btn-primary btn-small"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={() => onDismiss(workflow.workflowId)}
              className="btn btn-secondary btn-small"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Error display */}
      {workflow.status === "errored" && (
        <div className="workflow-error">
          <p className="error-message">{workflow.error?.message}</p>
          <div className="workflow-actions">
            <button
              type="button"
              onClick={() => onRestart(workflow.workflowId)}
              className="btn btn-primary btn-small"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={() => onDismiss(workflow.workflowId)}
              className="btn btn-secondary btn-small"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Status badge component
function StatusBadge({ status }: { status: WorkflowItem["status"] }) {
  const labels: Record<WorkflowItem["status"], string> = {
    queued: "Queued",
    running: "Running",
    waiting: "Awaiting Approval",
    complete: "Complete",
    errored: "Error",
    paused: "Paused"
  };

  return (
    <span className={`status-badge badge-${status}`}>{labels[status]}</span>
  );
}
