/**
 * Workflow Example
 *
 * Demonstrates Cloudflare Workflows integration with Agents.
 * Shows how to dispatch long-running durable workflows from an Agent.
 */

import {
  Agent,
  routeAgentRequest,
  callable
} from "../../../packages/agents/src/index";
import OpenAI from "openai";

// Re-export the workflow for wrangler
export { AnalysisWorkflow } from "./workflows/analysis";

// Workflow type from cloudflare:workers
interface WorkflowInstance {
  id: string;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  terminate: () => Promise<void>;
  restart: () => Promise<void>;
  status: () => Promise<{
    status:
      | "queued"
      | "running"
      | "paused"
      | "complete"
      | "errored"
      | "terminated"
      | "waiting";
    error?: string;
    output?: unknown;
  }>;
  // Send events to workflows waiting with step.waitForEvent()
  sendEvent: (event: { type: string; payload: unknown }) => Promise<void>;
}

interface Workflow {
  create: (opts?: {
    id?: string;
    params?: unknown;
  }) => Promise<WorkflowInstance>;
  get: (id: string) => Promise<WorkflowInstance>;
}

type Env = {
  "task-runner": DurableObjectNamespace<TaskRunner>;
  ANALYSIS_WORKFLOW: Workflow;
  OPENAI_API_KEY: string;
};

interface RepoFile {
  path: string;
  type: "file" | "dir";
  size?: number;
}

interface SecurityIssue {
  severity: "low" | "medium" | "high" | "critical";
  file: string;
  description: string;
  recommendation: string;
}

interface AnalysisResult {
  repoUrl: string;
  branch: string;
  summary: string;
  architecture: string;
  techStack: string[];
  suggestions: string[];
  // Deep analysis includes these additional fields
  securityIssues?: SecurityIssue[];
  codePatterns?: string[];
  dependencies?: { name: string; version: string; type: string }[];
  fileCount: number;
  analyzedFiles?: number;
  analyzedAt: string;
  // Workflow-specific fields (only present in deep analysis)
  approvalStatus?: "pending" | "approved" | "rejected" | "auto-approved";
  approvedBy?: string;
  approvedAt?: string;
  followUpScheduled?: boolean;
  workflowDuration?: string;
}

// Simple in-memory task tracking for this example
// In production, you might use SQL storage or external state
interface TaskState {
  id: string;
  type: "quick" | "deep";
  status: "pending" | "running" | "awaiting-approval" | "completed" | "failed";
  progress?: number;
  result?: AnalysisResult;
  error?: string;
  workflowInstanceId?: string;
  events: Array<{ type: string; data?: unknown; timestamp: number }>;
}

/**
 * Task Runner Agent
 *
 * Demonstrates workflow integration for long-running analysis tasks.
 */
export class TaskRunner extends Agent<
  Env,
  { tasks: Record<string, TaskState> }
