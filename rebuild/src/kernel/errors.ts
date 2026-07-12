export class AgentError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AgentError {
  constructor(message: string) {
    super(message, "validation");
  }
}

export class NotFoundError extends AgentError {
  constructor(message: string) {
    super(message, "not_found");
  }
}

export class ConflictError extends AgentError {
  constructor(message: string) {
    super(message, "conflict");
  }
}

export class AbortedError extends AgentError {
  constructor(message: string) {
    super(message, "aborted");
  }
}

export class TimeoutError extends AgentError {
  constructor(message: string) {
    super(message, "timeout");
  }
}

export interface ErrorValue {
  name: string;
  message: string;
  [k: string]: unknown;
}

/** Converts any throwable to a structured ErrorValue. Never throws. */
export function toErrorValue(err: unknown): ErrorValue {
  if (err instanceof AgentError) {
    return { name: err.name, message: err.message, code: err.code };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  if (typeof err === "string") {
    return { name: "Error", message: err };
  }
  if (err === null || err === undefined) {
    return { name: "Error", message: String(err) };
  }
  try {
    return { name: "Error", message: JSON.stringify(err) };
  } catch {
    return { name: "Error", message: String(err) };
  }
}
