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
  ThinkSubmissionInspection,
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

/** Max recovery rounds before falling back to a fresh submission. */
const PROMPT_RECOVERY_MAX_ROUNDS = 5;

export type ThinkPromptRetryOptions = {
  /** Total number of attempts (including the first). Default: 1 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 500 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 5000 */
  maxDelayMs?: number;
  /**
   * Whether a `step.prompt` wait timeout should count as a retryable failure.
   * A timeout often means the task is too complex or the provider is down, so
   * a fresh attempt with the same prompt is likely to time out again. Set to
   * `false` to fail fast on timeout instead of retrying. Default: `true`.
   */
  retryOnTimeout?: boolean;
};

export type ThinkPromptOptions<Schema extends ZodObject> = {
  prompt: string;
  output: Schema;
  timeout?: WorkflowSleepDuration;
  key?: string;
  /**
   * Defaults to true. With retries enabled, this only controls the final
   * timed-out attempt; abandoned attempts are always cancelled before resubmit.
   */
  cancelOnTimeout?: boolean;
  retries?: ThinkPromptRetryOptions;
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
  private static readonly _encoder = new TextEncoder();

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

    const { maxAttempts, baseDelayMs, maxDelayMs, retryOnTimeout } =
      this._validatePromptRetryOptions(options.retries);

    // With retries, recover before cancelling; single-attempt keeps legacy behaviour.
    const waitCancelsOnTimeout =
      maxAttempts > 1 ? false : options.cancelOnTimeout;
    const cancelTimedOutFinalAttempt = options.cancelOnTimeout ?? true;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptKey =
        attempt === 0
          ? options.key
          : options.key === undefined
            ? `attempt-${attempt}`
            : `${options.key}:attempt-${attempt}`;
      // Per-attempt event types prevent stale events from previous attempts.
      const eventType = await this._eventTypeForPrompt(stepName, attemptKey);
      // Filled once submitMessages resolves so failures can recover/cancel it.
      const attemptRef: { submissionId?: string } = {};

      try {
        return await this._promptStepAttempt(
          stepName,
          options,
          outputSchema,
          fingerprint,
          attempt,
          attemptKey,
          step,
          attemptRef,
          eventType,
          waitCancelsOnTimeout
        );
      } catch (err) {
        lastError = err;

        const isTimeout = err instanceof ThinkPromptTimeoutError;
        const isLastAttempt = attempt === maxAttempts - 1;

        // On timeout, give DO recovery a chance before resubmitting.
        if (
          maxAttempts > 1 &&
          isTimeout &&
          retryOnTimeout &&
          attemptRef.submissionId
        ) {
          const recovery = await this._tryRecoverSubmission(
            step,
            stepName,
            attempt,
            eventType,
            options,
            attemptRef.submissionId,
            baseDelayMs,
            maxDelayMs
          );
          if (recovery.recovered) return recovery.value;
        }

        const stopOnTimeout = isTimeout && !retryOnTimeout;
        if (isLastAttempt || stopOnTimeout) {
          // Final failure. Multi-attempt waits don't cancel, so do it here.
          const leaveRunning = isTimeout && !cancelTimedOutFinalAttempt;
          if (maxAttempts > 1 && attemptRef.submissionId && !leaveRunning) {
            const submissionId = attemptRef.submissionId;
            await step.do(`${stepName}:cancel-${attempt}`, async () => {
              await this.agent.cancelSubmission(
                submissionId,
                isTimeout
                  ? "Workflow prompt wait timed out"
                  : "Think workflow prompt failed"
              );
            });
          }
          throw err;
        }

        // Stop the abandoned turn/recovery before starting a fresh attempt.
        if (attemptRef.submissionId) {
          const submissionId = attemptRef.submissionId;
          await step.do(`${stepName}:cancel-${attempt}`, async () => {
            await this.agent.cancelSubmission(
              submissionId,
              "Think workflow retrying prompt step"
            );
          });
        }

        const delayMs = await this._promptRetryDelayMs(
          stepName,
          attempt,
          baseDelayMs,
          maxDelayMs
        );
        console.warn(
          `[ThinkWorkflow] step.prompt "${stepName}" attempt ${
            attempt + 1
          }/${maxAttempts} failed; retrying after ${delayMs}ms`,
          {
            workflowName: this.workflowName,
            workflowId: this.workflowId,
            stepName,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            error: err instanceof Error ? err.message : String(err)
          }
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
    step: AgentWorkflowStep,
    attemptRef: { submissionId?: string },
    eventType: string,
    cancelOnTimeout: boolean | undefined
  ): Promise<z.infer<Schema>> {
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

    // Expose the submission id so the retry loop can terminate this attempt's
    // turn (and any chatRecovery continuation of it) before retrying.
    attemptRef.submissionId = submission.submissionId;

    const event = await this._waitForPromptEvent(
      step,
      waitStepName,
      eventType,
      options.timeout,
      cancelOnTimeout,
      submission.submissionId
    );

    return this._processPromptEvent(event, options);
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

  private _processPromptEvent<Schema extends ZodObject>(
    event: WorkflowStepEvent<ThinkPromptEventPayload>,
    options: ThinkPromptOptions<Schema>
  ): z.infer<Schema> {
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

  /** Try to reuse an interrupted submission before falling back to resubmit. */
  private async _tryRecoverSubmission<Schema extends ZodObject>(
    step: AgentWorkflowStep,
    stepName: string,
    attempt: number,
    eventType: string,
    options: ThinkPromptOptions<Schema>,
    submissionId: string,
    baseDelayMs: number,
    maxDelayMs: number
  ): Promise<
    { recovered: true; value: z.infer<Schema> } | { recovered: false }
  > {
    for (let round = 0; round < PROMPT_RECOVERY_MAX_ROUNDS; round++) {
      const inspection = (await step.do(
        `${stepName}:recovery-check-${attempt}-${round}`,
        async () => {
          try {
            return await this.agent.inspectSubmission(submissionId);
          } catch {
            // DO may still be restarting after a deploy.
            return null;
          }
        }
      )) as ThinkSubmissionInspection | null;

      if (inspection === null) {
        // Treat an unreachable DO as still recovering, not dead.
        await this._recoveryBackoff(
          step,
          stepName,
          attempt,
          round,
          baseDelayMs,
          maxDelayMs
        );
        continue;
      }

      if (
        inspection.status === "error" ||
        inspection.status === "aborted" ||
        inspection.status === "skipped"
      ) {
        // Terminal failure: recovery cannot help.
        return { recovered: false };
      }

      // The DO is (or already finished) driving this submission to its event.
      const result = await this._waitForRecoveryEvent(
        step,
        `${stepName}:recovery-wait-${attempt}-${round}`,
        eventType,
        options
      );
      if (result.kind === "recovered") {
        return { recovered: true, value: result.value };
      }
      if (result.kind === "failed") {
        // Terminal failure or invalid output: resubmit.
        return { recovered: false };
      }
      // Still working (or died again): re-inspect after backoff.
      await this._recoveryBackoff(
        step,
        stepName,
        attempt,
        round,
        baseDelayMs,
        maxDelayMs
      );
    }

    return { recovered: false };
  }

  private async _recoveryBackoff(
    step: AgentWorkflowStep,
    stepName: string,
    attempt: number,
    round: number,
    baseDelayMs: number,
    maxDelayMs: number
  ): Promise<void> {
    const delayMs = await this._promptRetryDelayMs(
      `${stepName}:recovery`,
      round,
      baseDelayMs,
      maxDelayMs
    );
    await step.sleep(
      `${stepName}:recovery-backoff-${attempt}-${round}`,
      delayMs
    );
  }

  private async _waitForRecoveryEvent<Schema extends ZodObject>(
    step: AgentWorkflowStep,
    waitStepName: string,
    eventType: string,
    options: ThinkPromptOptions<Schema>
  ): Promise<
    | { kind: "recovered"; value: z.infer<Schema> }
    | { kind: "failed" }
    | { kind: "timeout" }
  > {
    let event: WorkflowStepEvent<ThinkPromptEventPayload>;
    try {
      event = (await step.waitForEvent(waitStepName, {
        type: eventType,
        timeout: options.timeout
      })) as WorkflowStepEvent<ThinkPromptEventPayload>;
    } catch (error) {
      if (!isTimeoutLikeError(error)) throw error;
      // The DO may still be working or may have died again.
      return { kind: "timeout" };
    }

    try {
      return {
        kind: "recovered",
        value: this._processPromptEvent(event, options)
      };
    } catch (error) {
      if (!(error instanceof ThinkPromptError)) throw error;
      // Terminal event or invalid structured output; event is already disposed.
      return { kind: "failed" };
    }
  }

  private _validatePromptRetryOptions(
    options: ThinkPromptRetryOptions | undefined
  ): Required<ThinkPromptRetryOptions> {
    const maxAttempts = options?.maxAttempts ?? 1;
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
      throw new Error("step.prompt retries.maxAttempts must be >= 1");
    }
    if (!Number.isInteger(maxAttempts)) {
      throw new Error("step.prompt retries.maxAttempts must be an integer");
    }

    const baseDelayMs = options?.baseDelayMs ?? 500;
    if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
      throw new Error("step.prompt retries.baseDelayMs must be > 0");
    }

    const maxDelayMs = options?.maxDelayMs ?? 5000;
    if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
      throw new Error("step.prompt retries.maxDelayMs must be > 0");
    }

    if (baseDelayMs > maxDelayMs) {
      throw new Error(
        "step.prompt retries.baseDelayMs must be <= retries.maxDelayMs"
      );
    }

    const retryOnTimeout = options?.retryOnTimeout ?? true;

    return {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      retryOnTimeout
    };
  }

  private async _promptRetryDelayMs(
    stepName: string,
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number
  ): Promise<number> {
    const upperBoundMs = Math.min(2 ** attempt * baseDelayMs, maxDelayMs);
    // Deterministic jitter for Workflows replay.
    const jitterSeed = `${this.workflowName}:${this.workflowId}:${stepName}:${attempt}`;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      ThinkWorkflow._encoder.encode(jitterSeed)
    );
    const digestBytes = new Uint8Array(digest);
    const fraction = ((digestBytes[0] << 8) | digestBytes[1]) / 0x10000;
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
    const bytes = ThinkWorkflow._encoder.encode(value);
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

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out/i.test(error.name + " " + error.message);
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
