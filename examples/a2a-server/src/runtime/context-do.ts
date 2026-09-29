import { Artifact, TaskState } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, validateVersion } from "@a2a-js/sdk/server";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { Agent } from "agents";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
  MemoryLimitContext
} from "agents/lifecycle";
import { authenticateRequest, createServerCallContext } from "./auth";
import { readBodyWithLimit } from "./body";
import { WorkflowAgentExecutor } from "./executor";
import { applyA2AServerFeatures, resolveA2AServerFeatures } from "./features";
import { deriveArtifactPublicationId, textArtifact } from "./messages";
import {
  assertJsonObject,
  parseLosslessJson,
  prepareA2ARequestForSdk,
  validateA2AJsonRpcRequest,
  validateArtifactValues,
  validateArtifactValue
} from "./json-validation";
import { DurableA2ARequestHandler } from "./request-handler";
import {
  DEFAULT_TERMINAL_TASK_RETENTION_MILLISECONDS,
  DurableObjectTaskStore,
  EVENT_RETENTION_MILLISECONDS
} from "./task-store";
import { createJsonRpcSseResponse, jsonRpcErrorResponse } from "./transport";
import {
  validateA2ARuntimeOptions,
  type A2ARuntimeEnv,
  type A2ARuntimeOptions
} from "./types";

const A2A_RECOVERY_JOB_ID = "a2a-recovery";
const A2A_RECOVERY_JOB_FN = "a2aRecovery";
const MEMORY_LIMIT_RECOVERY_FAILURE =
  "durable recovery exhausted its memory-limit retry budget.";
const WORKFLOW_COMPACTION_BATCH_SIZE = 64;
const ACTIVE_WORKFLOW_TASK_STATES = [
  TaskState.TASK_STATE_UNSPECIFIED,
  TaskState.TASK_STATE_SUBMITTED,
  TaskState.TASK_STATE_WORKING
] as const;

/**
 * Creates the Durable Object class that owns SQLite task state and coordinates
 * Workflow execution for one bounded shard of A2A contexts.
 */
