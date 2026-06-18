import type {
  WorkflowEvent,
  WorkflowSleepDuration,
  WorkflowStepEvent
} from "cloudflare:workers";
import {
  AgentWorkflow,
  type AgentWorkflowStep,
  type DefaultProgress
} from "agents/workflows";
import type { UIMessage } from "ai";
import { toJSONSchema, type ZodObject, type z } from "zod";
import type {
  SubmitMessagesResult,
  Think,
  ThinkSubmissionStatus
} from "./think";

type ThinkPromptTerminalStatus = Exclude<
  ThinkSubmissionStatus,
  "pending" | "running"
>;

type ThinkPromptEventPayload = {
  submissionId: string;
  status: ThinkPromptTerminalStatus;
  output?: unknown;
  error?: string;
};

const THINK_WORKFLOW_PROMPT_METADATA_KEY = "__thinkWorkflowPrompt";

export type ThinkPromptRetryOptions = {
  /** Total number of attempts (including the first). Default: 1 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 500 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 5000 */
  maxDelayMs?: number;
};

export type ThinkPromptOptions<Schema extends ZodObject> = {
  prompt: string;
  output: Schema;
  timeout?: WorkflowSleepDuration;
  key?: string;
  cancelOnTimeout?: boolean;
  retries?: ThinkPromptRetryOptions;
  /**
   * Maximum number of retries for the underlying model call within each
   * workflow attempt. Forwarded to the AI SDK's `streamText`; transient
   * provider errors (e.g. capacity) are retried inside the agent turn before
   * the workflow-level `retries` kick in.
   */
  modelMaxRetries?: number;
};

export interface ThinkWorkflowStep extends AgentWorkflowStep {
  prompt<Schema extends ZodObject>(
    name: string,
    options: ThinkPromptOptions<Schema>
  ): Promise<z.infer<Schema>>;
}

export class ThinkPromptError extends Error {
  constructor(
    message: string,
    readonly submissionId: string,
    readonly status: ThinkPromptTerminalStatus,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ThinkPromptError";
  }
}

export class ThinkPromptAbortedError extends ThinkPromptError {
  constructor(submissionId: string, message = "Think prompt was aborted") {
    super(message, submissionId, "aborted");
    this.name = "ThinkPromptAbortedError";
  }
}

export class ThinkPromptSkippedError extends ThinkPromptError {
  constructor(submissionId: string, message = "Think prompt was skipped") {
    super(message, submissionId, "skipped");
    this.name = "ThinkPromptSkippedError";
  }
}

export class ThinkPromptTimeoutError extends ThinkPromptError {
  constructor(submissionId: string, cause: unknown) {
    super("Timed out waiting for Think prompt", submissionId, "error", cause);
    this.name = "ThinkPromptTimeoutError";
  }
}

export class ThinkPromptValidationError extends ThinkPromptError {
  constructor(submissionId: string, cause: unknown) {
    super(
      "Think prompt returned invalid structured output",
      submissionId,
      "error",
      cause
    );
    this.name = "ThinkPromptValidationError";
  }
}

export class ThinkWorkflow<
  AgentType extends Think = Think,
  Params = unknown,
  ProgressType = DefaultProgress,
  Env extends Cloudflare.Env = Cloudflare.Env
