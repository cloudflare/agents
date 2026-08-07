import {
  Think,
  type ToolCallContext,
  type ToolCallDecision,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type { RunAgentToolResult } from "agents";
import type { UIMessage } from "ai";
import type {
  CodemodeConnector,
  CodemodeRuntimeHandle,
  ProxyToolOutput
} from "@cloudflare/codemode";
import {
  ContextConnector,
  HarnessConnector,
  KernelConnector,
  RlmConnector,
  type ChildTurn,
  type RlmFollowup,
  type RlmHost,
  type RlmTask
} from "./connectors";
import {
  MAX_CONTEXT_OUTPUT_CHARS,
  MAX_INPUT_CHARS,
  boundedInteger,
  isRecord,
  modelReasoningEffort,
  requireString,
  stableId,
  truncateText,
  truncateUnknown
} from "./core";
import {
  buildSystemPrompt,
  buildTurnPrompt,
  harnessSummary,
  type RunMode
} from "./prompts";
import { RlmStore, type InputMeta, type RlmOperationKind } from "./store";

type RuntimeConfig = {
  model: string;
  reasoningEffort: "low" | "medium" | "high" | null;
  maxSteps: number;
  maxDepth: number;
  maxRlmCalls: number;
  timeoutMs: number;
};

type TurnBinding = { meta: InputMeta; mode: RunMode };

type RlmJob = {
  inputId: string;
  prompt: string;
  material: string;
};

type RlmOutput = {
  answer: string;
  inputId: string;
  executionId: string;
};

const TURN_METADATA_KEY = "codemodeRlm";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configFromEnv(env: Env): RuntimeConfig {
  return {
    model: env.MODEL || "@cf/moonshotai/kimi-k2.7-code",
    reasoningEffort: modelReasoningEffort(env.REASONING_EFFORT),
    maxSteps: boundedInteger(env.MAX_STEPS, 12, 2, 40),
    maxDepth: boundedInteger(env.MAX_RLM_DEPTH, 1, 0, 1),
    maxRlmCalls: boundedInteger(env.MAX_RLM_CALLS, 8, 0, 16),
    timeoutMs: boundedInteger(env.TURN_TIMEOUT_MS, 180_000, 10_000, 900_000)
  };
}

function parseJob(value: unknown): RlmJob {
  if (!isRecord(value)) throw new Error("RLM child input must be an object");
  return {
    inputId: requireString(value.inputId, "inputId", { min: 1, max: 120 }),
    prompt: requireString(value.prompt, "prompt", { min: 1, max: 32_000 }),
    material: requireString(value.material ?? "", "material", { max: 250_000 })
  };
}

function turnMessage(
  meta: InputMeta,
  preview: string,
  mode: RunMode
): UIMessage {
  return {
    id: `rlm-input-${meta.id}`,
    role: "user",
    metadata: { [TURN_METADATA_KEY]: { inputId: meta.id, mode } },
    parts: [{ type: "text", text: buildTurnPrompt(meta, preview, mode) }]
  };
}

function compactToolOutput(
  output: ProxyToolOutput,
  finished: boolean
): unknown {
  if (output.status === "completed") {
    return {
      status: "completed",
      executionId: output.executionId,
      result: truncateUnknown(output.result, MAX_CONTEXT_OUTPUT_CHARS),
      finished
    };
  }
  if (output.status === "paused") {
    return {
      status: "paused",
      executionId: output.executionId,
      pending: output.pending.map(({ seq, connector, method }) => ({
        seq,
        connector,
        method
      })),
      finished: false
    };
  }
  return {
    status: "error",
    executionId: output.executionId,
    error: truncateText(output.error, MAX_CONTEXT_OUTPUT_CHARS),
    finished: false
  };
}

type RuntimeTool = ReturnType<CodemodeRuntimeHandle["tool"]>;

function compactTool(
  raw: RuntimeTool,
  isFinished: (output: ProxyToolOutput) => boolean
): RuntimeTool {
  return {
    ...raw,
    execute: async (input, options) => {
      const output = await raw.execute(input, options);
      return compactToolOutput(output, isFinished(output)) as ProxyToolOutput;
    }
  };
}

abstract class RlmBaseAgent extends Think<Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools: false = false;
  override chatRecovery = true;

  protected readonly store: RlmStore;
  protected readonly config: RuntimeConfig;

  protected get depth(): number {
    return 1;
  }

  protected get isRoot(): boolean {
    return false;
  }

  protected get canDelegate(): boolean {
    return false;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RlmStore(ctx.storage);
    this.config = configFromEnv(env);
    this.maxConcurrentAgentTools = Math.max(1, this.config.maxRlmCalls);
  }

  override getModel(): string {
    return this.config.model;
  }

  protected validatedOutput(inputId: string): RlmOutput | undefined {
    const answer = this.store.answerRecord(inputId);
    return answer
      ? {
          answer: answer.content,
          inputId,
          executionId: answer.executionId
        }
      : undefined;
  }

  protected currentTurn(): TurnBinding {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.role !== "user") continue;
      const metadata = isRecord(message.metadata) ? message.metadata : {};
      const binding = metadata[TURN_METADATA_KEY];
      if (isRecord(binding) && typeof binding.inputId === "string") {
        return {
          meta: this.store.inputMeta(binding.inputId),
          mode: binding.mode === "refine" ? "refine" : "think"
        };
      }
    }
    throw new Error(
      "RLM turn metadata is missing; submit work through the authenticated session API"
    );
  }

  protected createHost(_turn: TurnBinding): RlmHost | undefined {
    return undefined;
  }

  protected runtimeFor(turn: TurnBinding): RuntimeTool {
    const connectors: CodemodeConnector[] = [
      new ContextConnector(
        this.ctx,
        this.env,
        this.store,
        "root",
        turn.meta.id
      ),
      new KernelConnector(this.ctx, this.env, this.store, "root", turn.meta.id)
    ];
    const host = this.createHost(turn);
    if (host) connectors.push(new RlmConnector(this.ctx, this.env, host));
    if (this.isRoot) {
      connectors.push(
        new HarnessConnector(
          this.ctx,
          this.env,
          this.store,
          turn.mode === "refine",
          turn.meta.id
        )
      );
    }
    const capabilities = [
      "external context",
      "durable kernel state",
      ...(host ? ["depth-one sub-agents"] : []),
      ...(this.isRoot ? ["the continual harness"] : [])
    ];

    const built = createExecuteRuntime({
      ctx: this.ctx,
      loader: this.env.LOADER,
      connectors,
      name: "think",
      timeout: Math.max(
        2_500,
        Math.floor(this.config.timeoutMs * (this.isRoot ? 0.7 : 0.4))
      ),
      globalOutbound: null,
      description:
        "The only model-facing tool. Program over " +
        capabilities.join(", ") +
        "."
    });
    this.codemode = built.runtime;
    return compactTool(
      built.tool as RuntimeTool,
      (output) =>
        output.status === "completed" &&
        this.store.answerRecord(turn.meta.id)?.executionId ===
          output.executionId
    );
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    const turn = this.currentTurn();
    this.store.activateInput(turn.meta.id, "root");
    const finished = Boolean(this.validatedOutput(turn.meta.id));
    const taskPreview = this.store.inputSlice(
      turn.meta.id,
      "task",
      0,
      1_200
    ).content;
    return {
      instructions: buildSystemPrompt({
        mode: turn.mode,
        depth: this.depth,
        maxDepth: this.config.maxDepth,
        maxSteps: this.config.maxSteps,
        maxRlmCalls: this.config.maxRlmCalls,
        canDelegate: this.canDelegate,
        canUseHarness: this.isRoot,
        harnessOverview: this.isRoot ? this.store.harnessOverview() : ""
      }),
      messages: [
        {
          role: "user",
          content: buildTurnPrompt(
            turn.meta,
            taskPreview,
            turn.mode,
            ctx.continuation
          )
        }
      ],
      tools: { codemode: this.runtimeFor(turn) },
      activeTools: finished ? [] : ["codemode"],
      toolChoice: finished ? "none" : { type: "tool", toolName: "codemode" },
      maxSteps: this.config.maxSteps,
      stopWhen: () => Boolean(this.validatedOutput(turn.meta.id)),
      maxRetries: 2,
      providerOptions: {
        "workers-ai": { reasoning_effort: this.config.reasoningEffort }
      },
      timeout: {
        totalMs: this.isRoot
          ? this.config.timeoutMs
          : Math.max(5_000, Math.floor(this.config.timeoutMs * 0.55))
      },
      chatStreamStallTimeoutMs: 0
    };
  }

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | undefined {
    return ctx.toolName === "codemode"
      ? undefined
      : { action: "block", reason: "This RLM exposes only the codemode tool." };
  }
}

