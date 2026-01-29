import { useAgent } from "agents/react";
import { useState } from "react";
import type { AgentState } from "./server";

const initialState: AgentState = {
  currentWorkflowId: null,
  currentTaskName: null,
  progress: null,
  waitingForApproval: false,
  status: "idle",
  result: null,
  error: null
};

export default function App() {
  const [taskName, setTaskName] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [state, setState] = useState<AgentState>(initialState);
  const [connected, setConnected] = useState(false);

  const agent = useAgent<AgentState>({
    agent: "TaskAgent",
    onStateUpdate: (newState) => {
      setState(newState);
    },
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false)
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskName.trim()) return;

    try {
      await agent.call("submitTask", [taskName]);
      setTaskName("");
    } catch (err) {
      console.error("Failed to submit task:", err);
    }
  };

  const handleApprove = async () => {
    try {
      await agent.call("approve", ["Approved via UI"]);
    } catch (err) {
      console.error("Failed to approve:", err);
    }
  };

  const handleReject = async () => {
    try {
      await agent.call("reject", [rejectReason || "Rejected via UI"]);
      setRejectReason("");
    } catch (err) {
      console.error("Failed to reject:", err);
    }
  };

  const handleReset = async () => {
    try {
      await agent.call("reset", []);
    } catch (err) {
      console.error("Failed to reset:", err);
    }
  };

  const percent = state.progress?.percent ?? 0;

  return (
    <div className="container">
      <header>
        <h1>Workflow Demo</h1>
        <p className="subtitle">
          Task Processing with Human-in-the-Loop Approval
        </p>
      </header>

      {/* Connection status */}
      <div
        className={`connection-status ${connected ? "connected" : "disconnected"}`}
      >
        {connected ? "Connected" : "Connecting..."}
      </div>

      {/* Task submission form */}
      {state.status === "idle" && (
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
      )}

      {/* Progress display */}
      {(state.status === "running" || state.status === "waiting") && (
        <div className="progress-section">
          <div className="task-info">
            <span className="label">Task:</span>
            <span className="value">{state.currentTaskName}</span>
          </div>
          <div className="task-info">
            <span className="label">Step:</span>
            <span className="value">{state.progress?.step || "starting"}</span>
          </div>

          <div className="progress-bar-container">
            <div
              className={`progress-bar ${state.waitingForApproval ? "waiting" : ""}`}
              style={{ width: `${percent * 100}%` }}
            />
          </div>
          <div className="progress-text">
            {Math.round(percent * 100)}% -{" "}
            {state.progress?.message || "Processing..."}
          </div>
        </div>
      )}

      {/* Approval buttons */}
      {state.waitingForApproval && (
        <div className="approval-section">
          <h3>Approval Required</h3>
          <p>The workflow is waiting for your approval to continue.</p>
          <div className="approval-buttons">
            <button
              type="button"
              onClick={handleApprove}
              className="btn btn-success"
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
                onClick={handleReject}
                className="btn btn-danger"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Completion display */}
      {state.status === "completed" && (
        <div className="result-section success">
          <h3>Task Completed</h3>
          <pre className="result-data">
            {JSON.stringify(state.result, null, 2)}
          </pre>
          <button
            type="button"
            onClick={handleReset}
            className="btn btn-primary"
          >
            Start New Task
          </button>
        </div>
      )}

      {/* Error display */}
      {state.status === "error" && (
        <div className="result-section error">
          <h3>Task Failed</h3>
          <p className="error-message">{state.error}</p>
          <button
            type="button"
            onClick={handleReset}
            className="btn btn-primary"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Feature list */}
      <footer className="features">
        <h4>This demo shows:</h4>
        <ul>
          <li>
            Multi-step workflow with <code>step.do()</code>
          </li>
          <li>
            Typed progress reporting with <code>reportProgress()</code>
          </li>
          <li>
            Human-in-the-loop with <code>waitForApproval()</code>
          </li>
          <li>
            State sync with <code>mergeAgentState()</code>
          </li>
          <li>
            Approve/reject via <code>approveWorkflow()</code> /{" "}
            <code>rejectWorkflow()</code>
          </li>
        </ul>
      </footer>
    </div>
  );
}
