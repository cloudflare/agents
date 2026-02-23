import { useAgent } from "agents/react";
import { useState } from "react";
import {
  CheckIcon,
  CircleIcon,
  XIcon,
  PlayIcon,
  TrashIcon,
  ArrowsClockwiseIcon
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import {
  Button,
  Input,
  Surface,
  Badge,
  Empty,
  Text,
  Meter
} from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type {
  BasicWorkflowAgent,
  BasicWorkflowState,
  WorkflowWithProgress
} from "./basic-workflow-agent";

const codeSections: CodeSection[] = [
  {
    title: "Define a workflow with AgentWorkflow",
    description:
      "Extend AgentWorkflow instead of WorkflowEntrypoint to get typed access to the originating agent. You get this.agent for RPC, this.reportProgress() for live updates, and this.broadcastToClients() to push messages over WebSocket.",
    code: `import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    const result = await step.do("process-data", async () => {
      return processData(params.data);
    });

    // Report progress back to the agent (non-durable, lightweight)
    await this.reportProgress({
      step: "process",
      status: "complete",
      percent: 0.5,
    });

    // Call agent methods via typed RPC
    await this.agent.saveResult(params.taskId, result);

    // Broadcast to all connected WebSocket clients
    this.broadcastToClients({ type: "task-complete", taskId: params.taskId });

    // Mark completion (durable via step)
    await step.reportComplete(result);
    return result;
  }
}`
  },
  {
    title: "Start and track workflows from the agent",
    description:
      "Use this.runWorkflow() to start a workflow with automatic tracking in the agent's database. Override onWorkflowProgress and onWorkflowComplete to react to workflow events and broadcast them to connected clients.",
    code: `class MyAgent extends Agent {
  @callable()
  async startTask(taskId: string, data: string) {
    const instanceId = await this.runWorkflow("PROCESSING_WORKFLOW", {
      taskId,
      data,
    });
    return { instanceId };
  }

  async onWorkflowProgress(workflowName: string, instanceId: string, progress: unknown) {
    this.broadcast(JSON.stringify({
      type: "workflow-progress",
      instanceId,
      progress,
    }));
  }

  async onWorkflowComplete(workflowName: string, instanceId: string, result?: unknown) {
    console.log("Workflow completed:", instanceId);
  }
}`
  },
  {
    title: "Durable step helpers",
    description:
      "Steps have built-in helpers for common patterns: step.reportComplete() and step.reportError() for status, step.updateAgentState() and step.mergeAgentState() to durably update the agent's state (which broadcasts to all clients), and step.sendEvent() for custom events.",
    code: `  async run(event: AgentWorkflowEvent<Params>, step: AgentWorkflowStep) {
    // Durably update agent state (broadcasts to WebSocket clients)
    await step.updateAgentState({ status: "processing", startedAt: Date.now() });

    const result = await step.do("process", async () => {
      return processTask(event.payload);
    });

    // Merge partial state (keeps existing fields)
    await step.mergeAgentState({ status: "complete", result });

    // Report completion
    await step.reportComplete(result);
  }`
  }
];

function WorkflowCard({ workflow }: { workflow: WorkflowWithProgress }) {
  const name = workflow.name || workflow.workflowName;

  const statusVariant: Record<
    string,
    "beta" | "primary" | "destructive" | "outline" | "secondary"
  > = {
    queued: "beta",
    running: "primary",
    complete: "primary",
    errored: "destructive",
    waiting: "beta"
  };

  const statusIcons: Record<string, React.ReactNode> = {
    queued: <CircleIcon size={14} />,
    running: <Loader size="sm" />,
    complete: <CheckIcon size={14} />,
    errored: <XIcon size={14} />,
    waiting: <Loader size="sm" />
  };

  return (
    <Surface className="p-4 rounded-lg ring ring-kumo-line">
      <div className="flex items-center justify-between mb-3">
        <div>
          <Text bold>{name}</Text>
          <p className="text-xs text-kumo-subtle">
            ID: {workflow.workflowId.slice(0, 8)}...
          </p>
        </div>
        <Badge variant={statusVariant[workflow.status] || "outline"}>
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
          <Meter
            label="Progress"
            value={workflow.progress.step}
            max={workflow.progress.total}
            showValue={false}
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
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [workflowName, setWorkflowName] = useState("Data Processing");
  const [stepCount, setStepCount] = useState(4);
  const [isStarting, setIsStarting] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowWithProgress[]>([]);

  const agent = useAgent<BasicWorkflowAgent, BasicWorkflowState>({
    agent: "basic-workflow-agent",
    name: `workflow-basic-${userId}`,
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
      description={
        <>
          Extend{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            AgentWorkflow
          </code>{" "}
          to build durable multi-step workflows that integrate tightly with your
          agent. Each step runs exactly once — if the Worker crashes
          mid-execution, the workflow resumes from the last completed step. Use{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.runWorkflow()
          </code>{" "}
          to start a workflow with automatic tracking, and{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.reportProgress()
          </code>{" "}
          to stream live updates back to connected clients.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Controls */}
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Start Workflow</Text>
            </div>
            <div className="space-y-4">
              <Input
                label="Workflow Name"
                type="text"
                value={workflowName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setWorkflowName(e.target.value)
                }
                className="w-full"
                placeholder="Enter workflow name"
              />
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
                icon={<PlayIcon size={16} />}
              >
                {isStarting ? "Starting..." : "Start Workflow"}
              </Button>
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
              <Text variant="heading3">Active ({activeWorkflows.length})</Text>
              <Button
                variant="ghost"
                size="xs"
                onClick={refreshWorkflows}
                icon={<ArrowsClockwiseIcon size={12} />}
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
              <Text variant="heading3">
                History ({completedWorkflows.length})
              </Text>
              {completedWorkflows.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleClearWorkflows}
                  icon={<TrashIcon size={12} />}
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

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
