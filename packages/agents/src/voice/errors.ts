const MAX_CLIENT_MESSAGE_LENGTH = 300;

export interface VoiceProviderErrorOptions {
  code?: string | number;
  status?: number;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
}

/**
 * Error raised at a voice provider boundary. Only known, content-free provider
 * metadata belongs here. Provider response bodies and raw events must stay out.
 */
export class VoiceProviderError extends Error {
  readonly code?: string | number;
  readonly status?: number;
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly wasClean?: boolean;

  constructor(message: string, options: VoiceProviderErrorOptions = {}) {
    super(message);
    this.name = "VoiceProviderError";
    if (options.code !== undefined) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
    if (options.closeCode !== undefined) this.closeCode = options.closeCode;
    if (options.closeReason !== undefined) {
      this.closeReason = options.closeReason;
    }
    if (options.wasClean !== undefined) this.wasClean = options.wasClean;
  }
}

export interface VoiceErrorLogOptions {
  component: string;
  stage: string;
  message: string;
  error: Error;
  connectionId?: string;
}

/** Convert a value caught from an external boundary without inspecting it. */
export function toVoiceError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/** Return a bounded direct message suitable for the existing string wire API. */
export function voiceErrorMessage(error: Error, fallback: string): string {
  const message = error.message.trim();
  if (!message || message === "[object Object]") return fallback;
  return message.slice(0, MAX_CLIENT_MESSAGE_LENGTH);
}

/** Emit one structured object so Workers Logs can extract diagnostic fields. */
export function logVoiceError(options: VoiceErrorLogOptions): void {
  console.error({
    component: options.component,
    stage: options.stage,
    message: options.message,
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    error: options.error
  });
}
