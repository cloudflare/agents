import { VoiceProviderError } from "./errors";
import type { TextStreamEvent } from "./text-stream";
import type {
  VoiceDiagnosticEvent,
  VoiceModelFinishReason,
  VoiceTurnMetrics,
  VoiceTurnOutcome,
  VoiceTurnSource
} from "./types";

const MAX_STRING_LENGTH = 160;

const PRIVATE_KEY =
  /(^|_)(audio|body|contents?|exceptions?|messages?|prompts?|query|results?|stack|text|tokens?|tools?|transcripts?|arguments?)(_|$)/i;

type DiagnosticValue = string | number | boolean | null | Error;
export type DiagnosticData = Record<string, DiagnosticValue>;

type DiagnosticConnection = {
  send(data: string | ArrayBuffer): void;
};

function boundedString(value: string, maxLength = MAX_STRING_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function diagnosticErrorData(error: Error): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    name: boundedString(error.name || "Error"),
    message: boundedString(error.message || "Unknown error")
  };

  if (error instanceof VoiceProviderError) {
    if (error.code !== undefined) summary.code = error.code;
    if (error.status !== undefined) summary.status = error.status;
    if (error.closeCode !== undefined) summary.closeCode = error.closeCode;
    if (error.closeReason !== undefined) {
      summary.closeReason = boundedString(error.closeReason);
    }
    if (error.wasClean !== undefined) summary.wasClean = error.wasClean;
  }

  return summary;
}

/**
 * Keep diagnostic metadata bounded and reject fields that could carry user or
 * provider content. Instrumentation should still pass only known-safe values.
 */
