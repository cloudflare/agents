export class MachineSerializationError extends Error {
  constructor(
    readonly context: string,
    detail: string
  ) {
    super(`Could not serialize ${context}: ${detail}`);
    this.name = "MachineSerializationError";
  }
}

export class MissingMachineDefinitionError extends Error {
  constructor(readonly definition: string) {
    super(`Machine definition "${definition}" is not registered`);
    this.name = "MissingMachineDefinitionError";
  }
}

export class MachineEventQueueFullError extends Error {
  constructor(readonly runId: string) {
    super(`Machine run "${runId}" event queue is full`);
    this.name = "MachineEventQueueFullError";
  }
}

export class MachineTransitionConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly revision: number
  ) {
    super(`Machine run "${runId}" no longer has revision ${revision}`);
    this.name = "MachineTransitionConflictError";
  }
}
