/**
 * Workflow Example - React Client
 *
 * Demonstrates workflows with real-time state updates including:
 * - Quick analysis (runs in Agent, ~30s)
 * - Deep analysis (runs in Workflow, can pause for approval, schedule follow-ups)
 */

import { useState, useRef, useCallback } from "react";
import { useAgent } from "../../../packages/agents/src/react";

interface SecurityIssue {
  severity: "low" | "medium" | "high" | "critical";
  file: string;
  description: string;
  recommendation: string;
}

type TaskResult = {
  repoUrl: string;
  branch: string;
  summary: string;
  architecture: string;
  techStack: string[];
  suggestions: string[];
  fileCount: number;
  analyzedAt: string;
  // Deep analysis fields
  securityIssues?: SecurityIssue[];
  codePatterns?: string[];
  dependencies?: { name: string; version: string; type: string }[];
  analyzedFiles?: number;
  approvalStatus?: "pending" | "approved" | "rejected" | "auto-approved";
  approvedBy?: string;
  approvedAt?: string;
  followUpScheduled?: boolean;
  workflowDuration?: string;
};

type TaskStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed";

interface TaskData {
  id: string;
  type: "quick" | "deep";
  status: TaskStatus;
  progress?: number;
  result?: TaskResult;
  error?: string;
  workflowInstanceId?: string;
  events: Array<{
    type: string;
    data?: unknown;
    timestamp: number;
  }>;
}

type AgentState = {
  tasks: Record<string, TaskData>;
};