export function createA2AContextDO<Env extends A2ARuntimeEnv>(
  options: A2ARuntimeOptions<Env>
) {
  validateA2ARuntimeOptions(options);
  const features = resolveA2AServerFeatures(options.features);
  if (options.completionArtifacts && !features.completionArtifacts) {
    throw new Error(
      "completionArtifacts requires features.completionArtifacts to be enabled."
    );
  }
  if (options.onCancel && !features.taskCancellation) {
    throw new Error(
      "onCancel requires features.taskCancellation to be enabled."
    );
  }
  return class A2AContextDOBase extends Agent<Cloudflare.Env> {
    private readonly store: DurableObjectTaskStore;
    private readonly executor: WorkflowAgentExecutor;
    private readonly runtimeEnv: Env;
    private readonly recoveryAlarm = {
      getAlarm: () =>
        this.lifecycle.jobs.get(A2A_RECOVERY_JOB_ID)?.time ?? null,
      setAlarm: async (scheduledTime: number) => {
        await this.lifecycle.jobs.push({
          id: A2A_RECOVERY_JOB_ID,
          fn: A2A_RECOVERY_JOB_FN,
          time: scheduledTime,
          singleflight: true,
          recoveryLoop: true
        });
      }
    };

    /** Initializes this shard's durable store and Workflow executor. */
    constructor(ctx: DurableObjectState, env: Env & Cloudflare.Env) {
      super(ctx, env);
      this.runtimeEnv = env;
      this.store = new DurableObjectTaskStore(
        this.ctx.storage,
        {
          agentBinding: options.agentBinding,
          agentName: this.name,
          workflowName: options.workflowName
        },
        features.streaming || features.intermediateArtifacts,
        options.onCancel !== undefined,
        this.recoveryAlarm,
        options.terminalTaskRetentionMilliseconds ??
          DEFAULT_TERMINAL_TASK_RETENTION_MILLISECONDS
      );
      const workflowName = options.workflowName as Parameters<
        typeof this.runWorkflow
      >[0];
      this.executor = new WorkflowAgentExecutor({
        adoptWorkflow: (instanceId) => this.adoptWorkflow(instanceId),
        getWorkflow: (instanceId) => this.getWorkflow(instanceId),
        getWorkflowStatus: async (instanceId) => {
          const status = await this.getWorkflowStatus(workflowName, instanceId);
          return {
            status: status.status,
            ...(status.error
              ? {
                  error: {
                    name: status.error.name,
                    message: status.error.message
                  }
                }
              : {})
          };
        },
        runWorkflow: async (instanceId, params) => {
          await this.runWorkflow(workflowName, params, {
            id: instanceId,
            agentBinding: options.agentBinding
          });
        },
        terminateWorkflow: (instanceId) => this.terminateWorkflow(instanceId)
      });
    }

    /** Repairs Agent tracking when Workflow creation won a storage interruption. */
    private async adoptWorkflow(instanceId: string): Promise<boolean> {
      const binding = (this.runtimeEnv as Record<string, unknown>)[
        options.workflowName
      ];
      if (!isWorkflowBinding(binding)) {
        throw new Error(
          `Workflow binding '${options.workflowName}' not found in environment`
        );
      }

      let status: InstanceStatus;
      try {
        status = await (await binding.get(instanceId)).status();
      } catch (error) {
        if (isMissingWorkflowInstance(error)) return false;
        throw error;
      }

      const rowId = crypto.randomUUID();
      const errorName = status.error?.name ?? null;
      const errorMessage = status.error?.message ?? null;
      const completedAt = isTerminalWorkflowStatus(status.status)
        ? Math.floor(Date.now() / 1000)
        : null;
      this.sql`
        INSERT OR IGNORE INTO cf_agents_workflows (
          id, workflow_id, workflow_name, status, metadata,
          error_name, error_message, completed_at
        ) VALUES (
          ${rowId}, ${instanceId}, ${options.workflowName}, ${status.status}, NULL,
          ${errorName}, ${errorMessage}, ${completedAt}
        )
      `;
      return this.getWorkflow(instanceId) !== undefined;
    }

    /** Dispatches authenticated JSON-RPC requests as either JSON or SSE. */
    override async onRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (
        !(await authenticateRequest(
          request,
          options.bearerToken(this.runtimeEnv)
        ))
      ) {
        return options.unauthorizedResponse();
      }

      let body: string;
      try {
        body = await readBodyWithLimit(request, options.maxRequestBytes);
      } catch (error) {
        const message = errorMessage(error);
        return message === "Request body is too large"
          ? Response.json({ error: message }, { status: 413 })
          : jsonRpcErrorResponse("", new RequestMalformedError(message));
      }

      let rpc: Record<string, unknown>;
      try {
        const parsed = parseLosslessJson(body);
        validateA2AJsonRpcRequest(parsed);
        rpc = parsed;
        prepareA2ARequestForSdk(rpc);
      } catch (error) {
        return jsonRpcErrorResponse(
          body,
          new RequestMalformedError(errorMessage(error))
        );
      }

      const card = applyA2AServerFeatures(
        options.agentCard(url.origin, this.runtimeEnv),
        features
      );
      const abortController = new AbortController();
      request.signal.addEventListener(
        "abort",
        () => abortController.abort(request.signal.reason),
        { once: true }
      );
      if (request.signal.aborted) abortController.abort(request.signal.reason);
      const context = createServerCallContext(
        request,
        options.ownerName,
        abortController.signal
      );
      try {
        validateVersion(context.requestedVersion, card, "JSONRPC");
      } catch (error) {
        return jsonRpcErrorResponse(body, error);
      }

      const handler = new DurableA2ARequestHandler(
        card,
        this.store,
        this.executor,
        {
          errors: options.errors,
          features,
          maxTextCharacters: options.maxTextCharacters,
          cancellationHook: options.onCancel
            ? (task) => options.onCancel!(task, this.runtimeEnv)
            : undefined
        }
      );
      const result = await new JsonRpcTransportHandler(handler).handle(
        rpc,
        context
      );
      if (!isAsyncIterable(result)) return Response.json(result);
      return createJsonRpcSseResponse(result, body, abortController);
    }

    /** Dispatches the runtime recovery job through the Agent lifecycle queue. */
    override async onJob(
      context: LifecycleJobContext
    ): Promise<LifecycleJobOutcome | void> {
      if (
        context.job.id === A2A_RECOVERY_JOB_ID &&
        context.job.fn === A2A_RECOVERY_JOB_FN
      ) {
        await this.runRecovery();
        return;
      }
      return super.onJob(context);
    }

    /** Prevents durable A2A work from remaining active after recovery is sealed. */
    protected override async onAlarmMemoryLimit(
      context: MemoryLimitContext
    ): Promise<void> {
      await super.onAlarmMemoryLimit(context);
      if (!context.sealed) return;
      this.store.sealPendingRecovery(MEMORY_LIMIT_RECOVERY_FAILURE);
      await this.scheduleNextMaintenanceAlarm();
    }

    /** Runs bounded maintenance and recovers Workflow state. */
    private async runRecovery(): Promise<void> {
      // Persist a successor before any fallible recovery or maintenance work.
      await this.store.armRecovery(5_000, true);
      const maintenancePending = this.store.runMaintenance();
      const workflowMaintenancePending = this.compactWorkflowTracking();
      if (
        !this.store.hasPendingRecovery() &&
        !maintenancePending &&
        !workflowMaintenancePending
      ) {
        await this.scheduleNextMaintenanceAlarm();
        return;
      }
      for (const target of this.store.pendingCancellations()) {
        try {
          await this.executor.terminate(
            target.workflowInstanceId,
            target.params,
            target.allowMissing
          );
          this.store.recoverCancellationAfterTermination(target);
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "workflow cancellation recovery failed",
              taskId: target.taskId,
              workflowInstanceId: target.workflowInstanceId,
              error: error instanceof Error ? error.name : "UnknownError"
            })
          );
        }
      }

      if (options.onCancel) {
        for (const delivery of this.store.pendingCancellationHooks()) {
          const stableTaskId = delivery.taskId;
          try {
            await options.onCancel(
              structuredClone(delivery.task),
              this.runtimeEnv
            );
            this.store.acknowledgeCancellationHook(stableTaskId);
          } catch (error) {
            console.error(
              JSON.stringify({
                message: "task cancellation hook failed",
                taskId: stableTaskId,
                error: error instanceof Error ? error.name : "UnknownError"
              })
            );
          }
        }
      }

      for (const launch of this.store.pendingLaunches()) {
        try {
          await this.executor.start(launch.workflowInstanceId, launch.params);
          this.store.markWorking(launch.params.taskId, launch.params.turn);
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "workflow alarm recovery failed",
              taskId: launch.params.taskId,
              workflowInstanceId: launch.workflowInstanceId,
              error: error instanceof Error ? error.name : "UnknownError"
            })
          );
        }
      }

      for (const target of this.store.pendingWorkflowReconciliations()) {
        try {
          const workflow = await this.executor.inspect(
            target.workflowInstanceId
          );
          if (
            workflow.status === "complete" ||
            workflow.status === "errored" ||
            workflow.status === "missing" ||
            workflow.status === "terminated"
          ) {
            this.store.reconcileWorkflowTerminal(
              target,
              workflow.status,
              workflow.error
            );
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "workflow terminal reconciliation failed",
              taskId: target.taskId,
              workflowInstanceId: target.workflowInstanceId,
              error: error instanceof Error ? error.name : "UnknownError"
            })
          );
        }
      }
      if (
        this.store.hasPendingRecovery() ||
        this.store.hasPendingMaintenance() ||
        this.hasPendingWorkflowTrackingMaintenance()
      ) {
        await this.store.armRecovery(5_000);
      } else {
        await this.scheduleNextMaintenanceAlarm();
      }
    }

    private async scheduleNextMaintenanceAlarm(): Promise<void> {
      const next = [
        this.store.nextTerminalEventCompactionAt(),
        this.store.nextTerminalTaskCompactionAt(),
        this.nextWorkflowTrackingCompactionAt()
      ].reduce<number | undefined>(
        (earliest, candidate) =>
          candidate === undefined
            ? earliest
            : earliest === undefined
              ? candidate
              : Math.min(earliest, candidate),
        undefined
      );
      if (next === undefined) {
        await this.lifecycle.jobs.cancel(A2A_RECOVERY_JOB_ID);
        return;
      }
      await this.store.armRecovery(Math.max(1, next - Date.now()), true);
    }

    /** Deletes a bounded batch of aged terminal Agent Workflow tracking rows. */
    private compactWorkflowTracking(): boolean {
      const cutoff = Math.floor(
        (Date.now() - EVENT_RETENTION_MILLISECONDS) / 1_000
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM cf_agents_workflows WHERE id IN (
           SELECT workflows.id FROM cf_agents_workflows AS workflows
           WHERE workflows.workflow_name = ?
             AND workflows.completed_at IS NOT NULL
             AND workflows.completed_at < ?
             AND workflows.status IN ('complete', 'errored', 'terminated')
             AND NOT EXISTS (
               SELECT 1 FROM a2a_tasks AS tasks
               WHERE tasks.workflow_instance_id = workflows.workflow_id
                 AND tasks.state IN (?, ?, ?)
             )
           ORDER BY workflows.completed_at, workflows.id LIMIT ?
         )`,
        options.workflowName,
        cutoff,
        ...ACTIVE_WORKFLOW_TASK_STATES,
        WORKFLOW_COMPACTION_BATCH_SIZE
      );
      return this.hasPendingWorkflowTrackingMaintenance();
    }

    private hasPendingWorkflowTrackingMaintenance(): boolean {
      const cutoff = Math.floor(
        (Date.now() - EVENT_RETENTION_MILLISECONDS) / 1_000
      );
      return (
        this.ctx.storage.sql
          .exec<{ count: number }>(
            `SELECT EXISTS(
               SELECT 1 FROM cf_agents_workflows AS workflows
               WHERE workflows.workflow_name = ?
                 AND workflows.completed_at IS NOT NULL
                 AND workflows.completed_at < ?
                 AND workflows.status IN ('complete', 'errored', 'terminated')
                 AND NOT EXISTS (
                   SELECT 1 FROM a2a_tasks AS tasks
                   WHERE tasks.workflow_instance_id = workflows.workflow_id
                     AND tasks.state IN (?, ?, ?)
                 )
             ) AS count`,
            options.workflowName,
            cutoff,
            ...ACTIVE_WORKFLOW_TASK_STATES
          )
          .one().count > 0
      );
    }

    private nextWorkflowTrackingCompactionAt(): number | undefined {
      const row = this.ctx.storage.sql
        .exec<{ timestamp: number | null }>(
          `SELECT MIN(completed_at) AS timestamp
           FROM cf_agents_workflows AS workflows
           WHERE workflows.workflow_name = ?
             AND workflows.completed_at IS NOT NULL
             AND workflows.status IN ('complete', 'errored', 'terminated')
             AND NOT EXISTS (
               SELECT 1 FROM a2a_tasks AS tasks
               WHERE tasks.workflow_instance_id = workflows.workflow_id
                 AND tasks.state IN (?, ?, ?)
             )`,
          options.workflowName,
          ...ACTIVE_WORKFLOW_TASK_STATES
        )
        .one();
      return row.timestamp === null
        ? undefined
        : (row.timestamp +
            Math.ceil(EVENT_RETENTION_MILLISECONDS / 1_000) +
            1) *
            1_000;
    }

    /** Records completion for the active turn using supplied or generated artifacts. */
    completeTask(
      taskId: string,
      response: string,
      artifacts: Artifact[] = [],
      metadata: Record<string, unknown> = {},
      turn?: number
    ): void {
      if (turn !== undefined) assertWorkflowTurn(turn);
      assertJsonObject(metadata, "Completion metadata");
      if (!Array.isArray(artifacts)) {
        throw new Error("Completion artifacts must be an array.");
      }
      validateArtifactValues(artifacts, "Completion artifacts");
      if (!features.completionArtifacts && artifacts.length > 0) {
        throw new Error("Completion artifacts are not enabled.");
      }
      const activeTurn = this.store.completableWorkflowTurn(taskId, turn);
      if (activeTurn === undefined) return;
      let configuredArtifacts: Artifact[] | undefined;
      if (
        features.completionArtifacts &&
        artifacts.length === 0 &&
        options.completionArtifacts
      ) {
        const generated: unknown = options.completionArtifacts(
          response,
          metadata,
          this.runtimeEnv
        );
        validateArtifactValues(generated, "Configured completion artifacts");
        configuredArtifacts = generated;
      }
      const completionArtifacts = !features.completionArtifacts
        ? []
        : artifacts.length > 0
          ? artifacts
          : configuredArtifacts && configuredArtifacts.length > 0
            ? configuredArtifacts
            : [
                textArtifact(
                  "response",
                  "Response",
                  "The generated response.",
                  response
                )
              ];
      this.store.completeInternal(
        taskId,
        response,
        completionArtifacts,
        metadata,
        activeTurn
      );
    }

    /** Publishes one intermediate artifact for the active turn. */
    async publishTaskArtifact(
      taskId: string,
      artifact: Artifact,
      turn?: number,
      publicationId?: string
    ): Promise<void> {
      if (turn !== undefined) assertWorkflowTurn(turn);
      validateArtifactValue(artifact, "Published artifact");
      if (!features.intermediateArtifacts) {
        throw new Error("Intermediate artifacts are not enabled.");
      }
      const activeTurn = this.store.resolveWorkflowCallbackTurn(
        taskId,
        turn,
        "Artifact publication"
      );
      // Older in-flight Workflows did not carry an explicit publication ID.
      const stablePublicationId =
        publicationId ??
        (await deriveArtifactPublicationId(taskId, artifact, activeTurn));
      this.store.publishArtifactInternal(
        taskId,
        stablePublicationId,
        artifact,
        activeTurn
      );
    }

    /** Records an allowed Workflow failure for the supplied active turn. */
    failTask(taskId: string, reason: string, turn?: number): void {
      if (turn !== undefined) assertWorkflowTurn(turn);
      this.store.failInternal(
        taskId,
        reason,
        this.store.resolveWorkflowCallbackTurn(taskId, turn, "Failure")
      );
    }

    /** Pauses the active turn and stores the agent's clarification question. */
    requireInput(taskId: string, question: string, turn?: number): void {
      if (turn !== undefined) assertWorkflowTurn(turn);
      if (!features.multiTurn) {
        throw new Error("Multi-turn continuation is not enabled.");
      }
      this.store.requireInputInternal(
        taskId,
        question,
        this.store.resolveWorkflowCallbackTurn(taskId, turn, "Input-required")
      );
    }

    /** Adds one unique metadata item when the supplied turn is current. */
    appendTaskMetadataItem(
      taskId: string,
      key: string,
      item: unknown,
      turn?: number
    ) {
      if (turn !== undefined) assertWorkflowTurn(turn);
      return this.store.appendMetadataItem(
        taskId,
        key,
        item,
        this.store.resolveWorkflowCallbackTurn(taskId, turn, "Metadata append")
      );
    }
  };
}

/** Distinguishes a streamed SDK result from a single JSON-RPC result. */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

function assertWorkflowTurn(turn: number): void {
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    throw new Error("Workflow callback turn must be a positive safe integer.");
  }
}

function isWorkflowBinding(value: unknown): value is Workflow {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    "create" in value
  );
}

function isMissingWorkflowInstance(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return (
    code === "instance.not_found" ||
    code === 10400 ||
    (error instanceof Error && error.message.trim() === "instance.not_found")
  );
}

function isTerminalWorkflowStatus(status: InstanceStatus["status"]): boolean {
  return (
    status === "complete" || status === "errored" || status === "terminated"
  );
}

/** Safely turns any thrown value into an error message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