> extends AgentWorkflow<AgentType, Params, ProgressType, Env> {
  protected extendStep(
    step: AgentWorkflowStep,
    event: WorkflowEvent<Params>
  ): ThinkWorkflowStep {
    const workflowStep = step as ThinkWorkflowStep;
    workflowStep.prompt = async <Schema extends ZodObject>(
      name: string,
      options: ThinkPromptOptions<Schema>
    ): Promise<z.infer<Schema>> => {
      return this._promptStep(name, options, step, event);
    };
    return workflowStep;
  }

  private async _promptStep<Schema extends ZodObject>(
    stepName: string,
    options: ThinkPromptOptions<Schema>,
    step: AgentWorkflowStep,
    _event: WorkflowEvent<Params>
  ): Promise<z.infer<Schema>> {
    const outputSchema = toJSONSchema(options.output);
    const fingerprint = await this._hashString(
      JSON.stringify({
        prompt: options.prompt,
        output: outputSchema
      })
    );

    const maxAttempts = options.retries?.maxAttempts ?? 1;
    const baseDelayMs = options.retries?.baseDelayMs ?? 500;
    const maxDelayMs = options.retries?.maxDelayMs ?? 5000;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptKey =
        attempt === 0 ? options.key : `${options.key ?? ""}:attempt-${attempt}`;
      try {
        return await this._promptStepAttempt(
          stepName,
          options,
          outputSchema,
          fingerprint,
          attempt,
          attemptKey,
          step
        );
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts - 1) {
          throw err;
        }
        const delayMs = await this._promptRetryDelayMs(
          stepName,
          attempt,
          baseDelayMs,
          maxDelayMs
        );
        await step.sleep(`${stepName}:retry-${attempt}`, delayMs);
      }
    }

    throw lastError;
  }

  private async _promptStepAttempt<Schema extends ZodObject>(
    stepName: string,
    options: ThinkPromptOptions<Schema>,
    outputSchema: object,
    fingerprint: string,
    attempt: number,
    attemptKey: string | undefined,
    step: AgentWorkflowStep
  ): Promise<z.infer<Schema>> {
    const eventType = await this._eventTypeForPrompt(stepName, attemptKey);
    const idempotencyKey = await this._idempotencyKeyForPrompt(
      stepName,
      attemptKey
    );

    // Preserve the original step names for the first attempt so in-flight
    // workflows (which match completed steps by name during replay) continue
    // to resume correctly after upgrading. Only retries get suffixed names.
    const submitStepName =
      attempt === 0 ? `${stepName}:submit` : `${stepName}:submit-${attempt}`;
    const waitStepName =
      attempt === 0 ? `${stepName}:wait` : `${stepName}:wait-${attempt}`;

    const submission = (await step.do(submitStepName, async () => {
      const submissionResult = (await this.agent.submitMessages(
        [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: options.prompt }]
          } satisfies UIMessage
        ],
        {
          idempotencyKey,
          maxRetries: options.modelMaxRetries,
          metadata: {
            [THINK_WORKFLOW_PROMPT_METADATA_KEY]: {
              workflow: {
                name: this.workflowName,
                id: this.workflowId,
                stepName,
                eventType
              },
              output: {
                schema: outputSchema
              },
              fingerprint
            }
          }
        }
      )) as SubmitMessagesResult;

      try {
        return { submissionId: submissionResult.submissionId };
      } finally {
        disposeIfPresent(submissionResult);
      }
    })) as Pick<SubmitMessagesResult, "submissionId">;

    const event = await this._waitForPromptEvent(
      step,
      waitStepName,
      eventType,
      options.timeout,
      options.cancelOnTimeout,
      submission.submissionId
    );

    try {
      const payload = event.payload;

      if (payload.status !== "completed") {
        throw this._terminalPromptError(payload);
      }

      const parsed = options.output.safeParse(payload.output);
      if (!parsed.success) {
        throw new ThinkPromptValidationError(
          payload.submissionId,
          parsed.error
        );
      }
      return parsed.data;
    } finally {
      disposeIfPresent(event);
    }
  }

  private async _waitForPromptEvent(
    step: AgentWorkflowStep,
    stepName: string,
    eventType: string,
    timeout: WorkflowSleepDuration | undefined,
    cancelOnTimeout: boolean | undefined,
    submissionId: string
  ): Promise<WorkflowStepEvent<ThinkPromptEventPayload>> {
    try {
      return (await step.waitForEvent(stepName, {
        type: eventType,
        timeout
      })) as WorkflowStepEvent<ThinkPromptEventPayload>;
    } catch (error) {
      if (cancelOnTimeout !== false) {
        try {
          await this.agent.cancelSubmission(
            submissionId,
            "Workflow prompt wait timed out"
          );
        } catch {
          // Cancellation is best-effort cleanup; preserve the timeout error.
        }
      }
      throw new ThinkPromptTimeoutError(submissionId, error);
    }
  }

  private _terminalPromptError(
    payload: ThinkPromptEventPayload
  ): ThinkPromptError {
    if (payload.status === "aborted") {
      return new ThinkPromptAbortedError(payload.submissionId, payload.error);
    }
    if (payload.status === "skipped") {
      return new ThinkPromptSkippedError(payload.submissionId, payload.error);
    }
    return new ThinkPromptError(
      payload.error ?? `Think prompt ended with status ${payload.status}`,
      payload.submissionId,
      payload.status
    );
  }

  private async _promptRetryDelayMs(
    stepName: string,
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number
  ): Promise<number> {
    const upperBoundMs = Math.min(2 ** attempt * baseDelayMs, maxDelayMs);
    // Workflows steps must be deterministic, so jitter is derived from a hash
    // of stable inputs instead of Math.random(). Two raw digest bytes give a
    // 16-bit value that spans the full [0, 1) range once divided by 0xffff.
    const jitterSeed = `${this.workflowName}:${this.workflowId}:${stepName}:${attempt}`;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(jitterSeed)
    );
    const digestBytes = new Uint8Array(digest);
    const fraction = ((digestBytes[0] << 8) | digestBytes[1]) / 0xffff;
    return Math.floor(fraction * upperBoundMs);
  }

  private async _idempotencyKeyForPrompt(
    stepName: string,
    key: string | undefined
  ): Promise<string> {
    const base = `think-workflow:${this.workflowName}:${this.workflowId}:${stepName}`;
    if (key === undefined) return base;
    return `${base}:${await this._hashString(key)}`;
  }

  private async _eventTypeForPrompt(
    stepName: string,
    key: string | undefined
  ): Promise<string> {
    return `think-prompt-${await this._hashString(
      `${this.workflowName}:${this.workflowId}:${stepName}:${key ?? ""}`
    )}`;
  }

  private async _hashString(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return base64Url(digest).slice(0, 22);
  }
}

type DisposableResource = {
  [Symbol.dispose](): void;
};

function isDisposableResource(value: unknown): value is DisposableResource {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.dispose in value &&
    typeof value[Symbol.dispose] === "function"
  );
}

function disposeIfPresent(value: unknown): void {
  if (isDisposableResource(value)) {
    value[Symbol.dispose]();
  }
}

function base64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