function App() {
  const [repoUrl, setRepoUrl] = useState(
    "https://github.com/cloudflare/agents"
  );
  const [branch, setBranch] = useState("main");
  const [requireApproval, setRequireApproval] = useState(true);
  const [scheduleFollowUp, setScheduleFollowUp] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);

  // Track state from agent
  const [agentState, setAgentState] = useState<AgentState>({ tasks: {} });

  // Use agent with state callback
  const agent = useAgent({
    agent: "task-runner",
    name: "default",
    onStateUpdate: (state) => {
      setAgentState(state as AgentState);
    }
  });

  const tasks = agentState?.tasks || {};
  const taskList = Object.values(tasks).sort(
    (a, b) => (b.events?.[0]?.timestamp || 0) - (a.events?.[0]?.timestamp || 0)
  );

  // Start quick analysis (runs in Agent - no durability, ~30s max)
  const startQuickAnalysis = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);

    try {
      await agent.call("quickAnalysis", [{ repoUrl, branch }]);
    } catch (e) {
      console.error("Failed to start quick analysis:", e);
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [agent, repoUrl, branch]);

  // Start deep analysis (runs in Workflow - durable, can pause for approval)
  const startDeepAnalysis = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);

    try {
      await agent.call("startAnalysis", [
        { repoUrl, branch, requireApproval, scheduleFollowUp }
      ]);
    } catch (e) {
      console.error("Failed to start deep analysis:", e);
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [agent, repoUrl, branch, requireApproval, scheduleFollowUp]);

  const abortTask = useCallback(
    async (taskId: string) => {
      try {
        await agent.call("abortTask", [taskId]);
      } catch {
        // Failed to abort
      }
    },
    [agent]
  );

  // Approve or reject a task waiting for approval
  const handleApproval = useCallback(
    async (taskId: string, approved: boolean) => {
      try {
        const approver = prompt("Enter your name for the approval record:");
        if (!approver) return;

        const comment = approved
          ? prompt("Optional comment:")
          : prompt("Reason for rejection:");

        await agent.call("approveTask", [
          { taskId, approved, approver, comment: comment || undefined }
        ]);
      } catch (e) {
        console.error("Failed to submit approval:", e);
      }
    },
    [agent]
  );

  return (
    <div className="app">
      <header>
        <h1>Repo Analyzer</h1>
        <p>AI-powered repository analysis with real-time updates</p>
      </header>

      <section className="create-task">
        <h2>Analyze Repository</h2>
        <div className="form">
          <label>
            Repository URL:
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
            />
          </label>
          <label>
            Branch:
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </label>
        </div>

        <div className="analysis-options">
          <h3>Deep Analysis Options (Workflow-only features)</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
            />
            <span>
              <strong>Require approval for critical issues</strong>
              <small>
                Workflow pauses and waits for human approval (can wait days!)
              </small>
            </span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={scheduleFollowUp}
              onChange={(e) => setScheduleFollowUp(e.target.checked)}
            />
            <span>
              <strong>Schedule follow-up reminder</strong>
              <small>
                Workflow sleeps then sends reminder (demonstrates step.sleep)
              </small>
            </span>
          </label>
        </div>

        <div className="buttons">
          <button
            type="button"
            onClick={startQuickAnalysis}
            className="primary"
            disabled={isStarting}
          >
            {isStarting ? "Starting..." : "Quick Analysis"}
          </button>
          <button
            type="button"
            onClick={startDeepAnalysis}
            className="secondary"
            disabled={isStarting}
          >
            {isStarting ? "Starting..." : "Deep Analysis (Workflow)"}
          </button>
        </div>

        <div className="comparison">
          <div className="comparison-item">
            <h4>Quick Analysis</h4>
            <ul>
              <li>Runs in Agent (Durable Object)</li>
              <li>~30 second timeout</li>
              <li>Basic analysis only</li>
              <li>No durability guarantees</li>
            </ul>
          </div>
          <div className="comparison-item workflow">
            <h4>Deep Analysis (Workflow)</h4>
            <ul>
              <li>Runs in Cloudflare Workflow</li>
              <li>Can run for hours/days</li>
              <li>Security scanning + patterns</li>
              <li>Human-in-the-loop approval</li>
              <li>Scheduled follow-ups</li>
              <li>Automatic retries</li>
              <li>Survives restarts</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="tasks">
        <h2>Tasks ({taskList.length})</h2>
        {taskList.length === 0 ? (
          <p className="empty">No tasks yet. Start an analysis above!</p>
        ) : (
          <div className="task-list">
            {taskList.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onAbort={abortTask}
                onApprove={handleApproval}
              />
            ))}
          </div>
        )}
      </section>

      <style>{`
        .app {
          max-width: 800px;
          margin: 0 auto;
          padding: 2rem;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        header {
          text-align: center;
          margin-bottom: 2rem;
        }

        header h1 {
          font-size: 2.5rem;
          margin-bottom: 0.5rem;
        }

        header p {
          color: #666;
        }

        section {
          margin-bottom: 2rem;
        }

        h2 {
          font-size: 1.25rem;
          margin-bottom: 1rem;
          padding-bottom: 0.5rem;
          border-bottom: 2px solid #eee;
        }

        .form {
          display: flex;
          gap: 1rem;
          align-items: flex-end;
          flex-wrap: wrap;
          margin-bottom: 1rem;
        }

        label {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          font-size: 0.875rem;
          color: #555;
        }

        input {
          padding: 0.5rem 0.75rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }

        input[type="text"] {
          min-width: 300px;
        }

        .buttons {
          display: flex;
          gap: 1rem;
        }

        button {
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        button.primary {
          background: linear-gradient(135deg, #0066ff, #0052cc);
          color: white;
        }

        button.primary:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 102, 255, 0.3);
        }

        button.secondary {
          background: linear-gradient(135deg, #7c3aed, #5b21b6);
          color: white;
        }

        button.secondary:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
        }

        button.danger {
          background: #ff4444;
          color: white;
          font-size: 0.75rem;
          padding: 0.5rem 1rem;
        }

        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .empty {
          color: #999;
          text-align: center;
          padding: 2rem;
        }

        .task-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .analysis-options {
          background: #f8f9fa;
          padding: 1rem;
          border-radius: 8px;
          margin-bottom: 1rem;
        }

        .analysis-options h3 {
          font-size: 0.875rem;
          margin: 0 0 0.75rem 0;
          color: #495057;
        }

        .checkbox-label {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          cursor: pointer;
          margin-bottom: 0.5rem;
        }

        .checkbox-label input[type="checkbox"] {
          margin-top: 0.25rem;
        }

        .checkbox-label span {
          display: flex;
          flex-direction: column;
        }

        .checkbox-label strong {
          font-size: 0.875rem;
        }

        .checkbox-label small {
          font-size: 0.75rem;
          color: #6c757d;
        }

        .comparison {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
          margin-top: 1.5rem;
          font-size: 0.8rem;
        }

        .comparison-item {
          background: #f8f9fa;
          padding: 1rem;
          border-radius: 8px;
          border: 1px solid #e9ecef;
        }

        .comparison-item.workflow {
          background: linear-gradient(135deg, #f3e8ff, #ede9fe);
          border-color: #c4b5fd;
        }

        .comparison-item h4 {
          margin: 0 0 0.5rem 0;
          font-size: 0.875rem;
        }

        .comparison-item ul {
          margin: 0;
          padding-left: 1.25rem;
          color: #495057;
        }

        .comparison-item li {
          margin-bottom: 0.25rem;
        }
      `}</style>
    </div>
  );
}