export function sanitizeDiagnosticData(
  data?: DiagnosticData
): Record<string, unknown> | undefined {
  if (!data) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (PRIVATE_KEY.test(key)) continue;
    sanitized[key] =
      value instanceof Error
        ? diagnosticErrorData(value)
        : typeof value === "string"
          ? boundedString(value)
          : value;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function createDiagnosticEvent(
  event: string,
  data?: DiagnosticData,
  timestamp = Date.now()
): VoiceDiagnosticEvent {
  const safeData = sanitizeDiagnosticData(data);
  return {
    event,
    timestamp,
    ...(safeData ? { data: safeData } : {})
  };
}

/** Server-only diagnostics. The sink is the reserved voice protocol message. */
export class ServerDiagnostics {
  readonly browserConsole: boolean;

  constructor(browserConsole: boolean) {
    this.browserConsole = browserConsole;
  }

  emit(
    connection: DiagnosticConnection,
    event: string,
    data?: DiagnosticData
  ): void {
    if (!this.browserConsole) return;

    try {
      connection.send(
        JSON.stringify({
          type: "diagnostic",
          ...createDiagnosticEvent(event, data)
        })
      );
    } catch {
      // Diagnostics must never alter call behavior.
    }
  }

  turn(
    connection: DiagnosticConnection,
    turnId: string,
    source: VoiceTurnSource = "speech",
    now: () => number = Date.now
  ): TurnDiagnostics {
    return new TurnDiagnostics(this, connection, turnId, source, now);
  }
}

function safeDuration(value: number): number {
  return Math.max(0, value);
}

export type TtsSentenceOutcome = "completed" | "skipped" | "failed";

/** One sentence attempt measured by its parent turn clock. */
export class TtsSentenceTracker {
  #turn: TurnDiagnostics;
  #startedAt: number;

  constructor(turn: TurnDiagnostics, startedAt: number) {
    this.#turn = turn;
    this.#startedAt = startedAt;
  }

  providerStarted(): void {
    this.#turn.recordTtsProviderStarted();
  }

  settle(outcome: TtsSentenceOutcome): number {
    return this.#turn.recordTtsSentence(this.#startedAt, outcome);
  }
}

/**
 * One content-free turn lifecycle. Diagnostics and stable metrics are emitted
 * from the same recorded landmarks; application metrics never parse event
 * names or diagnostic metadata.
 */
export class TurnDiagnostics {
  readonly turnId: string;
  readonly source: VoiceTurnSource;
  #diagnostics: ServerDiagnostics;
  #connection: DiagnosticConnection;
  #now: () => number;
  #startedAt: number;
  #speechStartedAt: number | undefined;
  #firstInterimObserved = false;
  #finalInputAt: number | undefined;
  #firstTtsProviderAt: number | undefined;
  #firstAudioAt: number | undefined;
  #ttsFinished = false;
  #hasTtsFailures = false;
  #metrics: Partial<VoiceTurnMetrics> = {};

  constructor(
    diagnostics: ServerDiagnostics,
    connection: DiagnosticConnection,
    turnId: string,
    source: VoiceTurnSource,
    now: () => number
  ) {
    this.#diagnostics = diagnostics;
    this.#connection = connection;
    this.#now = now;
    this.#startedAt = now();
    this.turnId = turnId;
    this.source = source;
  }

  get hasTtsFailures(): boolean {
    return this.#hasTtsFailures;
  }

  get ttsWorkMs(): number {
    return this.#metrics.ttsWorkMs ?? 0;
  }

  emit(event: string, data?: DiagnosticData): void {
    const scopedData: DiagnosticData = {
      ...data,
      turn_id: this.turnId
    };
    this.#diagnostics.emit(this.#connection, event, scopedData);
  }

  startModel(): ModelDiagnosticTracker {
    return new ModelDiagnosticTracker(this, this.#now);
  }

  markTextInput(): void {
    this.#finalInputAt ??= this.#startedAt;
  }

  speechStarted(): void {
    this.#speechStartedAt ??= this.#now();
    this.emit("speech.started");
  }

  firstInterim(characters?: number): void {
    if (this.#firstInterimObserved) return;
    this.#firstInterimObserved = true;
    const elapsed =
      this.#speechStartedAt === undefined
        ? undefined
        : safeDuration(this.#now() - this.#speechStartedAt);
    if (elapsed !== undefined) {
      this.#metrics.speechStartToFirstInterimMs = elapsed;
    }
    this.emit("stt.interim", {
      ...(characters === undefined ? {} : { characters }),
      ...(elapsed === undefined ? {} : { speech_to_interim_ms: elapsed })
    });
  }

  finalInput(characters?: number): void {
    this.#finalInputAt = this.#now();
    const elapsed =
      this.#speechStartedAt === undefined
        ? undefined
        : safeDuration(this.#finalInputAt - this.#speechStartedAt);
    if (elapsed !== undefined) this.#metrics.speechStartToFinalMs = elapsed;
    this.emit("stt.utterance", {
      ...(characters === undefined ? {} : { characters }),
      ...(elapsed === undefined ? {} : { speech_to_final_ms: elapsed })
    });
  }

  recordAfterTranscribe(
    durationMs: number,
    outcome: "accepted" | "skipped",
    characters: number
  ): void {
    this.#metrics.afterTranscribeMs = safeDuration(durationMs);
    this.emit("after_transcribe.completed", {
      duration_ms: safeDuration(durationMs),
      outcome,
      characters
    });
  }

  beginTtsSentence(): TtsSentenceTracker {
    this.#metrics.ttsWorkMs ??= 0;
    return new TtsSentenceTracker(this, this.#now());
  }

  recordTtsProviderStarted(): void {
    this.#firstTtsProviderAt ??= this.#now();
  }

  recordTtsSentence(startedAt: number, outcome: TtsSentenceOutcome): number {
    const duration = safeDuration(this.#now() - startedAt);
    this.#metrics.ttsWorkMs = (this.#metrics.ttsWorkMs ?? 0) + duration;
    if (outcome === "failed") this.#hasTtsFailures = true;
    return duration;
  }

  finishTts(): void {
    if (this.#ttsFinished) return;
    this.#ttsFinished = true;
    if (this.#firstTtsProviderAt !== undefined) {
      this.#metrics.ttsWallMs = safeDuration(
        this.#now() - this.#firstTtsProviderAt
      );
    }
  }

  audioSent(): void {
    const now = this.#now();
    if (this.#firstAudioAt !== undefined) return;
    this.#firstAudioAt = now;
    if (this.#finalInputAt !== undefined) {
      this.#metrics.finalInputToFirstAudioMs = safeDuration(
        now - this.#finalInputAt
      );
    }
    if (this.#firstTtsProviderAt !== undefined) {
      this.#metrics.ttsToFirstAudioMs = safeDuration(
        now - this.#firstTtsProviderAt
      );
    }
  }

  recordModelFirstText(durationMs: number): void {
    this.#metrics.modelToFirstTextMs = safeDuration(durationMs);
  }

  recordReasoning(durationMs: number): void {
    this.#metrics.exposedReasoningMs =
      (this.#metrics.exposedReasoningMs ?? 0) + safeDuration(durationMs);
  }

  recordModelTerminal(durationMs: number): void {
    this.#metrics.modelStreamConsumptionMs = safeDuration(durationMs);
  }

  finish(outcome: VoiceTurnOutcome): VoiceTurnMetrics {
    this.finishTts();

    const summary: VoiceTurnMetrics = {
      turnId: this.turnId,
      source: this.source,
      outcome,
      turnTotalMs: safeDuration(this.#now() - this.#startedAt),
      ...this.#metrics
    };

    this.emit("turn.ended", {
      outcome,
      duration_ms: summary.turnTotalMs
    });
    try {
      this.#connection.send(
        JSON.stringify({ type: "turn_metrics", ...summary })
      );
    } catch {
      // A closing connection can make the terminal summary undeliverable.
    }
    return summary;
  }
}

/**
 * Tracks one model stream without retaining model or reasoning content.
 * Lifecycle methods are idempotent so stale turn cleanup cannot affect a
 * successor tracker.
 */
export class ModelDiagnosticTracker {
  #turn: TurnDiagnostics;
  #now: () => number;
  #startedAt: number;
  #firstTextObserved = false;
  #reasoningActive = false;
  #reasoningStartedAt = 0;
  #characters = 0;
  #terminal = false;

  constructor(turn: TurnDiagnostics, now: () => number) {
    this.#turn = turn;
    this.#now = now;
    this.#startedAt = now();
    this.#turn.emit("model.started");
  }

  observe(event: TextStreamEvent): void {
    if (this.#terminal) return;

    switch (event.type) {
      case "text":
        this.#characters += event.text.length;
        if (!this.#firstTextObserved && event.text.trim().length > 0) {
          this.#firstTextObserved = true;
          const elapsed = safeDuration(this.#now() - this.#startedAt);
          this.#turn.recordModelFirstText(elapsed);
          this.#turn.emit("model.first_text", { elapsed_ms: elapsed });
        }
        break;
      case "reasoning-start":
        this.#startReasoning();
        break;
      case "reasoning-end":
        this.#completeReasoning("completed");
        break;
      case "finish":
        this.#completeReasoning("stream_finished");
        break;
      case "error":
        break;
      case "boundary":
        break;
    }
  }

  complete(
    outcome: "output" | "no_output",
    finishReason?: VoiceModelFinishReason
  ): void {
    if (this.#terminal) return;
    this.#completeReasoning("stream_completed");
    this.#terminal = true;
    const duration = this.elapsedMs();
    this.#turn.recordModelTerminal(duration);
    this.#turn.emit("model.completed", {
      duration_ms: duration,
      outcome,
      characters: this.#characters,
      ...(finishReason === undefined ? {} : { finish_reason: finishReason })
    });
  }

  fail(error: Error): void {
    if (this.#terminal) return;
    this.#completeReasoning("error");
    this.#terminal = true;
    this.#turn.recordModelTerminal(this.elapsedMs());
    this.#turn.emit("model.failed", { error });
  }

  abort(): void {
    if (this.#terminal) return;
    this.#completeReasoning("aborted");
    this.#terminal = true;
    this.#turn.recordModelTerminal(this.elapsedMs());
  }

  elapsedMs(): number {
    return safeDuration(this.#now() - this.#startedAt);
  }

  #startReasoning(): void {
    if (this.#reasoningActive) return;
    this.#reasoningActive = true;
    this.#reasoningStartedAt = this.#now();
    this.#turn.emit("model.reasoning_started");
  }

  #completeReasoning(outcome: string): void {
    if (!this.#reasoningActive) return;
    this.#reasoningActive = false;
    const duration = safeDuration(this.#now() - this.#reasoningStartedAt);
    this.#turn.recordReasoning(duration);
    this.#turn.emit("model.reasoning_completed", {
      duration_ms: duration,
      outcome
    });
  }
}

/** Browser-only diagnostics. Activation always comes from the server welcome. */
export class ClientDiagnostics {
  #enabled = false;

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  emit(event: string, data?: DiagnosticData): void {
    if (!this.#enabled) return;
    this.#log("client", createDiagnosticEvent(event, data));
  }

  receive(event: VoiceDiagnosticEvent): void {
    if (!this.#enabled) return;
    this.#log("server", event);
  }

  #log(origin: "client" | "server", event: VoiceDiagnosticEvent): void {
    try {
      console.info(`[voice:${origin}] ${event.event}`, {
        timestamp: event.timestamp,
        ...(event.data ?? {})
      });
    } catch {
      // Console replacements and test spies are allowed to throw.
    }
  }
}
