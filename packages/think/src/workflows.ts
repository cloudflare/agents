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

/**
 * How many inspect / re-wait rounds the timeout-recovery loop performs before
 * giving up and falling back to a fresh submission. Each round tolerates the
 * Think Durable Object being temporarily unreachable (e.g. still restarting
 * after a deploy) by backing off and re-checking, so a slow DO restart does
 * not cause the in-flight turn to be discarded prematurely.
 */
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

    // With retries enabled the loop owns the submission lifecycle: on a
    // timeout it inspects and tries to recover the in-flight submission before
    // deciding to cancel it, so the per-attempt wait must NOT cancel on
    // timeout. For the single-attempt case the legacy behaviour is preserved
    // (the wait wrapper honours `cancelOnTimeout`).
    const waitCancelsOnTimeout =
      maxAttempts > 1 ? false : options.cancelOnTimeout;
    const cancelTimedOutFinalAttempt = options.cancelOnTimeout ?? true;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptKey =
        attempt === 0 ? options.key : `${options.key ?? ""}:attempt-${attempt}`;
      // Each attempt's submission carries a distinct event type derived from
      // its key, so a delivered workflow event maps 1:1 to the submission that
      // produced it (Think emits exactly one terminal event per submission,
      // keyed by this type). The DO's own recovery re-emits an interrupted
      // submission's completion event with this same type, which
      // `_tryRecoverSubmission` waits on — no cross-attempt event can be
      // misattributed to the wrong submission.
      const eventType = await this._eventTypeForPrompt(stepName, attemptKey);
      // Captures this attempt's submission id (set once `submitMessages`
      // resolves) so the loop can recover or cancel it after a failure.
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

        // On timeout, give the DO's built-in recovery a chance to finish the
        // in-flight turn before discarding it. When the Think DO restarts
        // (e.g. during a deploy) it re-drives the interrupted submission and
        // re-emits its completion event; we re-wait for that instead of
        // wasting the turn. Recovery tolerates the DO being briefly
        // unreachable while it comes back up, and never throws — it falls
        // through to the cancel + resubmit path below when it can't recover.
        if (isTimeout && retryOnTimeout && attemptRef.submissionId) {
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
          // Final failure. On the multi-attempt path the wait wrapper never
          // cancelled, so honour `cancelOnTimeout` for a timed-out submission
          // here (a non-timeout failure is already terminal, so the cancel is
          // a harmless no-op). The single-attempt path was already handled by
          // the wait wrapper, so skip it here to avoid a redundant cancel.
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

        // Abandoning this attempt to resubmit a fresh one. Cancel the old
        // submission first: Think keeps its own `chatRecovery` running for it
        // (preserving in-flight state across DO restarts/stalls), so a
        // lingering turn or recovery for the old attempt would otherwise race
        // the fresh attempt on the same session and produce duplicate /
        // interleaved output. Cancelling aborts the in-flight turn and any
        // recovery for it, and is a no-op once the submission is terminal.
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

  /**
   * Attempt to recover an interrupted submission via the Think DO's built-in
   * chat recovery rather than discarding the in-flight turn and resubmitting.
   *
   * Runs a bounded inspect / re-wait loop that is resilient to the DO being
   * temporarily unreachable (e.g. still restarting after a deploy): an
   * unreachable DO is treated as "still recovering", not "dead", so the loop
   * backs off and re-checks instead of abandoning the submission. The method
   * never throws — it returns `{ recovered: false }` for any non-recoverable
   * outcome (genuine submission failure, invalid output, or recovery budget
   * exhausted), letting the caller fall through to cancel + resubmit.
   */
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
            // RPC failed — the DO is unreachable (most likely still
            // restarting after a deploy). Return null to signal "unknown"
            // so the loop waits and re-checks rather than discarding the
            // durable submission.
            return null;
          }
        }
      )) as ThinkSubmissionInspection | null;

      if (inspection === null) {
        // DO unreachable. The submission is durable in the DO's storage and
        // will be re-driven once it wakes, so back off and re-check instead
        // of abandoning the in-flight turn.
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
        // The submission reached a terminal failure — recovery cannot help;
        // fall back to cancel + fresh resubmit.
        return { recovered: false };
      }

      // `pending` / `running` / `completed`: the DO is (or already finished)
      // driving this submission to its completion event. Wait for it.
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
        // The recovered turn ended in a terminal failure / invalid output —
        // not recoverable; resubmit a fresh attempt instead.
        return { recovered: false };
      }
      // `timeout`: the DO is still working (or died again). Back off and
      // re-inspect on the next round.
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
    } catch {
      // The completion event did not arrive within the wait window — the DO
      // may still be working or may have died again.
      return { kind: "timeout" };
    }

    try {
      return {
        kind: "recovered",
        value: this._processPromptEvent(event, options)
      };
    } catch {
      // Terminal failure event or invalid structured output.
      // `_processPromptEvent` has already disposed the event.
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
