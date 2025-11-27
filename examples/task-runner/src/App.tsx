/**
 * Task Runner Example - React Client
 *
 * Demonstrates tasks with real-time broadcast updates
 */

import { useState, useRef, useCallback } from "react";
import { useAgent } from "../../../packages/agents/src/react";

type TaskResult = {
  repoUrl: string;
  branch: string;
  summary: string;
  architecture: string;
  techStack: string[];
  suggestions: string[];
  fileCount: number;
  analyzedAt: string;
};

type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface TaskData {
  id: string;
  status: TaskStatus;
  progress?: number;
  result?: TaskResult;
  error?: string;
  events?: Array<{
    id: string;
    type: string;
    data?: unknown;
    timestamp: number;
  }>;
}

function App() {
  const [tasks, setTasks] = useState<Map<string, TaskData>>(new Map());
  const [repoUrl, setRepoUrl] = useState(
    "https://github.com/cloudflare/agents"
  );
  const [branch, setBranch] = useState("main");
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);

  const agent = useAgent({
    agent: "task-runner",
    name: "default",
    onMessage: (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "CF_AGENT_TASK_UPDATE") {
          const { taskId, task } = data;
          setTasks((prev) => {
            const next = new Map(prev);
            if (task === null) {
              next.delete(taskId);
            } else {
              next.set(taskId, task);
            }
            return next;
          });
        }
      } catch {
        // Ignore non-JSON messages
      }
    }
  });

  // Poll for task updates (fallback when broadcasts are missed)
  const pollTaskStatus = useCallback(
    async (taskId: string) => {
      const maxPolls = 120;
      for (let i = 0; i < maxPolls; i++) {
        const delay = i < 10 ? 200 : 500;
        await new Promise((r) => setTimeout(r, delay));
        try {
          const task = (await agent.call("getTask", [
            taskId
          ])) as TaskData | null;
          if (task) {
            setTasks((prev) => {
              const next = new Map(prev);
              next.set(taskId, task);
              return next;
            });
            if (["completed", "failed", "aborted"].includes(task.status)) {
              return;
            }
          }
        } catch {
          // Ignore polling errors
        }
      }
    },
    [agent]
  );

  // Start quick analysis - protected against double-calls
  const startQuickAnalysis = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);

    try {
      const handle = await agent.call("quickAnalysis", [{ repoUrl, branch }]);
      const taskId = (handle as { id: string }).id;

      // Add task to local state immediately
      setTasks((prev) => {
        const next = new Map(prev);
        next.set(taskId, { id: taskId, status: "pending" });
        return next;
      });

      // Start polling as fallback for missed broadcasts (immediate first poll)
      setTimeout(() => pollTaskStatus(taskId), 100);
    } catch {
      // Failed to start
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [agent, repoUrl, branch, pollTaskStatus]);

  // Start deep analysis using Cloudflare Workflow
  const startDeepAnalysis = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);

    try {
      const handle = await agent.call("deepAnalysis", [{ repoUrl, branch }]);
      const taskId = (handle as { id: string }).id;

      setTasks((prev) => {
        const next = new Map(prev);
        next.set(taskId, { id: taskId, status: "pending" });
        return next;
      });

      // Start polling as fallback (immediate first poll)
      setTimeout(() => pollTaskStatus(taskId), 100);
    } catch {
      // Failed to start
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [agent, repoUrl, branch, pollTaskStatus]);

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

  const taskList = Array.from(tasks.values()).sort(
    (a, b) => (b.events?.[0]?.timestamp || 0) - (a.events?.[0]?.timestamp || 0)
  );

  return (
    <div className="app">
      <header>
        <h1>🔍 Repo Analyzer</h1>
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
        <div className="buttons">
          <button
            type="button"
            onClick={startQuickAnalysis}
            className="primary"
            disabled={isStarting}
          >
            {isStarting ? "Starting..." : "⚡ Quick Analysis"}
          </button>
          <button
            type="button"
            onClick={startDeepAnalysis}
            className="secondary"
            disabled={isStarting}
          >
            {isStarting ? "Starting..." : "🔬 Deep Analysis (Workflow)"}
          </button>
        </div>
      </section>

      <section className="tasks">
        <h2>Tasks ({taskList.length})</h2>
        {taskList.length === 0 ? (
          <p className="empty">No tasks yet. Start an analysis above!</p>
        ) : (
          <div className="task-list">
            {taskList.map((task) => (
              <TaskCard key={task.id} task={task} onAbort={abortTask} />
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
      `}</style>
    </div>
  );
}

function TaskCard({
  task,
  onAbort
}: {
  task: TaskData;
  onAbort: (id: string) => void;
}) {
  const getStatusColor = () => {
    switch (task.status) {
      case "pending":
        return "#888";
      case "running":
        return "#0066ff";
      case "completed":
        return "#00aa44";
      case "failed":
        return "#ff4444";
      case "aborted":
        return "#ff8800";
      default:
        return "#888";
    }
  };

  const getStatusEmoji = () => {
    switch (task.status) {
      case "pending":
        return "⏳";
      case "running":
        return "🔄";
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "aborted":
        return "🛑";
      default:
        return "❓";
    }
  };

  const isRunning = task.status === "pending" || task.status === "running";

  return (
    <div className="task-card">
      <div className="task-header">
        <span className="task-status" style={{ color: getStatusColor() }}>
          {getStatusEmoji()} {task.status.toUpperCase()}
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
          {task.events.slice(-3).map((event) => (
            <div key={event.id} className="event">
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

      {task.status === "completed" && task.result && (
        <div className="task-result">
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
            {task.result.fileCount} files analyzed at{" "}
            {new Date(task.result.analyzedAt).toLocaleString()}
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
        }

        .event-type {
          font-weight: 600;
          color: #0066ff;
        }

        .event-data {
          color: #666;
          font-family: monospace;
        }

        .task-result {
          background: #f8f9fa;
          padding: 1rem;
          border-radius: 8px;
          font-size: 0.875rem;
          margin-bottom: 0.75rem;
          border: 1px solid #e9ecef;
        }

        .result-section {
          margin-bottom: 1rem;
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
        }

        .result-section ul {
          margin: 0;
          padding-left: 1.25rem;
          color: #495057;
        }

        .result-section li {
          margin-bottom: 0.25rem;
        }

        .tags {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
        }

        .tag {
          background: #0066ff15;
          color: #0066ff;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 500;
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
      `}</style>
    </div>
  );
}

export default App;
