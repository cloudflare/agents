import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type {
  BasicWorkflowAgent,
  BasicWorkflowState,
  WorkflowWithProgress
} from "./basic-workflow-agent";
import {
  Check,
  Loader2,
  Circle,
  Play,
  Trash2,
  X,
  RefreshCw
} from "lucide-react";

function ProgressBar({ current, total }: { current: number; total: number }) {
  const percentage = total > 0 ? (current / total) * 100 : 0;

  return (
    <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2">
      <div
        className="bg-black dark:bg-white h-2 rounded-full transition-all duration-500"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowWithProgress }) {
  const name = workflow.name || workflow.workflowName;

  const statusColors: Record<string, string> = {
    queued:
      "bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200",
    running: "bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200",
    complete:
      "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200",
    errored: "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200",
    waiting:
      "bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200"
  };

  const statusIcons: Record<string, React.ReactNode> = {
    queued: <Circle className="w-4 h-4" />,
    running: <Loader2 className="w-4 h-4 animate-spin" />,
    complete: <Check className="w-4 h-4" />,
    errored: <X className="w-4 h-4" />,
    waiting: <Loader2 className="w-4 h-4 animate-spin" />
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="font-medium">{name}</h4>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ID: {workflow.workflowId.slice(0, 8)}...
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium flex items-center gap-1 ${statusColors[workflow.status] || statusColors.queued}`}
        >
          {statusIcons[workflow.status] || statusIcons.queued}
          {workflow.status}
        </span>
      </div>

      {/* Progress Bar */}
      {workflow.progress && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            <span>{workflow.progress.message}</span>
            <span>
              {workflow.progress.step} / {workflow.progress.total}
            </span>
          </div>
          <ProgressBar
            current={workflow.progress.step}
            total={workflow.progress.total}
          />
        </div>
      )}

      {/* Error */}
      {workflow.error && (
        <div className="mb-3 p-2 bg-red-50 dark:bg-red-900/20 rounded text-sm">
          <div className="text-red-700 dark:text-red-300">
            {workflow.error.message}
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="pt-3 border-t border-neutral-100 dark:border-neutral-700 text-xs text-neutral-500 dark:text-neutral-400">
        <div>Started: {new Date(workflow.createdAt).toLocaleTimeString()}</div>
        {workflow.completedAt && (
          <div>
            Completed: {new Date(workflow.completedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowBasicDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [workflowName, setWorkflowName] = useState("Data Processing");
  const [stepCount, setStepCount] = useState(4);
  const [isStarting, setIsStarting] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowWithProgress[]>([]);

  const agent = useAgent<BasicWorkflowAgent, BasicWorkflowState>({
    agent: "basic-workflow-agent",
    name: "demo",
    onStateUpdate: (newState) => {
      if (newState) {
        addLog("in", "state_update", {
          progress: Object.keys(newState.progress).length
        });
        // Refresh workflows when progress updates
        refreshWorkflows();
      }
    },
    onOpen: () => {
      addLog("info", "connected");
      refreshWorkflows();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (message) => {
      try {
        const data = JSON.parse(message.data as string);
        if (data.type) {
          addLog("in", data.type, data);
          // Refresh on workflow events
          if (data.type.startsWith("workflow_")) {
            refreshWorkflows();
          }
        }
      } catch {
        // ignore
      }
    }
  });

  const refreshWorkflows = async () => {
    try {
      // Type assertion needed - SDK type inference has issues with array return types
      const list = await (
        agent.call as (m: string) => Promise<WorkflowWithProgress[]>
      )("listWorkflows");
      setWorkflows(list);
    } catch {
      // ignore - might not be connected yet
    }
  };

  const handleStartWorkflow = async () => {
    if (!workflowName.trim()) return;

    setIsStarting(true);
    addLog("out", "startWorkflow", { name: workflowName, stepCount });

    try {
      await agent.call("startWorkflow", [workflowName, stepCount]);
      await refreshWorkflows();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    } finally {
      setIsStarting(false);
    }
  };

  const handleClearWorkflows = async () => {
    addLog("out", "clearWorkflows");
    try {
      const result = await agent.call("clearWorkflows");
      addLog("in", "cleared", { count: result });
      await refreshWorkflows();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const activeWorkflows = workflows.filter(
    (w) =>
      w.status === "queued" || w.status === "running" || w.status === "waiting"
  );
  const completedWorkflows = workflows.filter(
    (w) =>
      w.status === "complete" ||
      w.status === "errored" ||
      w.status === "terminated"
  );

  return (
    <DemoWrapper
      title="Multi-Step Workflows"
      description="Start real Cloudflare Workflows with multiple durable steps. Progress is reported back to the agent in real-time."
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Controls */}
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
            <h3 className="font-semibold mb-4">Start Workflow</h3>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="workflow-name"
                  className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1"
                >
                  Workflow Name
                </label>
                <input
                  id="workflow-name"
                  type="text"
                  value={workflowName}
                  onChange={(e) => setWorkflowName(e.target.value)}
                  className="input w-full"
                  placeholder="Enter workflow name"
                />
              </div>
              <div>
                <label
                  htmlFor="step-count"
                  className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1"
                >
                  Number of Steps: {stepCount}
                </label>
                <input
                  id="step-count"
                  type="range"
                  min={2}
                  max={6}
                  value={stepCount}
                  onChange={(e) => setStepCount(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-neutral-400 mt-1">
                  <span>2</span>
                  <span>6</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleStartWorkflow}
                disabled={isStarting || !workflowName.trim()}
                className="btn btn-primary w-full flex items-center justify-center gap-2"
              >
                <Play className="w-4 h-4" />
                {isStarting ? "Starting..." : "Start Workflow"}
              </button>
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
                starts a durable workflow
              </li>
              <li>
                2. Workflow executes steps with{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  step.do()
                </code>
              </li>
              <li>
                3.{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  getWorkflows()
                </code>{" "}
                tracks all workflows
              </li>
              <li>
                4. Progress via{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  onWorkflowProgress()
                </code>
              </li>
            </ul>
          </div>
        </div>

        {/* Center Panel - Workflows */}
        <div className="space-y-6">
          {/* Active Workflows */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                Active ({activeWorkflows.length})
              </h3>
              <button
                type="button"
                onClick={refreshWorkflows}
                className="text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Refresh
              </button>
            </div>
            {activeWorkflows.length > 0 ? (
              <div className="space-y-3">
                {activeWorkflows.map((workflow) => (
                  <WorkflowCard key={workflow.workflowId} workflow={workflow} />
                ))}
              </div>
            ) : (
              <div className="card p-6 text-center text-neutral-400 text-sm">
                No active workflows
              </div>
            )}
          </div>

          {/* Completed Workflows */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                History ({completedWorkflows.length})
              </h3>
              {completedWorkflows.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearWorkflows}
                  className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>
            {completedWorkflows.length > 0 ? (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {completedWorkflows.map((workflow) => (
                  <WorkflowCard key={workflow.workflowId} workflow={workflow} />
                ))}
              </div>
            ) : (
              <div className="card p-6 text-center text-neutral-400 text-sm">
                No completed workflows
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
