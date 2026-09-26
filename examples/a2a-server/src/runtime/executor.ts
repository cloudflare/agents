import type { A2AWorkflowParams } from "./types";

interface TrackedWorkflow {
  error?: { name: string; message: string } | null;
  status: string;
}

interface AgentWorkflowHost {
  adoptWorkflow?(instanceId: string): Promise<boolean>;
  getWorkflow(instanceId: string): TrackedWorkflow | undefined;
  getWorkflowStatus(instanceId: string): Promise<WorkflowStatusSnapshot>;
  runWorkflow(instanceId: string, params: A2AWorkflowParams): Promise<void>;
  terminateWorkflow(instanceId: string): Promise<void>;
}

/** Abstracts durable Agent Workflow creation and termination for request handling. */
export interface WorkflowRunner {
  start(instanceId: string, params: A2AWorkflowParams): Promise<void>;
  terminate(
    instanceId: string,
    params?: A2AWorkflowParams,
    allowMissing?: boolean
  ): Promise<void>;
}

export interface WorkflowStatusSnapshot {
  status: InstanceStatus["status"] | "missing";
  error?: {
    name: string;
    message: string;
  };
}

/** Uses Agent workflow tracking while preserving retry-safe stable instance IDs. */
export class WorkflowAgentExecutor implements WorkflowRunner {
  constructor(private readonly host: AgentWorkflowHost) {}

  async start(instanceId: string, params: A2AWorkflowParams): Promise<void> {
    if (this.host.getWorkflow(instanceId)) return;
    try {
      await this.host.runWorkflow(instanceId, params);
    } catch (error) {
      // A concurrent request or recovery pass may have won the stable-ID launch.
      if (this.host.getWorkflow(instanceId)) return;
      // The Workflow may have been created immediately before the Agent's
      // tracking insert was interrupted. Adopt only a confirmed instance.
      if (await this.host.adoptWorkflow?.(instanceId)) return;
      throw error;
    }
  }

  async terminate(
    instanceId: string,
    params?: A2AWorkflowParams,
    allowMissing = false
  ): Promise<void> {
    if (params) await this.start(instanceId, params);
    if (!this.host.getWorkflow(instanceId)) {
      if (allowMissing) return;
      throw new Error(`Workflow ${instanceId} not found in tracking table`);
    }

    const current = await this.inspect(instanceId);
    if (current.status === "missing") {
      if (allowMissing) return;
      throw new Error("instance.not_found");
    }
    if (isTerminalWorkflowStatus(current.status)) return;

    try {
      await this.host.terminateWorkflow(instanceId);
    } catch (error) {
      const reconciled = await this.inspect(instanceId);
      if (
        reconciled.status !== "missing" &&
        !isTerminalWorkflowStatus(reconciled.status)
      ) {
        throw error;
      }
      if (reconciled.status === "missing" && !allowMissing) throw error;
    }
  }

  /** Reads one tracked Workflow status, distinguishing an absent instance. */
  async inspect(instanceId: string): Promise<WorkflowStatusSnapshot> {
    if (!this.host.getWorkflow(instanceId)) return { status: "missing" };
    try {
      return await this.host.getWorkflowStatus(instanceId);
    } catch (error) {
      if (isMissingWorkflowInstance(error)) return { status: "missing" };
      throw error;
    }
  }
}

function isTerminalWorkflowStatus(
  status: WorkflowStatusSnapshot["status"]
): boolean {
  return (
    status === "terminated" || status === "complete" || status === "errored"
  );
}

function isMissingWorkflowInstance(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "instance.not_found" || code === 10400) return true;
  return (
    error instanceof Error && error.message.trim() === "instance.not_found"
  );
}

/** Trims and validates the text input passed into a Workflow. */
export function extractPrompt(
  text: string,
  maxTextCharacters?: number
): string {
  const prompt = text.trim();
  if (!prompt) throw new Error("A non-empty text part is required.");
  if (maxTextCharacters !== undefined && prompt.length > maxTextCharacters) {
    throw new Error(
      `Text input must be at most ${maxTextCharacters.toLocaleString("en-US")} characters.`
    );
  }
  return prompt;
}
