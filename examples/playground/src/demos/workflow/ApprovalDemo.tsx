import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type {
  ApprovalAgent,
  ApprovalAgentState,
  ApprovalRequest
} from "./approval-agent";
import {
  Clock,
  CheckCircle,
  XCircle,
  Send,
  Trash2,
  AlertCircle,
  RefreshCw
} from "lucide-react";

function ApprovalCard({
  request,
  onApprove,
  onReject
}: {
  request: ApprovalRequest;
  onApprove: (id: string) => void;
  onReject: (id: string, reason?: string) => void;
}) {
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);

  const statusIcons = {
    pending: <Clock className="w-5 h-5 text-yellow-500" />,
    approved: <CheckCircle className="w-5 h-5 text-green-500" />,
    rejected: <XCircle className="w-5 h-5 text-red-500" />
  };

  const statusBg = {
    pending: "border-l-4 border-l-yellow-500",
    approved: "border-l-4 border-l-green-500",
    rejected: "border-l-4 border-l-red-500"
  };

  const timeAgo = (date: string) => {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  return (
    <div className={`card p-4 ${statusBg[request.status]}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {statusIcons[request.status]}
          <h4 className="font-medium">{request.title}</h4>
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {timeAgo(request.createdAt)}
        </span>
      </div>

      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
        {request.description}
      </p>

      {request.status === "pending" && (
        <div className="space-y-2">
          {!showRejectForm ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onApprove(request.id)}
                className="btn btn-primary flex-1 flex items-center justify-center gap-1"
              >
                <CheckCircle className="w-4 h-4" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => setShowRejectForm(true)}
                className="btn flex-1 flex items-center justify-center gap-1 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-200 hover:bg-red-200 dark:hover:bg-red-800"
              >
                <XCircle className="w-4 h-4" />
                Reject
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection (optional)"
                className="input w-full text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onReject(request.id, rejectReason || undefined);
                    setShowRejectForm(false);
                    setRejectReason("");
                  }}
                  className="btn flex-1 bg-red-600 text-white hover:bg-red-700"
                >
                  Confirm Reject
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowRejectForm(false);
                    setRejectReason("");
                  }}
                  className="btn flex-1"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {request.status !== "pending" && request.resolvedAt && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-700 pt-2 mt-2">
          <div>
            {request.status === "approved" ? "Approved" : "Rejected"} at{" "}
            {new Date(request.resolvedAt).toLocaleTimeString()}
          </div>
          {request.reason && <div>Reason: {request.reason}</div>}
        </div>
      )}
    </div>
  );
}

export function WorkflowApprovalDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);

  const agent = useAgent<ApprovalAgent, ApprovalAgentState>({
    agent: "approval-agent",
    name: "demo",
    onStateUpdate: () => {
      // State is empty, but we refresh on any update
      refreshRequests();
    },
    onOpen: () => {
      addLog("info", "connected");
      refreshRequests();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (message) => {
      try {
        const data = JSON.parse(message.data as string);
        if (data.type) {
          addLog("in", data.type, data);
          // Refresh on approval events
          if (data.type.startsWith("approval_")) {
            refreshRequests();
          }
        }
      } catch {
        // ignore
      }
    }
  });

  const refreshRequests = async () => {
    try {
      // Type assertion needed - SDK type inference has issues with array return types
      const list = await (
        agent.call as (m: string) => Promise<ApprovalRequest[]>
      )("listRequests");
      setRequests(list);
    } catch {
      // ignore - might not be connected yet
    }
  };

  const handleSubmitRequest = async () => {
    if (!title.trim() || !description.trim()) return;

    setIsSubmitting(true);
    addLog("out", "requestApproval", { title, description });

    try {
      await agent.call("requestApproval", [title, description]);
      setTitle("");
      setDescription("");
      await refreshRequests();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApprove = async (requestId: string) => {
    addLog("out", "approve", { requestId });
    try {
      await agent.call("approve", [requestId]);
      await refreshRequests();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleReject = async (requestId: string, reason?: string) => {
    addLog("out", "reject", { requestId, reason });
    try {
      await agent.call("reject", [requestId, reason]);
      await refreshRequests();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleClearApprovals = async () => {
    addLog("out", "clearApprovals");
    try {
      const result = await agent.call("clearApprovals");
      addLog("in", "cleared", { count: result });
      await refreshRequests();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const pendingRequests = requests.filter((r) => r.status === "pending");
  const resolvedRequests = requests.filter((r) => r.status !== "pending");

  const presetRequests = [
    {
      title: "Deploy to Production",
      description: "Release v2.3.0 with new features"
    },
    {
      title: "Access Request - Admin Panel",
      description: "Need admin access for debugging"
    },
    {
      title: "Expense Report - $450",
      description: "Team offsite dinner and supplies"
    }
  ];

  return (
    <DemoWrapper
      title="Approval Workflow"
      description="Human-in-the-loop workflow patterns using waitForApproval(). Workflows pause until approved or rejected."
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Create Request */}
        <div className="space-y-6">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold mb-4">Submit Request</h3>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="request-title"
                  className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1"
                >
                  Title
                </label>
                <input
                  id="request-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="input w-full"
                  placeholder="What needs approval?"
                />
              </div>
              <div>
                <label
                  htmlFor="request-description"
                  className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1"
                >
                  Description
                </label>
                <textarea
                  id="request-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="input w-full h-20 resize-none"
                  placeholder="Provide details..."
                />
              </div>
              <button
                type="button"
                onClick={handleSubmitRequest}
                disabled={isSubmitting || !title.trim() || !description.trim()}
                className="btn btn-primary w-full flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                {isSubmitting ? "Submitting..." : "Submit Request"}
              </button>
            </div>
          </div>

          {/* Quick Presets */}
          <div className="card p-4">
            <h3 className="font-semibold mb-3 text-sm">Quick Presets</h3>
            <div className="space-y-2">
              {presetRequests.map((preset) => (
                <button
                  key={preset.title}
                  type="button"
                  onClick={() => {
                    setTitle(preset.title);
                    setDescription(preset.description);
                  }}
                  className="w-full text-left p-2 text-xs bg-neutral-50 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded transition-colors"
                >
                  {preset.title}
                </button>
              ))}
            </div>
          </div>

          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold mb-2">How it Works</h3>
            <ul className="text-sm text-neutral-600 dark:text-neutral-300 space-y-1">
              <li>
                1.{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  runWorkflow()
                </code>{" "}
                starts an ApprovalWorkflow
              </li>
              <li>
                2.{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  waitForApproval()
                </code>{" "}
                pauses the workflow
              </li>
              <li>3. Human clicks Approve or Reject</li>
              <li>
                4.{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  approveWorkflow()
                </code>{" "}
                or{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  rejectWorkflow()
                </code>{" "}
                resumes it
              </li>
            </ul>
          </div>
        </div>

        {/* Center Panel - Approval Queue */}
        <div className="space-y-6">
          {/* Pending Requests */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-yellow-500" />
                <h3 className="font-semibold">
                  Pending Approval ({pendingRequests.length})
                </h3>
              </div>
              <button
                type="button"
                onClick={refreshRequests}
                className="text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Refresh
              </button>
            </div>
            {pendingRequests.length > 0 ? (
              <div className="space-y-3">
                {pendingRequests.map((request) => (
                  <ApprovalCard
                    key={request.id}
                    request={request}
                    onApprove={handleApprove}
                    onReject={handleReject}
                  />
                ))}
              </div>
            ) : (
              <div className="card p-6 text-center text-neutral-400 text-sm">
                No pending approvals
              </div>
            )}
          </div>

          {/* History */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                History ({resolvedRequests.length})
              </h3>
              {resolvedRequests.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearApprovals}
                  className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>
            {resolvedRequests.length > 0 ? (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {resolvedRequests.map((request) => (
                  <ApprovalCard
                    key={request.id}
                    request={request}
                    onApprove={handleApprove}
                    onReject={handleReject}
                  />
                ))}
              </div>
            ) : (
              <div className="card p-6 text-center text-neutral-400 text-sm">
                No resolved requests
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="500px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
