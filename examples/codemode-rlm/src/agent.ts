import {
  Think,
  type ToolCallContext,
  type ToolCallDecision,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type {
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  RunAgentToolResult
} from "agents";
import type { UIMessage } from "ai";
import {
  type CodemodeConnector,
  type CodemodeRuntimeHandle,
  type ProxyToolInput,
  type ProxyToolOutput,
  type Snippet
} from "@cloudflare/codemode";
import {
  ContextConnector,
  HarnessConnector,
  KernelConnector,
  RlmConnector,
  type RlmFollowupInput,
  type RlmHost,
  type RlmQueryInput
} from "./connectors";
import {
  MAX_CONTEXT_OUTPUT_CHARS,
  MAX_INPUT_CHARS,
  boundedInteger,
  isRecord,
  requireString,
  slug,
  stableId,
  truncateText,
  truncateUnknown
} from "./core";
import {
  buildSystemPrompt,
  buildTurnPrompt,
  harnessSummaryForResponse,
  type RunMode
} from "./prompts";
import {
  ThinkStore,
  type ChildRecord,
  type InputMeta,
  type RlmOperationClaim,
  type RlmOperationKind,
  type RootRequestRecord
} from "./store";

type RuntimeConfig = {
  model: string;
  maxSteps: number;
  maxDepth: number;
  maxRlmCalls: number;
  maxParallel: number;
  timeoutMs: number;
};

type TurnBinding = {
  meta: InputMeta;
  mode: RunMode;
};

type RlmJob = {
  inputId: string;
  prompt: string;
  material: string;
};

type RlmChildOutput = {
  answer: string;
  inputId: string;
  executionIds: string[];
};

type RlmTurnStatus = {
  status: "missing" | "admitted" | "running" | "completed" | "error";
  inputId: string;
  answer?: string;
  executionIds?: string[];
  error?: string;
};

type ChildView = Omit<ChildRecord, "answer"> & { answer?: string };

const TURN_METADATA_KEY = "codemodeRlm";
const MAX_PROMOTED_SNIPPETS = 20;
const MAX_SNIPPET_SCHEMA_CHARS = 64_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicChild(child: ChildRecord): ChildView {
  return {
    ...child,
    answer:
      child.answer === undefined
        ? undefined
        : truncateText(child.answer, MAX_CONTEXT_OUTPUT_CHARS),
    error:
      child.error === undefined
        ? undefined
        : truncateText(child.error, MAX_CONTEXT_OUTPUT_CHARS)
  };
}

function snippetView(snippet: Snippet): Record<string, unknown> {
  return {
    name: snippet.name,
    description: snippet.description,
    savedAt: snippet.savedAt,
    connectors: snippet.connectors ?? [],
    codeChars: snippet.code.length,
    hasInputSchema: snippet.inputSchema !== undefined
  };
}

function boundedSnippetSchema(value: unknown): unknown {
  if (value === undefined) return undefined;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `inputSchema must be JSON-serializable: ${errorMessage(error)}`
    );
  }
  if (encoded === undefined) {
    throw new Error("inputSchema must be JSON-serializable");
  }
  if (encoded.length > MAX_SNIPPET_SCHEMA_CHARS) {
    throw new Error(
      `inputSchema may contain at most ${MAX_SNIPPET_SCHEMA_CHARS} serialized characters`
    );
  }
  return value;
}

function configFromEnv(env: Env): RuntimeConfig {
  return {
    model: env.MODEL || "@cf/moonshotai/kimi-k2.7-code",
    maxSteps: boundedInteger(env.MAX_STEPS, 12, 2, 40),
    maxDepth: boundedInteger(env.MAX_RLM_DEPTH, 1, 0, 1),
    maxRlmCalls: boundedInteger(env.MAX_RLM_CALLS, 8, 0, 64),
    maxParallel: boundedInteger(env.MAX_RLM_PARALLEL, 4, 1, 16),
    timeoutMs: boundedInteger(env.TURN_TIMEOUT_MS, 180_000, 10_000, 900_000)
  };
}

function parseRlmJob(value: unknown): RlmJob {
  if (!isRecord(value)) throw new Error("RLM child input must be an object");
  return {
    inputId: requireString(value.inputId, "inputId", {
      min: 1,
      max: 120
    }),
    prompt: requireString(value.prompt, "prompt", {
      min: 1,
      max: 32_000
    }),
    material: requireString(value.material ?? "", "material", {
      max: 250_000
    })
  };
}

function turnMessage(
  meta: InputMeta,
  taskPreview: string,
  mode: RunMode
): UIMessage {
  return {
    id: `rlm-input-${meta.id}`,
    role: "user",
    metadata: {
      [TURN_METADATA_KEY]: { inputId: meta.id, mode }
    },
    parts: [{ type: "text", text: buildTurnPrompt(meta, taskPreview, mode) }]
  };
}