function TaskCard({
  task,
  onAbort,
  onApprove
}: {
  task: TaskData;
  onAbort: (id: string) => void;
  onApprove: (id: string, approved: boolean) => void;
}) {
  const getStatusColor = () => {
    switch (task.status) {
      case "pending":
        return "#888";
      case "running":
        return "#0066ff";
      case "awaiting-approval":
        return "#f59e0b";
      case "completed":
        return "#00aa44";
      case "failed":
        return "#ff4444";
      default:
        return "#888";
    }
  };

  const getStatusLabel = () => {
    switch (task.status) {
      case "pending":
        return "[pending]";
      case "running":
        return "[running]";
      case "awaiting-approval":
        return "[NEEDS APPROVAL]";
      case "completed":
        return "[done]";
      case "failed":
        return "[failed]";
      default:
        return "[?]";
    }
  };

  const isRunning = task.status === "pending" || task.status === "running";
  const isAwaitingApproval = task.status === "awaiting-approval";

  return (
    <div className="task-card">
      <div className="task-header">
        <span className="task-status" style={{ color: getStatusColor() }}>
          {getStatusLabel()} {task.type === "deep" ? "(workflow)" : ""}
        </span>
        <span className="task-id">{task.id.slice(0, 16)}...</span>
      </div>

      {isRunning && task.progress !== undefined && (
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${task.progress}%` }}
          />
          <span className="progress-text">{Math.round(task.progress)}%</span>
        </div>
      )}

      {task.events && task.events.length > 0 && (
        <div className="task-events">
          {task.events.slice(-3).map((event, i) => (
            <div
              key={`${event.type}-${event.timestamp}-${i}`}
              className="event"
            >
              <span className="event-type">{event.type}</span>
              {event.data !== undefined && (
                <span className="event-data">
                  {String(JSON.stringify(event.data))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {isAwaitingApproval && (
        <div className="approval-section">
          <div className="approval-header">
            <strong>Security Approval Required</strong>
            <p>
              Critical security issues were found. Please review and approve or
              reject.
            </p>
          </div>
          <div className="approval-buttons">
            <button
              type="button"
              className="approve"
              onClick={() => onApprove(task.id, true)}
            >
              Approve
            </button>
            <button
              type="button"
              className="reject"
              onClick={() => onApprove(task.id, false)}
            >
              Reject
            </button>
          </div>
          <p className="approval-note">
            The workflow is hibernating while waiting - no compute cost!
          </p>
        </div>
      )}

      {task.status === "completed" && task.result && (
        <div className="task-result">
          {/* Workflow-specific metadata */}
          {task.result.workflowDuration && (
            <div className="workflow-meta">
              <span>Workflow completed in {task.result.workflowDuration}</span>
              {task.result.approvalStatus && (
                <span
                  className={`approval-badge ${task.result.approvalStatus}`}
                >
                  {task.result.approvalStatus}
                  {task.result.approvedBy && ` by ${task.result.approvedBy}`}
                </span>
              )}
              {task.result.followUpScheduled && (
                <span className="follow-up-badge">Follow-up scheduled</span>
              )}
            </div>
          )}

          <div className="result-section">
            <strong>Summary</strong>
            <p>{task.result.summary}</p>
          </div>
          <div className="result-section">
            <strong>Architecture</strong>
            <p>{task.result.architecture}</p>
          </div>
          {task.result.techStack && task.result.techStack.length > 0 && (
            <div className="result-section">
              <strong>Tech Stack</strong>
              <div className="tags">
                {task.result.techStack.map((tech) => (
                  <span key={tech} className="tag">
                    {tech}
                  </span>
                ))}
              </div>
            </div>
          )}
          {task.result.codePatterns && task.result.codePatterns.length > 0 && (
            <div className="result-section">
              <strong>Code Patterns</strong>
              <div className="tags">
                {task.result.codePatterns.map((pattern) => (
                  <span key={pattern} className="tag pattern">
                    {pattern}
                  </span>
                ))}
              </div>
            </div>
          )}
          {task.result.securityIssues &&
            task.result.securityIssues.length > 0 && (
              <div className="result-section security">
                <strong>
                  Security Issues ({task.result.securityIssues.length})
                </strong>
                <div className="security-issues">
                  {task.result.securityIssues.map((issue) => (
                    <div
                      key={`${issue.file}-${issue.description.slice(0, 20)}`}
                      className={`security-issue ${issue.severity}`}
                    >
                      <span className="severity">{issue.severity}</span>
                      <span className="file">{issue.file}</span>
                      <p>{issue.description}</p>
                      <p className="recommendation">{issue.recommendation}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          {task.result.suggestions && task.result.suggestions.length > 0 && (
            <div className="result-section">
              <strong>Suggestions</strong>
              <ul>
                {task.result.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="result-meta">
            {task.result.fileCount} files in repo
            {task.result.analyzedFiles &&
              `, ${task.result.analyzedFiles} analyzed`}{" "}
            at {new Date(task.result.analyzedAt).toLocaleString()}
          </div>
        </div>
      )}

      {task.status === "failed" && task.error && (
        <div className="task-error">
          <strong>Error:</strong> {task.error}
        </div>
      )}

      {isRunning && (
        <div className="task-actions">
          <button
            type="button"
            className="danger"
            onClick={() => onAbort(task.id)}
          >
            Abort
          </button>
        </div>
      )}

      <style>{`
        .task-card {
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 1rem;
          background: white;
          overflow: hidden;
          max-width: 100%;
        }

        .task-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.75rem;
        }

        .task-status {
          font-weight: 600;
          font-size: 0.875rem;
        }

        .task-id {
          font-family: monospace;
          font-size: 0.75rem;
          color: #888;
        }

        .progress-bar {
          position: relative;
          height: 24px;
          background: #eee;
          border-radius: 12px;
          overflow: hidden;
          margin-bottom: 0.75rem;
        }

        .progress-fill {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          background: linear-gradient(90deg, #0066ff, #00aaff);
          transition: width 0.3s ease;
        }

        .progress-text {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 0.75rem;
          font-weight: 600;
          color: #333;
        }

        .task-events {
          font-size: 0.75rem;
          margin-bottom: 0.75rem;
        }

        .event {
          display: flex;
          gap: 0.5rem;
          padding: 0.25rem 0;
          border-bottom: 1px solid #f0f0f0;
          overflow: hidden;
        }

        .event-type {
          font-weight: 600;
          color: #0066ff;
          flex-shrink: 0;
        }

        .event-data {
          color: #666;
          font-family: monospace;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .task-result {
          background: #f8f9fa;
          padding: 1rem;
          border-radius: 8px;
          font-size: 0.875rem;
          margin-bottom: 0.75rem;
          border: 1px solid #e9ecef;
          overflow: hidden;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }

        .result-section {
          margin-bottom: 1rem;
          overflow: hidden;
        }

        .result-section:last-of-type {
          margin-bottom: 0;
        }

        .result-section strong {
          display: block;
          color: #495057;
          margin-bottom: 0.25rem;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .result-section p {
          margin: 0;
          color: #212529;
          line-height: 1.5;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }

        .result-section ul {
          margin: 0;
          padding-left: 1.25rem;
          color: #495057;
        }

        .result-section li {
          margin-bottom: 0.25rem;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }

        .tags {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          max-width: 100%;
        }

        .tag {
          background: #0066ff15;
          color: #0066ff;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 500;
          word-break: break-word;
          max-width: 100%;
        }

        .result-meta {
          margin-top: 1rem;
          padding-top: 0.75rem;
          border-top: 1px solid #e9ecef;
          font-size: 0.75rem;
          color: #6c757d;
        }

        .task-error {
          background: #ffebee;
          padding: 0.5rem;
          border-radius: 4px;
          font-size: 0.875rem;
          color: #c62828;
          margin-bottom: 0.75rem;
        }

        .task-actions {
          display: flex;
          gap: 0.5rem;
        }

        .approval-section {
          background: linear-gradient(135deg, #fef3c7, #fde68a);
          border: 2px solid #f59e0b;
          padding: 1rem;
          border-radius: 8px;
          margin-bottom: 0.75rem;
        }

        .approval-header strong {
          color: #92400e;
          font-size: 1rem;
        }

        .approval-header p {
          margin: 0.5rem 0;
          color: #78350f;
          font-size: 0.875rem;
        }

        .approval-buttons {
          display: flex;
          gap: 0.5rem;
          margin-top: 0.75rem;
        }

        .approval-buttons button.approve {
          background: #10b981;
          color: white;
        }

        .approval-buttons button.reject {
          background: #ef4444;
          color: white;
        }

        .approval-note {
          margin-top: 0.5rem;
          font-size: 0.75rem;
          color: #92400e;
          font-style: italic;
        }

        .workflow-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 1rem;
          padding-bottom: 0.75rem;
          border-bottom: 1px solid #e9ecef;
          font-size: 0.75rem;
        }

        .approval-badge {
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-weight: 500;
        }

        .approval-badge.approved {
          background: #d1fae5;
          color: #065f46;
        }

        .approval-badge.rejected {
          background: #fee2e2;
          color: #991b1b;
        }

        .approval-badge.auto-approved {
          background: #fef3c7;
          color: #92400e;
        }

        .follow-up-badge {
          background: #ede9fe;
          color: #5b21b6;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-weight: 500;
        }

        .tag.pattern {
          background: #fef3c7;
          color: #92400e;
        }

        .security-issues {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .security-issue {
          padding: 0.5rem;
          border-radius: 4px;
          font-size: 0.8rem;
        }

        .security-issue.critical {
          background: #fee2e2;
          border-left: 3px solid #dc2626;
        }

        .security-issue.high {
          background: #ffedd5;
          border-left: 3px solid #ea580c;
        }

        .security-issue.medium {
          background: #fef3c7;
          border-left: 3px solid #d97706;
        }

        .security-issue.low {
          background: #f0fdf4;
          border-left: 3px solid #16a34a;
        }

        .security-issue .severity {
          display: inline-block;
          padding: 0.125rem 0.375rem;
          border-radius: 3px;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          margin-right: 0.5rem;
        }

        .security-issue.critical .severity { background: #dc2626; color: white; }
        .security-issue.high .severity { background: #ea580c; color: white; }
        .security-issue.medium .severity { background: #d97706; color: white; }
        .security-issue.low .severity { background: #16a34a; color: white; }

        .security-issue .file {
          font-family: monospace;
          color: #6b7280;
        }

        .security-issue p {
          margin: 0.5rem 0 0 0;
        }

        .security-issue .recommendation {
          color: #059669;
          font-style: italic;
        }
      `}</style>
    </div>
  );
}

export default App;