export class RlmChildAgent extends RlmBaseAgent {
  #persist(job: RlmJob): InputMeta {
    return this.store.putInput({
      id: job.inputId,
      scope: "root",
      kind: "child",
      task: job.prompt,
      material: job.material
    });
  }

  protected override formatAgentToolInput(input: unknown): UIMessage {
    const job = parseJob(input);
    const meta = this.#persist(job);
    return turnMessage(meta, truncateText(job.prompt, 1_200), "think");
  }

  protected override getAgentToolOutput(_runId: string): unknown {
    return this.validatedOutput(this.currentTurn().meta.id);
  }

  protected override getAgentToolSummary(
    _runId: string,
    output: unknown
  ): string {
    return isRecord(output) && typeof output.answer === "string"
      ? truncateText(output.answer, 2_000)
      : "";
  }

  async submitRlmTurn(rawJob: RlmJob): Promise<unknown> {
    const job = parseJob(rawJob);
    const meta = this.#persist(job);
    return this.submitMessages(
      [turnMessage(meta, truncateText(job.prompt, 1_200), "think")],
      {
        submissionId: meta.id,
        idempotencyKey: meta.id,
        metadata: { inputId: meta.id, kind: "codemode-rlm-child" },
        channel: "web"
      }
    );
  }

  async resumeRlmTurn(inputId: string): Promise<void> {
    const payload = this.store.inputPayload(inputId);
    await this.submitRlmTurn({
      inputId,
      prompt: payload.task,
      material: payload.material
    });
  }

  async rlmTurnStatus(rawInputId?: string): Promise<ChildTurn> {
    const meta = rawInputId
      ? this.store.inputMeta(
          requireString(rawInputId, "inputId", { min: 1, max: 120 })
        )
      : this.store.latestInput("root");
    if (!meta) return { childId: "", status: "missing" };
    const output = this.validatedOutput(meta.id);
    if (output) {
      return {
        childId: "",
        inputId: meta.id,
        status: "completed",
        answer: truncateText(output.answer, MAX_CONTEXT_OUTPUT_CHARS),
        answerChars: output.answer.length
      };
    }
    const submission = await this.inspectSubmission(meta.id);
    if (!submission)
      return { childId: "", inputId: meta.id, status: "missing" };
    if (submission.status === "pending") {
      return { childId: "", inputId: meta.id, status: "admitted" };
    }
    if (submission.status === "running") {
      return { childId: "", inputId: meta.id, status: "running" };
    }
    return {
      childId: "",
      inputId: meta.id,
      status: "error",
      error: truncateText(
        submission.error ??
          (submission.status === "completed"
            ? "child completed without kernel.finish"
            : `child submission ended with ${submission.status}`),
        MAX_CONTEXT_OUTPUT_CHARS
      )
    };
  }

  async answerSlice(
    rawInputId: string | undefined,
    start: number,
    length: number
  ) {
    const meta = rawInputId
      ? this.store.inputMeta(rawInputId)
      : this.store.latestInput("root");
    if (!meta) return null;
    const answer = this.store.answerRecord(meta.id);
    if (!answer) return null;
    const boundedStart = Math.max(
      0,
      Math.min(answer.content.length, Math.trunc(start))
    );
    const end = Math.min(
      answer.content.length,
      boundedStart + Math.max(1, Math.trunc(length))
    );
    return {
      start: boundedStart,
      end,
      total: answer.content.length,
      content: answer.content.slice(boundedStart, end)
    };
  }
}