> {
  private openai: OpenAI | null = null;

  initialState = { tasks: {} as Record<string, TaskState> };

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: this.env.OPENAI_API_KEY
      });
    }
    return this.openai;
  }

  // =========================================================================
  // Workflow-based Analysis (Durable, Long-running)
  // =========================================================================

  /**
   * Start a deep analysis using Cloudflare Workflow.
   *
   * Unlike quickAnalysis, this demonstrates workflow-specific capabilities:
   * - Runs in the Workflow engine (separate from DO)
   * - Can run for hours/days with step.sleep()
   * - Survives restarts, automatic retries with exponential backoff
   * - Each step is checkpointed (no duplicate work on restart)
   * - Can pause for human approval with step.waitForEvent()
   * - Can schedule follow-up tasks days in the future
   */
  @callable()
  async startAnalysis(input: {
    repoUrl: string;
    branch?: string;
    /** If true, workflow pauses for human approval on critical security issues */
    requireApproval?: boolean;
    /** If true, schedules a follow-up reminder (demonstrates step.sleep for days) */
    scheduleFollowUp?: boolean;
  }) {
    const taskId = `task_${crypto.randomUUID().slice(0, 12)}`;

    // Create workflow instance with workflow-specific options
    const instance = await this.env.ANALYSIS_WORKFLOW.create({
      id: taskId,
      params: {
        repoUrl: input.repoUrl,
        branch: input.branch || "main",
        requireApproval: input.requireApproval ?? true,
        scheduleFollowUp: input.scheduleFollowUp ?? false,
        // Pass agent info for callbacks
        _agentBinding: "task-runner",
        _agentName: this.name || "default"
      }
    });

    // Track the task in state
    const task: TaskState = {
      id: taskId,
      type: "deep",
      status: "pending",
      workflowInstanceId: instance.id,
      events: [{ type: "workflow-started", timestamp: Date.now() }]
    };

    this.setState({
      ...this.state,
      tasks: { ...this.state.tasks, [taskId]: task }
    });

    return {
      id: taskId,
      workflowInstanceId: instance.id,
      message:
        "Deep analysis started. " +
        (input.requireApproval
          ? "Will pause for approval if critical issues found."
          : "Auto-approving all findings.")
    };
  }

  /**
   * Quick analysis that runs directly in the Agent (non-durable).
   * Good for operations under ~30s.
   */
  @callable()
  async quickAnalysis(input: {
    repoUrl: string;
    branch?: string;
  }): Promise<{ id: string }> {
    const taskId = `task_${crypto.randomUUID().slice(0, 12)}`;
    const { repoUrl, branch = "main" } = input;

    // Track the task
    const task: TaskState = {
      id: taskId,
      type: "quick",
      status: "running",
      progress: 0,
      events: [{ type: "started", timestamp: Date.now() }]
    };
    this.setState({
      ...this.state,
      tasks: { ...this.state.tasks, [taskId]: task }
    });

    // Run analysis in background using ctx.waitUntil to prevent early termination
    // This ensures the task completes even if no WebSocket connections are active
    const analysisPromise = this.runQuickAnalysis(
      taskId,
      repoUrl,
      branch
    ).catch((error) => {
      console.error("[TaskRunner] Quick analysis failed:", error);
      this.updateTask(taskId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    });
    this.ctx.waitUntil(analysisPromise);

    return { id: taskId };
  }

  private async runQuickAnalysis(
    taskId: string,
    repoUrl: string,
    branch: string
  ) {
    try {
      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        throw new Error("Invalid GitHub URL");
      }
      const [, owner, repo] = match;
      const repoName = repo.replace(/\.git$/, "");

      this.updateTask(taskId, {
        progress: 10,
        events: [
          { type: "phase", data: { name: "fetching" }, timestamp: Date.now() }
        ]
      });

      const files = await this.fetchRepoTree(owner, repoName, branch);
      this.updateTask(taskId, { progress: 30 });

      this.updateTask(taskId, {
        events: [
          { type: "phase", data: { name: "reading" }, timestamp: Date.now() }
        ]
      });
      const keyFiles = await this.fetchKeyFiles(owner, repoName, branch, files);
      this.updateTask(taskId, { progress: 50 });

      this.updateTask(taskId, {
        events: [
          { type: "phase", data: { name: "analyzing" }, timestamp: Date.now() }
        ]
      });
      const analysis = await this.analyzeWithAI(repoUrl, files, keyFiles);
      this.updateTask(taskId, { progress: 90 });

      const result: AnalysisResult = {
        repoUrl,
        branch,
        ...analysis,
        fileCount: files.length,
        analyzedAt: new Date().toISOString()
      };

      this.updateTask(taskId, {
        status: "completed",
        progress: 100,
        result,
        events: [
          { type: "phase", data: { name: "complete" }, timestamp: Date.now() }
        ]
      });
    } catch (error) {
      this.updateTask(taskId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private updateTask(taskId: string, updates: Partial<TaskState>) {
    const existing = this.state.tasks[taskId];
    if (!existing) return;

    const newEvents = updates.events
      ? [...existing.events, ...updates.events]
      : existing.events;

    this.setState({
      ...this.state,
      tasks: {
        ...this.state.tasks,
        [taskId]: { ...existing, ...updates, events: newEvents }
      }
    });
  }

  // =========================================================================
  // Task Management
  // =========================================================================

  @callable()
  getTask(taskId: string): TaskState | null {
    return this.state.tasks[taskId] || null;
  }

  @callable()
  async abortTask(taskId: string): Promise<boolean> {
    const task = this.state.tasks[taskId];
    if (!task) return false;

    // If it's a workflow task, terminate the workflow
    if (task.workflowInstanceId) {
      try {
        const instance = await this.env.ANALYSIS_WORKFLOW.get(
          task.workflowInstanceId
        );
        await instance.terminate();
      } catch {
        // Workflow may already be complete
      }
    }

    this.updateTask(taskId, { status: "failed", error: "Aborted by user" });
    return true;
  }

  @callable()
  listTasks(): TaskState[] {
    return Object.values(this.state.tasks).sort(
      (a, b) => (b.events[0]?.timestamp || 0) - (a.events[0]?.timestamp || 0)
    );
  }

  /**
   * Approve or reject a task waiting for human approval.
   *
   * This demonstrates step.waitForEvent() - the workflow is paused/hibernating
   * with zero compute cost until this event is sent. Can wait up to 7 days!
   */
  @callable()
  async approveTask(input: {
    taskId: string;
    approved: boolean;
    approver: string;
    comment?: string;
  }): Promise<{ success: boolean; message: string }> {
    const task = this.state.tasks[input.taskId];
    if (!task) {
      return { success: false, message: "Task not found" };
    }

    if (!task.workflowInstanceId) {
      return {
        success: false,
        message:
          "This is not a workflow task (quick analysis doesn't need approval)"
      };
    }

    if (task.status !== "awaiting-approval") {
      return {
        success: false,
        message: `Task is not awaiting approval (current status: ${task.status})`
      };
    }

    try {
      const instance = await this.env.ANALYSIS_WORKFLOW.get(
        task.workflowInstanceId
      );

      // Send the approval event to the waiting workflow
      // This wakes up the hibernating workflow!
      await instance.sendEvent({
        type: "security-approval",
        payload: {
          approved: input.approved,
          approver: input.approver,
          comment: input.comment
        }
      });

      this.updateTask(input.taskId, {
        status: "running",
        events: [
          {
            type: input.approved ? "approved" : "rejected",
            data: { approver: input.approver, comment: input.comment },
            timestamp: Date.now()
          }
        ]
      });

      return {
        success: true,
        message: input.approved
          ? `Task approved by ${input.approver}. Workflow resuming...`
          : `Task rejected by ${input.approver}. Workflow will complete with rejection flag.`
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to send approval: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Get the workflow status directly from the Workflow engine.
   * Useful for debugging or checking if workflow is waiting for an event.
   */
  @callable()
  async getWorkflowStatus(
    taskId: string
  ): Promise<{ status: string; error?: string } | null> {
    const task = this.state.tasks[taskId];
    if (!task?.workflowInstanceId) return null;

    try {
      const instance = await this.env.ANALYSIS_WORKFLOW.get(
        task.workflowInstanceId
      );
      const status = await instance.status();
      return { status: status.status, error: status.error };
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Workflow Update Handler (called by workflow via RPC)
  // =========================================================================

  /**
   * Handle updates from the workflow.
   * The workflow calls this method to report progress.
   */
  @callable()
  handleWorkflowUpdate(update: {
    taskId: string;
    event?: { type: string; data?: unknown };
    progress?: number;
    status?: "completed" | "failed";
    result?: AnalysisResult;
    error?: string;
  }): boolean {
    const task = this.state.tasks[update.taskId];
    if (!task) {
      return false;
    }

    const updates: Partial<TaskState> = {};

    if (update.progress !== undefined) {
      updates.progress = update.progress;
    }

    if (update.status === "completed") {
      updates.status = "completed";
      updates.result = update.result;
    } else if (update.status === "failed") {
      updates.status = "failed";
      updates.error = update.error;
    } else if (task.status === "pending") {
      updates.status = "running";
    }

    // Check if workflow is now waiting for approval
    if (
      update.event?.type === "phase" &&
      (update.event.data as { name?: string })?.name === "awaiting-approval"
    ) {
      updates.status = "awaiting-approval";
    }

    if (update.event) {
      updates.events = [{ ...update.event, timestamp: Date.now() }];
    }

    this.updateTask(update.taskId, updates);
    return true;
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  private async fetchRepoTree(
    owner: string,
    repo: string,
    branch: string
  ): Promise<RepoFile[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Agents-Task-Runner"
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      tree: Array<{ path: string; type: string; size?: number }>;
    };

    return data.tree.map((item) => ({
      path: item.path,
      type: item.type === "blob" ? "file" : "dir",
      size: item.size
    }));
  }

  private async fetchKeyFiles(
    owner: string,
    repo: string,
    branch: string,
    files: RepoFile[]
  ): Promise<Record<string, string>> {
    const keyFileNames = [
      "README.md",
      "package.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml"
    ];

    const results: Record<string, string> = {};

    for (const fileName of keyFileNames) {
      const file = files.find((f) => f.path === fileName);
      if (file && file.type === "file") {
        try {
          const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
          const response = await fetch(url, {
            headers: { "User-Agent": "Agents-Task-Runner" }
          });
          if (response.ok) {
            results[file.path] = (await response.text()).slice(0, 5000);
          }
        } catch {
          // Skip
        }
      }
    }

    return results;
  }

  private async analyzeWithAI(
    repoUrl: string,
    files: RepoFile[],
    keyFiles: Record<string, string>
  ) {
    const openai = this.getOpenAI();

    const fileList = files
      .filter((f) => f.type === "file")
      .map((f) => f.path)
      .slice(0, 200)
      .join("\n");

    const keyFilesContent = Object.entries(keyFiles)
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a senior software architect. Analyze the repository and respond with JSON:
{ "summary": "...", "architecture": "...", "techStack": [...], "suggestions": [...] }`
        },
        {
          role: "user",
          content: `Analyze: ${repoUrl}\n\nFILES:\n${fileList}\n\nKEY FILES:\n${keyFilesContent}`
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    });

    let text = completion.choices[0]?.message?.content || "{}";

    // Strip markdown code fences if present
    text = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(text);
      return {
        summary: parsed.summary || "Unable to generate summary",
        architecture: parsed.architecture || "Unable to analyze",
        techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
      };
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            summary: parsed.summary || text.slice(0, 500),
            architecture: parsed.architecture || "See summary",
            techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
            suggestions: Array.isArray(parsed.suggestions)
              ? parsed.suggestions
              : []
          };
        } catch {
          // Fall through to fallback
        }
      }
      return {
        summary: text.slice(0, 500),
        architecture: "Unable to parse AI response",
        techStack: [],
        suggestions: []
      };
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
