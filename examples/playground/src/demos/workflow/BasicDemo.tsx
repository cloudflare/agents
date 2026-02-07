import { useAgent } from "agents/react";
import { useState } from "react";
import {
  Check,
  Circle,
  X,
  Play,
  Trash,
  ArrowsClockwise
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { Button, Input, Surface, Badge, Empty } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type {
  BasicWorkflowAgent,
  BasicWorkflowState,
  WorkflowWithProgress
} from "./basic-workflow-agent";

function ProgressBar({ current, total }: { current: number; total: number }) {
  const percentage = total > 0 ? (current / total) * 100 : 0;

  return (
    <div className="w-full bg-kumo-fill rounded-full h-2">
      <div
        className="bg-kumo-contrast h-2 rounded-full transition-all duration-500"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowWithProgress }) {
  const name = workflow.name || workflow.workflowName;

  const statusVariant: Record<
    string,
    "beta" | "primary" | "positive" | "destructive" | "neutral"
  > = {
    queued: "beta",
    running: "primary",
    complete: "positive",
    errored: "destructive",
    waiting: "beta"
  };

  const statusIcons: Record<string, React.ReactNode> = {
    queued: <Circle size={14} />,
    running: <Loader size="xs" />,
    complete: <Check size={14} />,
    errored: <X size={14} />,
    waiting: <Loader size="xs" />
  };

  return (
    <Surface className="p-4 rounded-lg ring ring-kumo-line">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="font-medium text-kumo-default">{name}</h4>
          <p className="text-xs text-kumo-subtle">
            ID: {workflow.workflowId.slice(0, 8)}...
          </p>
        </div>
        <Badge variant={statusVariant[workflow.status] || "neutral"}>
          <span className="flex items-center gap-1">
            {statusIcons[workflow.status] || statusIcons.queued}
            {workflow.status}
          </span>
        </Badge>
      </div>

      {/* Progress Bar */}
      {workflow.progress && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-kumo-subtle mb-1">
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
        <div className="mb-3 p-2 bg-kumo-danger-tint rounded text-sm">
          <div className="text-kumo-danger">{workflow.error.message}</div>
        </div>
      )}

      {/* Timestamps */}
      <div className="pt-3 border-t border-kumo-fill text-xs text-kumo-subtle">
        <div>Started: {new Date(workflow.createdAt).toLocaleTimeString()}</div>
        {workflow.completedAt && (
          <div>
            Completed: {new Date(workflow.completedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
    </Surface>
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
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-kumo-default">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <h3 className="font-semibold text-kumo-default mb-4">
              Start Workflow
            </h3>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="workflow-name"
                  className="text-xs text-kumo-subtle block mb-1"
                >
                  Workflow Name
                </label>
                <Input
                  id="workflow-name"
                  type="text"
                  value={workflowName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setWorkflowName(e.target.value)
                  }
                  className="w-full"
                  placeholder="Enter workflow name"
                />
              </div>
              <div>
                <label
                  htmlFor="step-count"
                  className="text-xs text-kumo-subtle block mb-1"
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
                <div className="flex justify-between text-xs text-kumo-inactive mt-1">
                  <span>2</span>
                  <span>6</span>
                </div>
              </div>
              <Button
                variant="primary"
                onClick={handleStartWorkflow}
                disabled={isStarting || !workflowName.trim()}
                className="w-full"
                icon={<Play size={16} />}
              >
                {isStarting ? "Starting..." : "Start Workflow"}
              </Button>
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <h3 className="font-semibold text-kumo-default mb-2">
              How it Works
            </h3>
            <ul className="text-sm text-kumo-subtle space-y-1">
              <li>
                1.{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  runWorkflow()
                </code>{" "}
                starts a durable workflow
              </li>
              <li>
                2. Workflow executes steps with{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  step.do()
                </code>
              </li>
              <li>
                3.{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  getWorkflows()
                </code>{" "}
                tracks all workflows
              </li>
              <li>
                4. Progress via{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  onWorkflowProgress()
                </code>
              </li>
            </ul>
          </Surface>
        </div>

        {/* Center Panel - Workflows */}
        <div className="space-y-6">
          {/* Active Workflows */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-kumo-default">
                Active ({activeWorkflows.length})
              </h3>
              <Button
                variant="ghost"
                size="xs"
                onClick={refreshWorkflows}
                icon={<ArrowsClockwise size={12} />}
              >
                Refresh
              </Button>
            </div>
            {activeWorkflows.length > 0 ? (
              <div className="space-y-3">
                {activeWorkflows.map((workflow) => (
                  <WorkflowCard key={workflow.workflowId} workflow={workflow} />
                ))}
              </div>
            ) : (
              <Surface className="p-6 rounded-lg ring ring-kumo-line">
                <Empty title="No active workflows" size="sm" />
              </Surface>
            )}
          </div>

          {/* Completed Workflows */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-kumo-default">
                History ({completedWorkflows.length})
              </h3>
              {completedWorkflows.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleClearWorkflows}
                  icon={<Trash size={12} />}
                  className="text-kumo-danger"
                >
                  Clear
                </Button>
              )}
            </div>
            {completedWorkflows.length > 0 ? (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {completedWorkflows.map((workflow) => (
                  <WorkflowCard key={workflow.workflowId} workflow={workflow} />
                ))}
              </div>
            ) : (
              <Surface className="p-6 rounded-lg ring ring-kumo-line">
                <Empty title="No completed workflows" size="sm" />
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
