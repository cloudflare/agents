/**
 * Error classes for the Tasks capability. Each carries a stable `name` so
 * hosts and tests can classify failures without depending on message text.
 */

/**
 * Thrown by a step callback to fail its run immediately, skipping any
 * remaining retry attempts.
 *
 * Errors named `"NonRetryableError"` from other sources (for example
 * `cloudflare:workflows`) are honored the same way.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** True when an error should skip remaining step retry attempts. */
export function isNonRetryableError(error: unknown): boolean {
  return (
    error instanceof NonRetryableError ||
    (error instanceof Error && error.name === "NonRetryableError")
  );
}

/**
 * Thrown before executing user code when one replay uses the same step name
 * twice. Step names are durable journal keys and must be unique within a run.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class DuplicateTaskStepError extends Error {
  /** The step name used more than once. */
  readonly stepName: string;

  constructor(stepName: string) {
    super(
      `Step name "${stepName}" was already used in this run. Step names are ` +
        `durable journal keys; suffix loop steps with a stable index, e.g. ` +
        `"${stepName}:0".`
    );
    this.name = "DuplicateTaskStepError";
    this.stepName = stepName;
  }
}

/**
 * Thrown when a replay observes a journal that this handler code cannot have
 * written — a known step under a different kind, for example. The run fails
 * rather than guessing; changing a definition's step layout for in-flight
 * runs requires versioning the definition name.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class TaskReplayDivergedError extends Error {
  /** The step name where replay diverged from the journal. */
  readonly stepName: string;

  constructor(stepName: string, detail: string) {
    super(
      `Replay diverged from the journal at step "${stepName}": ${detail}. ` +
        `Version the definition name (e.g. "name@v2") instead of changing ` +
        `the step layout of in-flight runs.`
    );
    this.name = "TaskReplayDivergedError";
    this.stepName = stepName;
  }
}

/**
 * Recorded against a run whose persisted definition name is no longer
 * registered after a deployment. The run fails visibly; it is never silently
 * deleted and never replayed against a different handler.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class MissingTaskDefinitionError extends Error {
  /** The persisted definition name that no longer resolves. */
  readonly definition: string;

  constructor(definition: string) {
    super(
      `No Task definition named "${definition}" is registered. A deployment ` +
        `removed or renamed it while this run was active. Re-register the ` +
        `definition (or a versioned successor with the same name) to let the ` +
        `run finish.`
    );
    this.name = "MissingTaskDefinitionError";
    this.definition = definition;
  }
}

/**
 * Thrown when a Task input, step result, metadata value, or final result is
 * not JSON-serializable or exceeds the serialized size limit.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class TaskSerializationError extends Error {
  constructor(context: string, detail: string) {
    super(`Cannot serialize ${context}: ${detail}`);
    this.name = "TaskSerializationError";
  }
}