function boundedToolOutput(
  output: ProxyToolOutput,
  answer: string | undefined
): unknown {
  const callCount = output.calls?.length ?? 0;
  const logCount = "logs" in output ? (output.logs?.length ?? 0) : 0;
  const summary = `Code Mode audit retained ${callCount} connector calls and ${logCount} console log entries; inspect them through context.executions.`;
  const completion = {
    finished: answer !== undefined,
    answerChars: answer?.length ?? 0
  };

  if (output.status === "completed") {
    return {
      status: "completed",
      executionId: output.executionId,
      result: truncateUnknown(output.result, MAX_CONTEXT_OUTPUT_CHARS),
      logs: [summary],
      rlm: completion
    };
  }
  if (output.status === "paused") {
    return {
      status: "paused",
      executionId: output.executionId,
      pending: output.pending.map((action) => ({
        executionId: action.executionId,
        seq: action.seq,
        connector: action.connector,
        method: action.method,
        args: "[redacted from model-facing envelope]"
      })),
      rlm: completion
    };
  }
  return {
    status: "error",
    executionId: output.executionId,
    error: truncateText(output.error, MAX_CONTEXT_OUTPUT_CHARS),
    logs: [summary],
    rlm: completion
  };
}

type RuntimeTool = ReturnType<CodemodeRuntimeHandle["tool"]>;

function boundedCodemodeTool(
  rawTool: RuntimeTool,
  onOutput: (
    input: ProxyToolInput,
    output: ProxyToolOutput
  ) => string | undefined
): RuntimeTool {
  return {
    ...rawTool,
    execute: async (input, options) => {
      const output = await rawTool.execute(input, options);
      const answer = onOutput(input, output);
      return boundedToolOutput(output, answer) as ProxyToolOutput;
    }
  };
}

