import { useAgent } from "agents/react";
import { useState } from "react";
import {
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  PaperPlaneTiltIcon,
  TrashIcon,
  WarningCircleIcon,
  ArrowsClockwiseIcon
} from "@phosphor-icons/react";
import {
  Button,
  Input,
  InputArea,
  Surface,
  Empty,
  Text
} from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type {
  ApprovalAgent,
  ApprovalAgentState,
  ApprovalRequest
} from "./approval-agent";

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
    pending: <ClockIcon size={20} className="text-kumo-warning" />,
    approved: <CheckCircleIcon size={20} className="text-kumo-success" />,
    rejected: <XCircleIcon size={20} className="text-kumo-danger" />
  };

  const statusBorder = {
    pending: "border-l-4 border-l-kumo-warning",
    approved: "border-l-4 border-l-green-500",
    rejected: "border-l-4 border-l-kumo-danger"
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
    <Surface
      className={`p-4 rounded-lg ring ring-kumo-line ${statusBorder[request.status]}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {statusIcons[request.status]}
          <Text bold>{request.title}</Text>
        </div>
        <span className="text-xs text-kumo-subtle">
          {timeAgo(request.createdAt)}
        </span>
      </div>

      <p className="text-sm text-kumo-subtle mb-3">{request.description}</p>

      {request.status === "pending" && (
        <div className="space-y-2">
          {!showRejectForm ? (
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => onApprove(request.id)}
                icon={<CheckCircleIcon size={16} />}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                onClick={() => setShowRejectForm(true)}
                icon={<XCircleIcon size={16} />}
              >
                Reject
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                aria-label="Rejection reason"
                type="text"
                value={rejectReason}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setRejectReason(e.target.value)
                }
                placeholder="Reason for rejection (optional)"
                className="w-full"
              />
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  onClick={() => {
                    onReject(request.id, rejectReason || undefined);
                    setShowRejectForm(false);
                    setRejectReason("");
                  }}
                >
                  Confirm Reject
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowRejectForm(false);
                    setRejectReason("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {request.status !== "pending" && request.resolvedAt && (
        <div className="text-xs text-kumo-subtle border-t border-kumo-fill pt-2 mt-2">
          <div>
            {request.status === "approved" ? "Approved" : "Rejected"} at{" "}
            {new Date(request.resolvedAt).toLocaleTimeString()}
          </div>
          {request.reason && <div>Reason: {request.reason}</div>}
        </div>
      )}
    </Surface>
  );
}

export function WorkflowApprovalDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);

  const agent = useAgent<ApprovalAgent, ApprovalAgentState>({
    agent: "approval-agent",
    name: `workflow-approval-${userId}`,
    onStateUpdate: () => {
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
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Create Request */}
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Submit Request</Text>
            </div>
            <div className="space-y-3">
              <Input
                label="Title"
                type="text"
                value={title}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setTitle(e.target.value)
                }
                className="w-full"
                placeholder="What needs approval?"
              />
              <InputArea
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full"
                rows={3}
                placeholder="Provide details..."
              />
              <Button
                variant="primary"
                onClick={handleSubmitRequest}
                disabled={isSubmitting || !title.trim() || !description.trim()}
                className="w-full"
                icon={<PaperPlaneTiltIcon size={16} />}
              >
                {isSubmitting ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </Surface>

          {/* Quick Presets */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-3">
              <Text bold size="sm">
                Quick Presets
              </Text>
            </div>
            <div className="space-y-2">
              {presetRequests.map((preset) => (
                <button
                  key={preset.title}
                  type="button"
                  onClick={() => {
                    setTitle(preset.title);
                    setDescription(preset.description);
                  }}
                  className="w-full text-left p-2 text-xs bg-kumo-elevated hover:bg-kumo-tint rounded transition-colors text-kumo-default"
                >
                  {preset.title}
                </button>
              ))}
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="mb-2">
              <Text variant="heading3">How it Works</Text>
            </div>
            <ul className="text-sm text-kumo-subtle space-y-1">
              <li>
                1.{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  runWorkflow()
                </code>{" "}
                starts an ApprovalWorkflow
              </li>
              <li>
                2.{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  waitForApproval()
                </code>{" "}
                pauses the workflow
              </li>
              <li>3. Human clicks Approve or Reject</li>
              <li>
                4.{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  approveWorkflow()
                </code>{" "}
                or{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  rejectWorkflow()
                </code>{" "}
                resumes it
              </li>
            </ul>
          </Surface>
        </div>

        {/* Center Panel - Approval Queue */}
        <div className="space-y-6">
          {/* Pending Requests */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <WarningCircleIcon size={16} className="text-kumo-warning" />
                <Text variant="heading3">
                  Pending Approval ({pendingRequests.length})
                </Text>
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={refreshRequests}
                icon={<ArrowsClockwiseIcon size={12} />}
              >
                Refresh
              </Button>
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
              <Surface className="p-6 rounded-lg ring ring-kumo-line">
                <Empty title="No pending approvals" size="sm" />
              </Surface>
            )}
          </div>

          {/* History */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <Text variant="heading3">
                History ({resolvedRequests.length})
              </Text>
              {resolvedRequests.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleClearApprovals}
                  icon={<TrashIcon size={12} />}
                  className="text-kumo-danger"
                >
                  Clear
                </Button>
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
              <Surface className="p-6 rounded-lg ring ring-kumo-line">
                <Empty title="No resolved requests" size="sm" />
              </Surface>
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