export class RlmThinkAgent extends RlmBaseAgent {
  protected override get isRoot(): boolean {
    return true;
  }

  protected override get depth(): number {
    return 0;
  }

  protected override get canDelegate(): boolean {
    return this.config.maxDepth > 0 && this.config.maxRlmCalls > 0;
  }

  protected override createHost(turn: TurnBinding): RlmHost | undefined {
    return this.canDelegate
      ? {
          query: (input) => this.query(turn, input),
          spawn: (input) => this.spawn(turn, input),
          followup: (input) => this.followup(turn, input),
          status: (childId, inputId) => this.childStatus(childId, inputId),
          list: (limit) => this.listChildren(limit),
          read: (childId, inputId, start, length) =>
            this.readChild(childId, inputId, start, length)
        }
      : undefined;
  }

  async #claim(
    turn: TurnBinding,
    kind: RlmOperationKind,
    input: RlmTask | RlmFollowup,
    childId: string,
    inputId: string
  ): Promise<void> {
    if (!this.canDelegate) throw new Error("recursive delegation is disabled");
    const argsHash = await stableId(
      "args",
      kind,
      input.key,
      "childId" in input ? input.childId : "",
      input.prompt,
      input.material
    );
    const operationId = await stableId(
      "op",
      turn.meta.id,
      kind,
      "childId" in input ? input.childId : "",
      input.key
    );
    this.store.claimOperation({
      id: operationId,
      rootInputId: turn.meta.id,
      kind,
      key: input.key,
      argsHash,
      childId,
      turnInputId: inputId,
      maximum: this.config.maxRlmCalls
    });
  }

  async query(turn: TurnBinding, input: RlmTask): Promise<ChildTurn> {
    const operationId = await stableId("op", turn.meta.id, "query", input.key);
    const childId = await stableId("query", operationId);
    const inputId = await stableId("turn", operationId);
    await this.#claim(turn, "query", input, childId, inputId);
    const result = await this.runAgentTool<RlmJob, RlmOutput>(RlmChildAgent, {
      runId: childId,
      input: {
        inputId,
        prompt: input.prompt,
        material: input.material
      },
      inputPreview: {
        prompt: truncateText(input.prompt, 300),
        materialChars: input.material.length
      }
    });
    return this.queryResult(childId, inputId, result);
  }

  private queryResult(
    childId: string,
    inputId: string,
    result: RunAgentToolResult<RlmOutput>
  ): ChildTurn {
    if (result.status === "completed" && result.output?.answer) {
      return {
        childId,
        inputId,
        status: "completed",
        answer: truncateText(result.output.answer, MAX_CONTEXT_OUTPUT_CHARS),
        answerChars: result.output.answer.length
      };
    }
    throw new Error(
      truncateText(
        result.error ??
          (result.status === "completed"
            ? "child completed without kernel.finish"
            : `child ended with ${result.status}`),
        MAX_CONTEXT_OUTPUT_CHARS
      )
    );
  }

  async spawn(turn: TurnBinding, input: RlmTask): Promise<ChildTurn> {
    const operationId = await stableId("op", turn.meta.id, "spawn", input.key);
    const childId = await stableId("child", operationId);
    const inputId = await stableId("turn", operationId);
    await this.#claim(turn, "spawn", input, childId, inputId);
    const child = await this.subAgent(RlmChildAgent, childId);
    await child.submitRlmTurn({
      inputId,
      prompt: input.prompt,
      material: input.material
    });
    return { childId, inputId, status: "admitted" };
  }

  async followup(turn: TurnBinding, input: RlmFollowup): Promise<ChildTurn> {
    this.#requireChild(input.childId, true);
    const operationId = await stableId(
      "op",
      turn.meta.id,
      "followup",
      input.childId,
      input.key
    );
    const inputId = await stableId("turn", operationId);
    await this.#claim(turn, "followup", input, input.childId, inputId);
    const child = await this.subAgent(RlmChildAgent, input.childId);
    await child.submitRlmTurn({
      inputId,
      prompt: input.prompt,
      material: input.material
    });
    return { childId: input.childId, inputId, status: "admitted" };
  }

  #requireChild(childId: string, retained = false): void {
    if (
      (retained && !childId.startsWith("child_")) ||
      !this.hasSubAgent(RlmChildAgent, childId)
    ) {
      throw new Error(
        `${retained ? "retained " : ""}child ${childId} was not found`
      );
    }
  }

  async childStatus(childId: string, inputId?: string): Promise<ChildTurn> {
    this.#requireChild(childId);
    const child = await this.subAgent(RlmChildAgent, childId);
    let status = await child.rlmTurnStatus(inputId);
    if (status.status === "missing" && status.inputId) {
      await child.resumeRlmTurn(status.inputId);
      status = await child.rlmTurnStatus(status.inputId);
    }
    return { ...status, childId };
  }

  async listChildren(limit: number): Promise<ChildTurn[]> {
    const records = this.listSubAgents(RlmChildAgent)
      .filter((record) => record.name.startsWith("child_"))
      .slice(-limit);
    return Promise.all(
      records.map(async (record) => {
        try {
          return {
            ...(await this.childStatus(record.name)),
            createdAt: record.createdAt
          };
        } catch (error) {
          return {
            childId: record.name,
            status: "error" as const,
            error: truncateText(errorMessage(error), MAX_CONTEXT_OUTPUT_CHARS),
            createdAt: record.createdAt
          };
        }
      })
    );
  }

  async readChild(
    childId: string,
    inputId: string | undefined,
    start: number,
    length: number
  ) {
    this.#requireChild(childId);
    return (await this.subAgent(RlmChildAgent, childId)).answerSlice(
      inputId,
      start,
      length
    );
  }

  private async submitRoot(meta: InputMeta): Promise<void> {
    const preview = this.store.inputSlice(meta.id, "task", 0, 1_200).content;
    const mode: RunMode = meta.kind === "refine" ? "refine" : "think";
    await this.submitMessages([turnMessage(meta, preview, mode)], {
      submissionId: meta.id,
      idempotencyKey: meta.id,
      metadata: {
        inputId: meta.id,
        requestId: meta.requestId,
        kind: meta.kind
      },
      channel: "web"
    });
  }

  private async healSubmission(meta: InputMeta): Promise<void> {
    try {
      await this.submitRoot(meta);
    } catch {
      // The durable write may have succeeded before the RPC failed. Polling
      // inspects the same stable submission id and safely retries if missing.
    }
  }

  async runThink(body: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    const requestId = requireString(body.requestId, "requestId", {
      min: 1,
      max: 120
    });
    const task = requireString(body.task, "task", {
      min: 1,
      max: MAX_INPUT_CHARS
    });
    if (body.context !== undefined && body.material !== undefined) {
      throw new Error("send either context or material, not both");
    }
    const material = requireString(
      body.context ?? body.material ?? "",
      "context",
      {
        max: MAX_INPUT_CHARS
      }
    );
    const inputId = await stableId("request", requestId);
    const meta = this.store.putInput({
      id: inputId,
      scope: "root",
      requestId,
      kind: "think",
      task,
      material
    });
    await this.healSubmission(meta);
    return this.requestResult(meta);
  }

  async refineHarness(body: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    const requestId = requireString(body.requestId, "requestId", {
      min: 1,
      max: 120
    });
    const instructions =
      body.instructions === undefined
        ? "Review recent turns and make only a small evidence-backed harness improvement."
        : requireString(body.instructions, "instructions", {
            min: 1,
            max: 32_000
          });
    const task = `Explicit continual-harness refinement request.\n\n${instructions}`;
    const inputId = await stableId("request", requestId);
    const meta = this.store.putInput({
      id: inputId,
      scope: "root",
      requestId,
      kind: "refine",
      task,
      material: ""
    });
    await this.healSubmission(meta);
    return this.requestResult(meta);
  }

  async requestStatus(rawRequestId: unknown): Promise<Record<string, unknown>> {
    const requestId = requireString(rawRequestId, "requestId", {
      min: 1,
      max: 120
    });
    const meta = this.store.inputForRequest(requestId);
    if (!meta) throw new Error(`request ${requestId} was not found`);
    return this.requestResult(meta);
  }

  private async requestResult(
    meta: InputMeta
  ): Promise<Record<string, unknown>> {
    const output = this.validatedOutput(meta.id);
    if (output) {
      return {
        requestId: meta.requestId,
        kind: meta.kind,
        status: "completed",
        inputId: meta.id,
        answer: output.answer,
        executionIds: [output.executionId],
        recursiveCalls: this.store.rlmCalls(meta.id),
        ...(meta.kind === "refine"
          ? { harness: harnessSummary(this.store.harness()) }
          : {})
      };
    }
    let submission = await this.inspectSubmission(meta.id);
    if (!submission) {
      await this.healSubmission(meta);
      submission = await this.inspectSubmission(meta.id);
    }
    if (!submission || submission.status === "pending") {
      return {
        requestId: meta.requestId,
        kind: meta.kind,
        status: "admitted",
        inputId: meta.id
      };
    }
    if (submission.status === "running") {
      return {
        requestId: meta.requestId,
        kind: meta.kind,
        status: "running",
        inputId: meta.id
      };
    }
    return {
      requestId: meta.requestId,
      kind: meta.kind,
      status: "error",
      inputId: meta.id,
      error: truncateText(
        submission.error ??
          (submission.status === "completed"
            ? "turn completed without a valid kernel.finish"
            : `turn ended with ${submission.status}`),
        MAX_CONTEXT_OUTPUT_CHARS
      )
    };
  }

  async history(limit = 20): Promise<Record<string, unknown>> {
    return {
      messages: this.store.history("root", boundedInteger(limit, 20, 1, 50))
    };
  }
}