abstract class RlmBaseAgent extends Think<Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools: false = false;
  override chatRecovery = true;

  protected readonly rlmStore: ThinkStore;
  protected readonly rlmConfig: RuntimeConfig;

  protected get rlmDepth(): number {
    return 1;
  }

  protected get canDelegate(): boolean {
    return false;
  }

  protected get isRoot(): boolean {
    return false;
  }

  protected get modelTimeoutMs(): number {
    return this.isRoot
      ? this.rlmConfig.timeoutMs
      : Math.max(5_000, Math.floor(this.rlmConfig.timeoutMs * 0.55));
  }

  protected get executorTimeoutMs(): number {
    return this.isRoot
      ? Math.max(
          2_500,
          Math.min(
            this.rlmConfig.timeoutMs - 5_000,
            Math.floor(this.rlmConfig.timeoutMs * 0.7)
          )
        )
      : Math.max(2_500, Math.floor(this.rlmConfig.timeoutMs * 0.35));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rlmStore = new ThinkStore(ctx.storage);
    this.rlmConfig = configFromEnv(env);
    this.maxConcurrentAgentTools = this.rlmConfig.maxParallel;
  }

  override getModel(): string {
    return this.rlmConfig.model;
  }

  protected createRlmHost(_turn: TurnBinding): RlmHost | undefined {
    return undefined;
  }

  protected persistInput(job: RlmJob): InputMeta {
    return this.rlmStore.addInputWithId(
      "root",
      job.inputId,
      job.prompt,
      job.material
    );
  }

  protected validatedOutput(inputId: string): RlmChildOutput | undefined {
    const answer = this.rlmStore.answerRecord(inputId);
    if (!answer) return undefined;
    if (
      this.rlmStore.executionStatus(answer.executionId) !== "completed" ||
      !this.rlmStore.executionBelongs(answer.executionId, "root", inputId)
    ) {
      return undefined;
    }
    const output = {
      answer: answer.content,
      inputId,
      executionIds: this.rlmStore.executionIds("root", inputId)
    };
    this.rlmStore.recordTurnMessage(
      "root",
      inputId,
      "assistant",
      output.answer,
      { executionIds: output.executionIds }
    );
    return output;
  }

  protected discardInvalidAnswer(inputId: string): void {
    const answer = this.rlmStore.answerRecord(inputId);
    if (!answer || this.validatedOutput(inputId)) return;
    this.rlmStore.clearAnswer(inputId, answer.executionId);
    this.rlmStore.addMessage(
      "root",
      "protocol_error",
      `Discarded kernel.finish from Code Mode execution ${answer.executionId} because it was not completed and bound to this input.`,
      { inputId, executionId: answer.executionId }
    );
  }

  protected currentTurn(): TurnBinding {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.role !== "user") continue;
      const metadata = isRecord(message.metadata) ? message.metadata : {};
      const turn = metadata[TURN_METADATA_KEY];
      if (isRecord(turn) && typeof turn.inputId === "string") {
        const mode: RunMode = turn.mode === "refine" ? "refine" : "think";
        return { meta: this.rlmStore.inputMeta(turn.inputId), mode };
      }

      const text = message.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("");
      const inputId = /(?:^|\n)input_id: ([^\n]+)/.exec(text)?.[1];
      if (inputId) {
        const mode: RunMode = /(?:^|\n)mode: refine(?:\n|$)/.test(text)
          ? "refine"
          : "think";
        return { meta: this.rlmStore.inputMeta(inputId), mode };
      }
    }
    throw new Error(
      "RLM turn metadata is missing; submit work through the authenticated session API"
    );
  }

  protected runtimeFor(turn: TurnBinding): {
    runtime: CodemodeRuntimeHandle;
    tool: RuntimeTool;
  } {
    let runtime: CodemodeRuntimeHandle | undefined;
    const connectors: CodemodeConnector[] = [
      new ContextConnector(
        this.ctx,
        this.env,
        this.rlmStore,
        "root",
        turn.meta.id,
        turn.mode,
        async (limit) => this.rlmStore.executionAudit("root", limit)
      ),
      new KernelConnector(
        this.ctx,
        this.env,
        this.rlmStore,
        "root",
        turn.meta.id,
        turn.mode
      )
    ];
    const host = this.createRlmHost(turn);
    if (host) {
      connectors.push(
        new RlmConnector(
          this.ctx,
          this.env,
          this.rlmStore,
          "root",
          turn.meta.id,
          turn.mode,
          host,
          this.rlmDepth,
          this.rlmConfig.maxDepth
        )
      );
    }
    connectors.push(
      new HarnessConnector(
        this.ctx,
        this.env,
        this.rlmStore,
        "root",
        turn.meta.id,
        turn.mode,
        turn.mode === "refine" && this.isRoot,
        async () =>
          new Set((await runtime!.snippets()).map((snippet) => snippet.name))
      )
    );

    const built = createExecuteRuntime({
      ctx: this.ctx,
      loader: this.env.LOADER,
      connectors,
      name: "think",
      timeout: this.executorTimeoutMs,
      globalOutbound: null,
      description:
        "The only model-facing tool. Run JavaScript over context, kernel, RLM, and harness connectors."
    });
    runtime = built.runtime;
    this.codemode = runtime;

    const tool = boundedCodemodeTool(
      built.tool as RuntimeTool,
      (input, output) => {
        this.rlmStore.recordExecution({
          executionId: output.executionId,
          scope: "root",
          inputId: turn.meta.id,
          runMode: turn.mode,
          status: output.status,
          code: input.code,
          result:
            output.status === "completed"
              ? truncateUnknown(output.result, 4_000)
              : output.status === "paused"
                ? {
                    pending: output.pending.map((action) => ({
                      seq: action.seq,
                      connector: action.connector,
                      method: action.method
                    }))
                  }
                : null,
          error: output.status === "error" ? output.error : undefined
        });
        if (output.status !== "completed") {
          const answer = this.rlmStore.answerRecord(turn.meta.id);
          if (answer?.executionId === output.executionId) {
            this.rlmStore.clearAnswer(turn.meta.id, output.executionId);
          }
        }
        return this.validatedOutput(turn.meta.id)?.answer;
      }
    );
    return { runtime, tool };
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    const turn = this.currentTurn();
    this.rlmStore.activateInput(turn.meta.id, "root");
    this.rlmStore.recordTurnMessage(
      "root",
      turn.meta.id,
      "user",
      this.rlmStore.inputSlice(
        turn.meta.id,
        "task",
        0,
        MAX_CONTEXT_OUTPUT_CHARS
      ).content,
      {
        mode: turn.mode,
        taskChars: turn.meta.taskChars,
        materialChars: turn.meta.materialChars
      }
    );
    this.discardInvalidAnswer(turn.meta.id);
    const { tool } = this.runtimeFor(turn);
    const finished = this.validatedOutput(turn.meta.id) !== undefined;
    const taskPreview = this.rlmStore.inputSlice(
      turn.meta.id,
      "task",
      0,
      1_200
    ).content;
    return {
      instructions: buildSystemPrompt({
        mode: turn.mode,
        scope: "root",
        depth: this.rlmDepth,
        maxDepth: this.rlmConfig.maxDepth,
        maxRlmCalls: this.rlmConfig.maxRlmCalls,
        canDelegate: this.canDelegate,
        harnessOverview: this.rlmStore.harnessOverview()
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
      tools: { codemode: tool },
      activeTools: finished ? [] : ["codemode"],
      toolChoice: finished ? "none" : { type: "tool", toolName: "codemode" },
      maxSteps: this.rlmConfig.maxSteps,
      stopWhen: () => this.validatedOutput(turn.meta.id) !== undefined,
      maxRetries: 2,
      timeout: { totalMs: this.modelTimeoutMs },
      chatStreamStallTimeoutMs: 0
    };
  }

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | undefined {
    if (ctx.toolName === "codemode") return undefined;
    return {
      action: "block",
      reason: "This RLM exposes only the codemode tool to the model."
    };
  }

  protected inspectionRuntime(): CodemodeRuntimeHandle {
    const built = createExecuteRuntime({
      ctx: this.ctx,
      loader: this.env.LOADER,
      connectors: [
        new KernelConnector(
          this.ctx,
          this.env,
          this.rlmStore,
          "root",
          "inspection-only",
          "think"
        )
      ],
      name: "think",
      timeout: this.executorTimeoutMs,
      globalOutbound: null
    });
    this.codemode = built.runtime;
    return built.runtime;
  }
}

export class RlmChildAgent extends RlmBaseAgent {
  private persistChildTurn(job: RlmJob): InputMeta {
    return this.persistInput(job);
  }

  protected override formatAgentToolInput(input: unknown): UIMessage {
    const job = parseRlmJob(input);
    const meta = this.persistChildTurn(job);
    return turnMessage(meta, truncateText(job.prompt, 1_200), "think");
  }

  protected override getAgentToolOutput(_runId: string): unknown {
    const turn = this.currentTurn();
    return this.validatedOutput(turn.meta.id);
  }

  protected override getAgentToolSummary(
    _runId: string,
    output: unknown
  ): string {
    if (!isRecord(output) || typeof output.answer !== "string") return "";
    return truncateText(output.answer, 2_000);
  }

  async submitRlmTurn(input: RlmJob): Promise<unknown> {
    const job = parseRlmJob(input);
    const meta = this.persistChildTurn(job);
    const taskPreview = this.rlmStore.inputSlice(
      meta.id,
      "task",
      0,
      1_200
    ).content;
    return this.submitMessages([turnMessage(meta, taskPreview, "think")], {
      submissionId: meta.id,
      idempotencyKey: meta.id,
      metadata: { inputId: meta.id, kind: "codemode-rlm" },
      channel: "web"
    });
  }

  async rlmTurnStatus(inputId: string): Promise<RlmTurnStatus> {
    const id = requireString(inputId, "inputId", { min: 1, max: 120 });
    const output = this.validatedOutput(id);
    if (output) {
      return { status: "completed", ...output };
    }
    const submission = await this.inspectSubmission(id);
    if (!submission) {
      return { status: "missing", inputId: id };
    }
    if (submission.status === "pending") {
      return { status: "admitted", inputId: id };
    }
    if (submission.status === "running") {
      return { status: "running", inputId: id };
    }
    if (submission.status === "completed") {
      const completed = this.validatedOutput(id);
      if (completed) {
        return { status: "completed", ...completed };
      }
    }
    return {
      status: "error",
      inputId: id,
      error: truncateText(
        submission.error ??
          (submission.status === "completed"
            ? "child completed without kernel.finish"
            : `child submission ended with ${submission.status}`),
        MAX_CONTEXT_OUTPUT_CHARS
      )
    };
  }
}

export class RlmThinkAgent extends RlmBaseAgent {
  protected override get isRoot(): boolean {
    return true;
  }

  protected override get rlmDepth(): number {
    return 0;
  }

  protected override get canDelegate(): boolean {
    return this.rlmConfig.maxDepth > 0 && this.rlmConfig.maxRlmCalls > 0;
  }

  protected override createRlmHost(turn: TurnBinding): RlmHost {
    return {
      query: (input, executionId) => this.queryChild(turn, input, executionId),
      spawn: (input, executionId) => this.spawnChild(turn, input, executionId),
      followup: (input, executionId) =>
        this.followupChild(turn, input, executionId),
      status: (childId) => this.refreshChild(childId),
      list: (limit) =>
        this.rlmStore
          .children("root", limit)
          .map((child) => ({ ...child, answer: undefined })),
      answerInfo: async (childId) => {
        const child = await this.refreshChild(childId);
        return child ? this.rlmStore.childAnswerInfo(childId) : undefined;
      },
      answerSlice: async (childId, start, length) => {
        const child = await this.refreshChild(childId);
        return child
          ? this.rlmStore.childAnswerSlice(childId, start, length)
          : undefined;
      }
    };
  }

  private claimDelegation(
    turn: TurnBinding,
    options: {
      id: string;
      kind: RlmOperationKind;
      key: string;
      argsHash: string;
      childId: string;
      turnInputId: string;
      sourceExecutionId: string;
    }
  ): RlmOperationClaim {
    if (!this.canDelegate) {
      throw new Error("recursive depth is disabled");
    }
    return this.rlmStore.claimRlmOperation({
      ...options,
      rootInputId: turn.meta.id,
      maximum: this.rlmConfig.maxRlmCalls
    });
  }

  private async createChildRecord(
    childId: string,
    inputId: string,
    input: RlmQueryInput,
    mode: "query" | "persistent"
  ): Promise<ChildRecord> {
    const existing = this.rlmStore.child(childId);
    if (existing) {
      if (existing.mode !== mode) {
        throw new Error(`RLM key ${input.key} changed operation kind`);
      }
      if (existing.inputId !== inputId && mode === "query") {
        throw new Error(
          `RLM key ${input.key} was reused with different input data`
        );
      }
      return existing;
    }
    const scope = `child:${childId}`;
    this.rlmStore.addInputWithId(scope, inputId, input.prompt, input.material);
    this.rlmStore.addMessage(
      scope,
      "user",
      truncateText(input.prompt, 50_000),
      {
        inputId,
        parentScope: "root",
        mode
      }
    );
    return this.rlmStore.createChild({
      id: childId,
      parentScope: "root",
      scope,
      depth: 1,
      name: this.rlmStore.uniqueChildName(
        "root",
        slug(input.name || input.prompt.slice(0, 80), mode)
      ),
      mode,
      prompt: input.prompt,
      inputId
    });
  }

  private async queryChild(
    turn: TurnBinding,
    input: RlmQueryInput,
    executionId: string
  ): Promise<ChildRecord> {
    const operationId = await stableId("op", turn.meta.id, "query", input.key);
    const childId = await stableId("query", operationId);
    const argsHash = await stableId(
      "args",
      "query",
      input.key,
      input.prompt,
      input.material,
      input.name ?? ""
    );
    const inputId = await stableId("input", operationId, argsHash);
    const claim = this.claimDelegation(turn, {
      id: operationId,
      kind: "query",
      key: input.key,
      argsHash,
      childId,
      turnInputId: inputId,
      sourceExecutionId: executionId
    });
    if (claim.operation.status === "error") {
      throw new Error(
        claim.operation.error ?? `RLM query ${input.key} previously failed`
      );
    }
    const child = await this.createChildRecord(
      childId,
      inputId,
      input,
      "query"
    );
    if (child.status === "completed") {
      this.rlmStore.markRlmOperation(operationId, "completed");
      return publicChild(child) as ChildRecord;
    }

    this.rlmStore.setChildStatus(childId, "running", {
      expectedInputId: inputId,
      expectedStatus: child.status,
      preserveResult: true
    });
    this.rlmStore.markRlmOperation(operationId, "admitted");
    const result = await this.runAgentTool<RlmJob, RlmChildOutput>(
      RlmChildAgent,
      {
        runId: childId,
        input: { inputId, prompt: input.prompt, material: input.material },
        inputPreview: {
          name: child.name,
          prompt: truncateText(input.prompt, 300),
          materialChars: input.material.length
        }
      }
    );
    return this.finishQuery(operationId, childId, inputId, result);
  }

  private finishQuery(
    operationId: string,
    childId: string,
    inputId: string,
    result: RunAgentToolResult<RlmChildOutput>
  ): ChildRecord {
    if (result.status === "completed" && result.output?.answer) {
      this.rlmStore.completeChildTurn({
        childId,
        inputId,
        answer: result.output.answer,
        executionIds: result.output.executionIds
      });
      this.rlmStore.markRlmOperation(operationId, "completed");
      return publicChild(this.rlmStore.child(childId)!) as ChildRecord;
    }
    const message = truncateText(
      result.error ??
        (result.status === "completed"
          ? "child completed without kernel.finish"
          : `child ended with ${result.status}`),
      MAX_CONTEXT_OUTPUT_CHARS
    );
    this.rlmStore.failChildTurn({ childId, inputId, error: message });
    this.rlmStore.markRlmOperation(operationId, "error", message);
    throw new Error(message);
  }

  private async spawnChild(
    turn: TurnBinding,
    input: RlmQueryInput,
    executionId: string
  ): Promise<ChildRecord> {
    const operationId = await stableId("op", turn.meta.id, "spawn", input.key);
    const childId = await stableId("child", operationId);
    const argsHash = await stableId(
      "args",
      "spawn",
      input.key,
      input.prompt,
      input.material,
      input.name ?? ""
    );
    const inputId = await stableId("turn", operationId, argsHash);
    const claim = this.claimDelegation(turn, {
      id: operationId,
      kind: "spawn",
      key: input.key,
      argsHash,
      childId,
      turnInputId: inputId,
      sourceExecutionId: executionId
    });
    if (claim.operation.status === "error") {
      throw new Error(
        claim.operation.error ?? `RLM spawn ${input.key} previously failed`
      );
    }
    const child = await this.createChildRecord(
      childId,
      inputId,
      input,
      "persistent"
    );
    if (child.inputId !== inputId) {
      return publicChild(child) as ChildRecord;
    }
    return this.submitPersistentTurn(operationId, child, {
      inputId,
      prompt: input.prompt,
      material: input.material
    });
  }

  private async followupChild(
    turn: TurnBinding,
    input: RlmFollowupInput,
    executionId: string
  ): Promise<ChildRecord> {
    const child = this.rlmStore.child(input.childId);
    if (!child || child.parentScope !== "root") {
      throw new Error(`child ${input.childId} was not found`);
    }
    if (child.mode !== "persistent") {
      throw new Error("follow-up is available only for persistent children");
    }
    const operationId = await stableId(
      "op",
      turn.meta.id,
      "followup",
      child.id,
      input.key
    );
    const argsHash = await stableId(
      "args",
      "followup",
      input.key,
      child.id,
      input.prompt,
      input.material
    );
    const inputId = await stableId("turn", operationId, argsHash);
    const priorClaim = this.rlmStore.rlmOperation(operationId);

    const job = {
      inputId,
      prompt: input.prompt,
      material: input.material
    };
    if (priorClaim && child.inputId === inputId) {
      const claim = this.claimDelegation(turn, {
        id: operationId,
        kind: "followup",
        key: input.key,
        argsHash,
        childId: child.id,
        turnInputId: inputId,
        sourceExecutionId: executionId
      });
      if (claim.operation.status === "error") {
        throw new Error(
          claim.operation.error ??
            `RLM follow-up ${input.key} previously failed`
        );
      }
      return this.submitPersistentTurn(operationId, child, job);
    }

    let latest = (await this.refreshChild(child.id))!;
    if (
      !priorClaim &&
      (latest.status === "admitted" || latest.status === "running")
    ) {
      throw new Error(`child ${child.id} is still ${latest.status}`);
    }
    const claim = this.claimDelegation(turn, {
      id: operationId,
      kind: "followup",
      key: input.key,
      argsHash,
      childId: child.id,
      turnInputId: inputId,
      sourceExecutionId: executionId
    });
    if (claim.operation.status === "error") {
      throw new Error(
        claim.operation.error ?? `RLM follow-up ${input.key} previously failed`
      );
    }
    latest = this.rlmStore.child(child.id)!;
    if (latest.inputId === inputId) {
      return this.submitPersistentTurn(operationId, latest, job);
    }
    if (claim.operation.status !== "claimed") {
      // This operation was already admitted and the retained child has since
      // advanced. Return its current projection without rolling its head back.
      return publicChild(latest) as ChildRecord;
    }
    const currentOperation = this.rlmStore.rlmOperationForTurn(latest.inputId);
    if (
      currentOperation &&
      currentOperation.sequence > claim.operation.sequence
    ) {
      const message = `follow-up ${input.key} was superseded by a newer child turn`;
      this.rlmStore.markRlmOperation(operationId, "error", message);
      throw new Error(message);
    }
    if (latest.status === "admitted" || latest.status === "running") {
      throw new Error(`child ${child.id} is still ${latest.status}`);
    }
    this.rlmStore.addInputWithId(
      child.scope,
      inputId,
      input.prompt,
      input.material
    );
    this.rlmStore.addMessage(
      child.scope,
      "user",
      truncateText(input.prompt, 50_000),
      { inputId, followup: true, parentScope: "root" }
    );
    const admitted = this.rlmStore.setChildStatus(child.id, "admitted", {
      inputId,
      prompt: input.prompt,
      expectedInputId: latest.inputId,
      expectedStatus: latest.status
    });
    if (!admitted) {
      const message = `follow-up ${input.key} lost a concurrent child-head race`;
      this.rlmStore.markRlmOperation(operationId, "error", message);
      throw new Error(message);
    }
    return this.submitPersistentTurn(
      operationId,
      this.rlmStore.child(child.id)!,
      job
    );
  }

  private async submitPersistentTurn(
    operationId: string,
    child: ChildRecord,
    job: RlmJob
  ): Promise<ChildRecord> {
    if (child.inputId !== job.inputId) {
      return publicChild(child) as ChildRecord;
    }
    if (child.status === "completed") {
      this.rlmStore.markRlmOperation(operationId, "completed");
      return publicChild(child) as ChildRecord;
    }
    if (child.status === "error" || child.status === "interrupted") {
      const message = child.error ?? `child ended with ${child.status}`;
      this.rlmStore.markRlmOperation(operationId, "error", message);
      throw new Error(message);
    }
    this.rlmStore.markRlmOperation(operationId, "admitted");
    const agent = await this.subAgent(RlmChildAgent, child.id);
    await agent.submitRlmTurn(job);
    return publicChild(this.rlmStore.child(child.id)!) as ChildRecord;
  }

  private async refreshChild(
    childId: string
  ): Promise<ChildRecord | undefined> {
    const child = this.rlmStore.child(childId);
    if (!child || child.parentScope !== "root") return undefined;
    if (
      child.mode === "query" ||
      child.status === "completed" ||
      child.status === "error" ||
      child.status === "interrupted"
    ) {
      if (child.status === "completed") {
        this.rlmStore.markRlmOperationForTurn(child.inputId, "completed");
      } else if (child.status === "error" || child.status === "interrupted") {
        this.rlmStore.markRlmOperationForTurn(
          child.inputId,
          "error",
          child.error
        );
      }
      return publicChild(child) as ChildRecord;
    }
    const agent = await this.subAgent(RlmChildAgent, child.id);
    const status = await agent.rlmTurnStatus(child.inputId);
    if (status.status === "missing") {
      const current = this.rlmStore.child(child.id);
      if (!current || current.inputId !== child.inputId) {
        return current ? (publicChild(current) as ChildRecord) : undefined;
      }
      const payload = this.rlmStore.inputPayload(child.inputId);
      try {
        await agent.submitRlmTurn({ inputId: child.inputId, ...payload });
      } catch (error) {
        this.rlmStore.setChildStatus(child.id, "admitted", {
          expectedInputId: child.inputId,
          expectedStatus: child.status,
          preserveResult: true
        });
        throw error;
      }
      this.rlmStore.setChildStatus(child.id, "admitted", {
        expectedInputId: child.inputId,
        expectedStatus: child.status,
        preserveResult: true
      });
    } else if (status.status === "completed" && status.answer) {
      this.rlmStore.completeChildTurn({
        childId: child.id,
        inputId: child.inputId,
        answer: status.answer,
        executionIds: status.executionIds ?? []
      });
      this.rlmStore.markRlmOperationForTurn(child.inputId, "completed");
    } else if (status.status === "error") {
      const message = truncateText(
        status.error ?? "child submission failed",
        MAX_CONTEXT_OUTPUT_CHARS
      );
      this.rlmStore.failChildTurn({
        childId: child.id,
        inputId: child.inputId,
        error: message
      });
      this.rlmStore.markRlmOperationForTurn(child.inputId, "error", message);
    } else {
      this.rlmStore.setChildStatus(
        child.id,
        status.status === "running" ? "running" : "admitted",
        {
          expectedInputId: child.inputId,
          expectedStatus: child.status,
          preserveResult: true
        }
      );
    }
    return publicChild(this.rlmStore.child(child.id)!) as ChildRecord;
  }

  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    const child = this.rlmStore.child(run.runId);
    if (!child || child.mode !== "query") return;
    if (result.status === "completed") {
      try {
        const agent = await this.subAgent(RlmChildAgent, run.runId);
        const inspection = await agent.inspectAgentToolRun(run.runId);
        const output = inspection?.output as RlmChildOutput | undefined;
        if (output?.answer) {
          this.rlmStore.completeChildTurn({
            childId: child.id,
            inputId: child.inputId,
            answer: output.answer,
            executionIds: output.executionIds
          });
          this.rlmStore.markRlmOperationForTurn(child.inputId, "completed");
          return;
        }
      } catch {
        // The awaited run path below records the same terminal result.
      }
    }
    if (result.status !== "completed") {
      const message = truncateText(
        result.error ?? `child ended with ${result.status}`,
        MAX_CONTEXT_OUTPUT_CHARS
      );
      this.rlmStore.failChildTurn({
        childId: child.id,
        inputId: child.inputId,
        error: message
      });
      this.rlmStore.markRlmOperationForTurn(child.inputId, "error", message);
    }
  }

  private async submitRootRequest(request: RootRequestRecord): Promise<void> {
    const meta = this.rlmStore.inputMeta(request.inputId);
    const payload = this.rlmStore.inputPayload(request.inputId);
    const mode: RunMode = request.kind === "refine" ? "refine" : "think";
    await this.submitMessages(
      [turnMessage(meta, truncateText(payload.prompt, 1_200), mode)],
      {
        submissionId: request.inputId,
        idempotencyKey: request.inputId,
        metadata: {
          inputId: request.inputId,
          requestId: request.requestId,
          kind:
            request.kind === "refine"
              ? "codemode-rlm-refine"
              : "codemode-rlm-root"
        },
        channel: "web"
      }
    );
  }

  private async healRootSubmission(
    request: RootRequestRecord
  ): Promise<boolean> {
    try {
      await this.submitRootRequest(request);
      return true;
    } catch {
      // The submission RPC can fail after its durable write. Preserve the
      // admitted request and let this or a later poll inspect/retry the same
      // stable submission id instead of turning ambiguity into terminal error.
      return false;
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
    const argsHash = await stableId("args", "think", task, material);
    const inputId = await stableId("request", "think", requestId);
    this.rlmStore.addInputWithId("root", inputId, task, material);
    const request = this.rlmStore.claimRootRequest({
      requestId,
      kind: "think",
      argsHash,
      inputId
    });
    await this.healRootSubmission(request);
    return this.rootRequestResult(request);
  }

  async refineHarness(body: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    const requestId = requireString(body.requestId, "requestId", {
      min: 1,
      max: 120
    });
    const instructions =
      body.instructions === undefined
        ? "Review recent trajectories and refine only when concrete evidence justifies a small change."
        : requireString(body.instructions, "instructions", {
            min: 1,
            max: 32_000
          });
    const task = `Explicit continual-harness refinement request.\n\n${instructions}`;
    const argsHash = await stableId("args", "refine", task);
    const inputId = await stableId("request", "refine", requestId);
    this.rlmStore.addInputWithId("root", inputId, task, "");
    const request = this.rlmStore.claimRootRequest({
      requestId,
      kind: "refine",
      argsHash,
      inputId
    });
    await this.healRootSubmission(request);
    return this.rootRequestResult(request);
  }

  async rollbackHarness(body: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    const state = this.rlmStore.rollbackHarness(
      body.targetRevision,
      body.evidence
    );
    this.rlmStore.addMessage(
      "root",
      "harness_rollback",
      `Rolled the harness entry snapshot back to revision ${String(body.targetRevision)}.`,
      { resultingRevision: state.revision, evidence: body.evidence }
    );
    return { harness: harnessSummaryForResponse(state) };
  }

  async requestStatus(rawRequestId: unknown): Promise<Record<string, unknown>> {
    const requestId = requireString(rawRequestId, "requestId", {
      min: 1,
      max: 120
    });
    const request = this.rlmStore.rootRequest(requestId);
    if (!request) throw new Error(`request ${requestId} was not found`);
    return this.rootRequestResult(request);
  }

  private completedRootRequestResult(
    request: RootRequestRecord,
    output: RlmChildOutput
  ): Record<string, unknown> {
    this.rlmStore.recordTurnMessage(
      "root",
      request.inputId,
      "assistant",
      output.answer,
      {
        requestId: request.requestId,
        kind: request.kind,
        executionIds: output.executionIds
      }
    );
    return {
      requestId: request.requestId,
      kind: request.kind,
      status: "completed",
      inputId: request.inputId,
      answer: output.answer,
      executionIds: output.executionIds,
      recursiveCalls: this.rlmStore.rlmCalls(request.inputId),
      ...(request.kind === "think"
        ? { children: this.rlmStore.children("root", 20).map(publicChild) }
        : { harness: harnessSummaryForResponse(this.rlmStore.harness()) })
    };
  }

  private async rootRequestResult(
    request: RootRequestRecord
  ): Promise<Record<string, unknown>> {
    const output = this.validatedOutput(request.inputId);
    if (output) {
      return this.completedRootRequestResult(request, output);
    }

    let submission = await this.inspectSubmission(request.inputId);
    if (!submission) {
      await this.healRootSubmission(request);
      submission = await this.inspectSubmission(request.inputId);
    }
    if (!submission || submission.status === "pending") {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: "admitted",
        inputId: request.inputId
      };
    }
    if (submission.status === "running") {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: "running",
        inputId: request.inputId
      };
    }
    if (submission.status === "completed") {
      const completed = this.validatedOutput(request.inputId);
      if (completed) {
        return this.completedRootRequestResult(request, completed);
      }
    }
    return {
      requestId: request.requestId,
      kind: request.kind,
      status: "error",
      inputId: request.inputId,
      error: truncateText(
        submission.error ??
          (submission.status === "completed"
            ? "turn completed without a valid kernel.finish"
            : `turn ended with ${submission.status}`),
        MAX_CONTEXT_OUTPUT_CHARS
      )
    };
  }

  async sessionSummary(): Promise<Record<string, unknown>> {
    return {
      kind: "codemode-rlm-think-agent",
      model: this.rlmConfig.model,
      orchestration: "Think Session + Agents sub-agents",
      modelFacingTools: ["codemode"],
      limits: {
        maxSteps: this.rlmConfig.maxSteps,
        maxDepth: this.rlmConfig.maxDepth,
        maxRlmCalls: this.rlmConfig.maxRlmCalls,
        maxParallel: this.rlmConfig.maxParallel,
        timeoutMs: this.rlmConfig.timeoutMs
      },
      messages: this.rlmStore.messageCount("root"),
      children: this.rlmStore.children("root", 100).length,
      harness: harnessSummaryForResponse(this.rlmStore.harness())
    };
  }

  async history(limit = 20): Promise<Record<string, unknown>> {
    return {
      messages: this.rlmStore.history("root", {
        limit: boundedInteger(limit, 20, 1, 50)
      })
    };
  }

  async children(limit = 20): Promise<Record<string, unknown>> {
    const records = this.rlmStore.children(
      "root",
      boundedInteger(limit, 20, 1, 100)
    );
    const refreshed = await Promise.all(
      records.map((child) => this.refreshChild(child.id))
    );
    return { children: refreshed.filter(Boolean) };
  }

  async harness(): Promise<Record<string, unknown>> {
    return {
      ...harnessSummaryForResponse(this.rlmStore.harness()),
      overview: this.rlmStore.harnessOverview(),
      revisions: this.rlmStore.harnessRevisions(20)
    };
  }

  async executions(limit = 20): Promise<Record<string, unknown>> {
    return {
      executions: this.rlmStore.executionAudit(
        "root",
        boundedInteger(limit, 20, 1, 50)
      )
    };
  }

  async snippets(): Promise<Record<string, unknown>> {
    const snippets = await this.inspectionRuntime().snippets();
    this.rlmStore.adoptSnippetNames(snippets.map((snippet) => snippet.name));
    return {
      snippets: snippets.map(snippetView),
      reservations: this.rlmStore
        .snippetPromotions()
        .filter((promotion) => promotion.status === "pending")
    };
  }

  async promoteSnippet(body: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    const name = requireString(body.name, "name", { min: 1, max: 100 });
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error(
        "snippet name may contain only letters, digits, underscore, dot, and hyphen"
      );
    }
    const executionId = requireString(body.executionId, "executionId", {
      min: 1,
      max: 120
    });
    if (this.rlmStore.executionStatus(executionId) !== "completed") {
      throw new Error("only a completed execution can be promoted");
    }
    if (this.rlmStore.executionMode(executionId) !== "think") {
      throw new Error("refinement executions cannot be promoted");
    }
    const description =
      body.description === undefined
        ? undefined
        : requireString(body.description, "description", { max: 1_000 });
    const inputSchema = boundedSnippetSchema(body.inputSchema);
    const runtime = this.inspectionRuntime();
    const [existing, executions] = await Promise.all([
      runtime.snippets(),
      runtime.executions()
    ]);
    if (
      !executions.some(
        (execution) =>
          execution.id === executionId && execution.status === "completed"
      )
    ) {
      throw new Error(
        `completed Code Mode execution ${executionId} was not found in the retained runtime audit`
      );
    }
    this.rlmStore.adoptSnippetNames(existing.map((snippet) => snippet.name));
    this.rlmStore.claimSnippetPromotion(
      name,
      executionId,
      MAX_PROMOTED_SNIPPETS
    );
    const snippet = await runtime.saveSnippet(name, {
      executionId,
      description,
      inputSchema
    });
    this.rlmStore.completeSnippetPromotion(name);
    return { snippet: snippetView(snippet) };
  }
}
