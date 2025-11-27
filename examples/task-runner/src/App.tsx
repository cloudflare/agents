/**
 * Task Runner Example - React Client
 *
 * Demonstrates the useTask hook for real-time task tracking
 */

import { useState } from "react";
// Note: Import from source for local development
// In production, use: import { useAgent, useTask } from "agents/react";
import { useAgent, useTask } from "../../../packages/agents/src/react";

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

function App() {
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [repoUrl, setRepoUrl] = useState(
    "https://github.com/cloudflare/agents"
  );
  const [branch, setBranch] = useState("main");

  const agent = useAgent({
    agent: "task-runner",
    name: "default"
  });

  const startAnalysis = async () => {
    try {
      // @task() decorated methods return TaskHandle directly
      const handle = await agent.call<{ id: string; status: string }>(
        "analyzeRepo",
        [{ repoUrl, branch }]
      );
      setTaskIds((prev) => [handle.id, ...prev]);
    } catch (err) {
      console.error("Failed to start analysis:", err);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>🔍 Repo Analyzer</h1>
        <p>Demonstrates the Agents SDK task system with real-time updates</p>
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
          <button onClick={startAnalysis} className="primary">
            Start Analysis
          </button>
        </div>
      </section>

      <section className="tasks">
        <h2>Tasks ({taskIds.length})</h2>
        {taskIds.length === 0 ? (
          <p className="empty">No tasks yet. Create one above!</p>
        ) : (
          <div className="task-list">
            {taskIds.map((taskId) => (
              <TaskCard key={taskId} taskId={taskId} agent={agent} />
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

        button {
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          cursor: pointer;
          transition: background-color 0.2s;
        }

        button.primary {
          background: #0066ff;
          color: white;
        }

        button.primary:hover {
          background: #0052cc;
        }

        button.danger {
          background: #ff4444;
          color: white;
        }

        button.danger:hover {
          background: #cc3333;
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

// Task Card Component
function TaskCard({
  taskId,
  agent
}: {
  taskId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any;
}) {
  const task = useTask<TaskResult>(agent, taskId);

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

  return (
    <div className="task-card">
      <div className="task-header">
        <span className="task-status" style={{ color: getStatusColor() }}>
          {getStatusEmoji()} {task.status.toUpperCase()}
        </span>
        <span className="task-id">{taskId.slice(0, 12)}...</span>
      </div>

      {task.isRunning && (
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${task.progress || 0}%` }}
          />
          <span className="progress-text">
            {Math.round(task.progress || 0)}%
          </span>
        </div>
      )}

      <div className="task-events">
        {task.events.slice(-3).map((event) => (
          <div key={event.id} className="event">
            <span className="event-type">{event.type}</span>
            <span className="event-data">{JSON.stringify(event.data)}</span>
          </div>
        ))}
      </div>

      {task.isSuccess && task.result && (
        <div className="task-result">
          <div className="result-section">
            <strong>Summary</strong>
            <p>{task.result.summary}</p>
          </div>
          <div className="result-section">
            <strong>Architecture</strong>
            <p>{task.result.architecture}</p>
          </div>
          {task.result.techStack.length > 0 && (
            <div className="result-section">
              <strong>Tech Stack</strong>
              <div className="tags">
                {task.result.techStack.map((tech, i) => (
                  <span key={i} className="tag">
                    {tech}
                  </span>
                ))}
              </div>
            </div>
          )}
          {task.result.suggestions.length > 0 && (
            <div className="result-section">
              <strong>Suggestions</strong>
              <ul>
                {task.result.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
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

      {task.isError && task.error && (
        <div className="task-error">
          <strong>Error:</strong> {task.error}
        </div>
      )}

      {task.isRunning && (
        <div className="task-actions">
          <button className="danger" onClick={() => task.abort()}>
            Abort Task
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

        .task-actions button {
          font-size: 0.75rem;
          padding: 0.25rem 0.5rem;
          background: #f0f0f0;
        }

        .task-actions button:hover {
          background: #e0e0e0;
        }
      `}</style>
    </div>
  );
}

export default App;
