/**
 * Voice-to-text input mixin for the Agents SDK.
 *
 * Unlike `withVoice` (which builds a full conversational voice agent with
 * STT → LLM → TTS), `withVoiceInput` only does STT and sends the
 * transcript back to the client. There is no TTS, no `onTurn`, and no
 * response generation — making it ideal for dictation / voice input UIs.
 *
 * Usage:
 *   import { Agent } from "agents";
 *   import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
 *
 *   const InputAgent = withVoiceInput(Agent);
 *
 *   class MyAgent extends InputAgent<Env> {
 *     transcriber = new WorkersAINova3STT(this.env.AI);
 *
 *     onTranscript(text, connection) {
 *       console.log("User said:", text);
 *     }
 *   }
 *
 * @experimental This API is not yet stable and may change.
 */

import type { Agent, Connection, WSMessage } from "agents";
import { logVoiceError, toVoiceError, voiceErrorMessage } from "./errors";
import {
  ServerDiagnostics,
  type DiagnosticData,
  type TurnDiagnostics
} from "./diagnostics";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  Transcriber,
  VoiceDiagnosticsOptions,
  VoiceTurnOutcome
} from "./types";
import {
  AudioConnectionManager,
  runBackground,
  sendVoiceJSON
} from "./audio-pipeline";

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<Pick<Agent<Cloudflare.Env>, "keepAlive">>;

/** Configuration options for the voice input mixin. */
export interface VoiceInputOptions {
  /** Optional diagnostic output. Diagnostic event names and metadata are not stable API. */
  diagnostics?: VoiceDiagnosticsOptions;
}

/** Public surface of the voice input mixin, used as an explicit return type to satisfy TS6 declaration emit. */
export interface VoiceInputMixinMembers {
  transcriber?: Transcriber;
  onTranscript(text: string, connection: Connection): void | Promise<void>;
  createTranscriber(connection: Connection): Transcriber | null;
  beforeCallStart(connection: Connection): boolean | Promise<boolean>;
  onCallStart(connection: Connection): void | Promise<void>;
  onCallEnd(connection: Connection): void | Promise<void>;
  onInterrupt(connection: Connection): void | Promise<void>;
  afterTranscribe(
    transcript: string,
    connection: Connection
  ): string | null | Promise<string | null>;
}

type VoiceInputMixinReturn<TBase extends AgentLike> = TBase &
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
  (new (...args: any[]) => VoiceInputMixinMembers);

/**
 * Voice-to-text input mixin. Adds STT-only voice input to an Agent class.
 *
 * Subclasses must set a `transcriber` property (or override `createTranscriber`).
 * No TTS provider is needed. Override `onTranscript` to handle each
 * transcribed utterance.
 *
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceInputOptions - Optional pipeline configuration.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
 *
 * const InputAgent = withVoiceInput(Agent);
 *
 * class MyAgent extends InputAgent<Env> {
 *   transcriber = new WorkersAINova3STT(this.env.AI);
 *
 *   onTranscript(text, connection) {
 *     console.log("User said:", text);
 *   }
 * }
 * ```
 */
export function withVoiceInput<TBase extends AgentLike>(
  Base: TBase,
  voiceInputOptions?: VoiceInputOptions
): VoiceInputMixinReturn<TBase> {
  const diagnostics = new ServerDiagnostics(
    voiceInputOptions?.diagnostics?.browserConsole === true
  );

  class VoiceInputMixin extends Base {
    /** Continuous transcriber provider. */
    transcriber?: Transcriber;

    #cm = new AudioConnectionManager("VoiceInput");
    #keepAliveDispose = new Map<string, () => void>();

    // Current async start_call identity per connection, used to ignore stale startup work.
    #startupTokens = new Map<string, symbol>();
    // Persists after readiness so callbacks from replaced sessions cannot affect a newer call.
    #callTokens = new Map<string, symbol>();
    #turnSequence = 0;
    #inputTurns = new Map<string, TurnDiagnostics>();
    #activeTurns = new Map<
      string,
      { signal: AbortSignal; turn: TurnDiagnostics }
    >();

    static #VOICE_MESSAGES = new Set([
      "hello",
      "start_call",
      "end_call",
      "start_of_speech",
      "end_of_speech",
      "interrupt"
    ]);

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
    constructor(...args: any[]) {
      super(...args);

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onConnect = (this as any).onConnect?.bind(this);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onClose = (this as any).onClose?.bind(this);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onMessage = (this as any).onMessage?.bind(this);

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onConnect = (
        connection: Connection,
        ...rest: unknown[]
      ) => {
        sendVoiceJSON(
          connection,
          {
            type: "welcome",
            protocol_version: VOICE_PROTOCOL_VERSION,
            ...(diagnostics.browserConsole
              ? { diagnostics: { browser_console: true as const } }
              : {})
          },
          "VoiceInput"
        );
        this.#diagnose(connection, "connection.opened");
        sendVoiceJSON(
          connection,
          { type: "status", status: "idle" },
          "VoiceInput"
        );
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
        this.#diagnose(connection, "connection.closed", {
          in_call: this.#cm.isInCall(connection.id)
        });
        this.#abortInputTurn(connection, "connection_closed");
        this.#requestActiveTurnAbort(connection, "connection_closed");
        this.#startupTokens.delete(connection.id);
        this.#callTokens.delete(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#cm.cleanup(connection.id);
        return _onClose?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onMessage = (
        connection: Connection,
        message: WSMessage
      ) => {
        if (message instanceof ArrayBuffer) {
          this.#cm.bufferAudio(connection.id, message);
          return;
        }

        if (typeof message !== "string") {
          return _onMessage?.(connection, message);
        }

        let parsed: { type: string };
        try {
          parsed = JSON.parse(message);
        } catch {
          return _onMessage?.(connection, message);
        }

        if (VoiceInputMixin.#VOICE_MESSAGES.has(parsed.type)) {
          switch (parsed.type) {
            case "hello":
              break;
            case "start_call":
              runBackground("start_call", () =>
                this.#handleStartCall(connection)
              );
              break;
            case "end_call":
              runBackground("end_call", () => this.#handleEndCall(connection));
              break;
            case "start_of_speech":
            case "end_of_speech":
              break;
            case "interrupt":
              runBackground("interrupt", () =>
                this.#handleInterrupt(connection)
              );
              break;
          }
          return;
        }

        return _onMessage?.(connection, message);
      };
    }

    // --- User-overridable hooks ---

    onTranscript(
      _text: string,
      _connection: Connection
    ): void | Promise<void> {}

    /**
     * Override to create a transcriber dynamically per connection.
     * Return null to fall back to the `transcriber` property.
     */
    createTranscriber(_connection: Connection): Transcriber | null {
      return null;
    }

    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(_connection: Connection): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    afterTranscribe(
      transcript: string,
      _connection: Connection
    ): string | null | Promise<string | null> {
      return transcript;
    }

    #diagnose(
      connection: Connection,
      event: string,
      data?: DiagnosticData
    ): void {
      diagnostics.emit(connection, event, data);
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection) {
      if (this.#cm.isInCall(connection.id)) {
        this.#diagnose(connection, "call.start_ignored", {
          reason: "already_active"
        });
        return;
      }

      this.#diagnose(connection, "call.starting");
      this.#abortInputTurn(connection, "call_restarted");
      const startupToken = Symbol(connection.id);
      this.#startupTokens.set(connection.id, startupToken);
      this.#callTokens.set(connection.id, startupToken);

      this.#cm.initConnection(connection.id);

      let startingTranscriber = false;
      try {
        const allowed = await this.beforeCallStart(connection);
        if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        if (!allowed) {
          await this.#handleStartupFailure(
            connection,
            startupToken,
            undefined,
            "Voice call was rejected",
            null
          );
          return;
        }

        const provider = this.createTranscriber(connection) ?? this.transcriber;
        if (!provider) {
          const message =
            "No transcriber configured. Set 'transcriber' on your VoiceInput subclass or override createTranscriber().";
          logVoiceError({
            component: "VoiceInput",
            stage: "configuration",
            message,
            connectionId: connection.id,
            error: new Error(message)
          });
          await this.#handleStartupFailure(
            connection,
            startupToken,
            undefined,
            message,
            null
          );
          return;
        }

        const dispose = await this.keepAlive();
        if (!this.#isCurrentStartup(connection.id, startupToken)) {
          dispose();
          return;
        }
        this.#keepAliveDispose.set(connection.id, dispose);

        startingTranscriber = true;
        this.#diagnose(connection, "stt.starting");
        const session = this.#cm.startTranscriberSession(
          connection.id,
          provider,
          {
            onInterim: (text: string) => {
              if (this.#callTokens.get(connection.id) !== startupToken) return;
              const turn = this.#getOrCreateInputTurn(connection);
              turn.firstInterim(text.length);
              sendVoiceJSON(
                connection,
                { type: "transcript_interim", text },
                "VoiceInput"
              );
            },
            onSpeechStart: () => {
              if (this.#callTokens.get(connection.id) !== startupToken) return;
              const turn = this.#replaceInputTurn(connection);
              turn.speechStarted();
            },
            onUtterance: (transcript: string) => {
              if (this.#callTokens.get(connection.id) !== startupToken) return;
              const turn = this.#takeInputTurn(connection);
              turn.finalInput(transcript.length);
              runBackground("emitTranscript", () =>
                this.#emitTranscript(connection, transcript, turn)
              );
            },
            onFatalError: (error: Error) => {
              runBackground("transcriber_fatal", () =>
                this.#handleTranscriberFatal(connection, startupToken, error)
              );
            }
          }
        );
        await session.waitUntilReady?.();
        startingTranscriber = false;
      } catch (error) {
        const clientMessage = startingTranscriber
          ? "Speech recognition failed to start"
          : "Voice input failed to start";
        await this.#handleStartupFailure(
          connection,
          startupToken,
          toVoiceError(error, clientMessage),
          clientMessage,
          startingTranscriber ? "transcriber_startup" : "call_startup",
          startingTranscriber
            ? {
                code: "stt_startup_failed",
                stage: "stt",
                retryable: false
              }
            : undefined
        );
        return;
      }

      if (!this.#isCurrentStartup(connection.id, startupToken)) return;
      this.#startupTokens.delete(connection.id);

      this.#diagnose(connection, "stt.ready");
      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );

      this.#diagnose(connection, "call.ready");
      await this.onCallStart(connection);
    }

    #isCurrentStartup(connectionId: string, startupToken: symbol): boolean {
      return (
        this.#startupTokens.get(connectionId) === startupToken &&
        this.#cm.isInCall(connectionId)
      );
    }

    async #handleStartupFailure(
      connection: Connection,
      startupToken: symbol,
      error: Error | undefined,
      clientMessage: string,
      logStage: string | null = "call_startup",
      structuredError?: {
        code: "stt_startup_failed";
        stage: "stt";
        retryable: false;
      }
    ): Promise<void> {
      if (!this.#isCurrentStartup(connection.id, startupToken)) return;

      // The client starts local audio optimistically on start_call. Every
      // terminal startup path must send error + idle so it tears that down.
      if (logStage && error !== undefined) {
        logVoiceError({
          component: "VoiceInput",
          stage: logStage,
          message: clientMessage,
          connectionId: connection.id,
          error
        });
      }
      this.#startupTokens.delete(connection.id);
      if (this.#callTokens.get(connection.id) === startupToken) {
        this.#callTokens.delete(connection.id);
      }
      this.#diagnose(connection, "call.start_failed", {
        stage: logStage ?? "authorization",
        retryable: structuredError?.retryable ?? false,
        ...(error === undefined ? {} : { error })
      });
      sendVoiceJSON(
        connection,
        { type: "error", message: clientMessage, ...structuredError },
        "VoiceInput"
      );
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#diagnose(connection, "cleanup.completed");
      this.#diagnose(connection, "call.ended", {
        reason: "startup_failed"
      });
      sendVoiceJSON(
        connection,
        { type: "status", status: "idle" },
        "VoiceInput"
      );
      await this.onCallEnd(connection);
    }

    async #handleTranscriberFatal(
      connection: Connection,
      callToken: symbol,
      error: Error
    ): Promise<void> {
      if (
        this.#callTokens.get(connection.id) !== callToken ||
        !this.#cm.isInCall(connection.id)
      ) {
        return;
      }

      const isStarting = this.#startupTokens.get(connection.id) === callToken;
      const message = isStarting
        ? "Speech recognition failed to start"
        : "Speech recognition connection was lost";
      logVoiceError({
        component: "VoiceInput",
        stage: isStarting ? "transcriber_startup" : "transcriber_runtime",
        message,
        connectionId: connection.id,
        error
      });
      this.#startupTokens.delete(connection.id);
      this.#callTokens.delete(connection.id);
      this.#abortInputTurn(connection, "stt_fatal");
      this.#requestActiveTurnAbort(connection, "stt_fatal");
      this.#diagnose(connection, "stt.fatal", {
        stage: isStarting ? "startup" : "runtime",
        retryable: !isStarting,
        error
      });
      sendVoiceJSON(
        connection,
        {
          type: "error",
          message,
          code: isStarting ? "stt_startup_failed" : "stt_connection_lost",
          stage: "stt",
          retryable: !isStarting
        },
        "VoiceInput"
      );
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#diagnose(connection, "cleanup.completed");
      this.#diagnose(connection, "call.ended", { reason: "stt_fatal" });
      sendVoiceJSON(
        connection,
        { type: "status", status: "idle" },
        "VoiceInput"
      );
      await this.onCallEnd(connection);
    }

    #createTurn(connection: Connection): TurnDiagnostics {
      const turn = diagnostics.turn(
        connection,
        `turn_${(++this.#turnSequence).toString(36)}`,
        "speech"
      );
      turn.emit("turn.started", { source: "speech" });
      return turn;
    }

    #replaceInputTurn(connection: Connection): TurnDiagnostics {
      this.#abortInputTurn(connection, "replaced");
      const turn = this.#createTurn(connection);
      this.#inputTurns.set(connection.id, turn);
      return turn;
    }

    #getOrCreateInputTurn(connection: Connection): TurnDiagnostics {
      const current = this.#inputTurns.get(connection.id);
      if (current) return current;
      const turn = this.#createTurn(connection);
      this.#inputTurns.set(connection.id, turn);
      return turn;
    }

    #takeInputTurn(connection: Connection): TurnDiagnostics {
      const turn = this.#getOrCreateInputTurn(connection);
      this.#inputTurns.delete(connection.id);
      return turn;
    }

    #abortInputTurn(connection: Connection, reason: string): void {
      const turn = this.#inputTurns.get(connection.id);
      if (!turn) return;
      this.#inputTurns.delete(connection.id);
      turn.emit("turn.aborted", { reason });
      turn.finish("aborted");
    }

    #activateTurn(
      connection: Connection,
      turn: TurnDiagnostics
    ): { signal: AbortSignal; turn: TurnDiagnostics } {
      this.#requestActiveTurnAbort(connection, "replaced");
      const signal = this.#cm.createPipelineAbort(connection.id);
      const active = { signal, turn };
      this.#activeTurns.set(connection.id, active);
      return active;
    }

    #requestActiveTurnAbort(connection: Connection, reason: string): void {
      const active = this.#activeTurns.get(connection.id);
      if (!active) return;
      active.turn.emit("turn.abort_requested", { reason });
    }

    #clearActiveTurn(
      connectionId: string,
      active: { signal: AbortSignal; turn: TurnDiagnostics }
    ): void {
      if (this.#activeTurns.get(connectionId) === active) {
        this.#activeTurns.delete(connectionId);
      }
    }

    #releaseKeepAlive(connectionId: string) {
      const dispose = this.#keepAliveDispose.get(connectionId);
      if (dispose) {
        dispose();
        this.#keepAliveDispose.delete(connectionId);
      }
    }

    #handleEndCall(connection: Connection) {
      this.#diagnose(connection, "call.ended", { reason: "requested" });
      this.#startupTokens.delete(connection.id);
      this.#callTokens.delete(connection.id);
      this.#abortInputTurn(connection, "call_ended");
      this.#requestActiveTurnAbort(connection, "call_ended");
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      this.#diagnose(connection, "cleanup.completed");
      sendVoiceJSON(
        connection,
        { type: "status", status: "idle" },
        "VoiceInput"
      );
      // Return the (possibly async) consumer hook so its rejections are
      // caught by the runBackground wrapper around this handler.
      return this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      this.#abortInputTurn(connection, "client_interrupt");
      this.#requestActiveTurnAbort(connection, "client_interrupt");
      const interrupted = this.#cm.abortPipeline(connection.id);
      this.#diagnose(connection, "turn.interrupt_requested", {
        active_turn: interrupted
      });
      this.#cm.clearAudioBuffer(connection.id);
      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );
      return this.onInterrupt(connection);
    }

    // --- Internal: transcript emission ---

    async #emitTranscript(
      connection: Connection,
      transcript: string,
      turn: TurnDiagnostics
    ) {
      const active = this.#activateTurn(connection, turn);
      const { signal } = active;
      let outcome: VoiceTurnOutcome = "completed";
      let restoreListening = true;
      try {
        const afterTranscribeStart = Date.now();
        const userText = await this.afterTranscribe(transcript, connection);
        turn.recordAfterTranscribe(
          Date.now() - afterTranscribeStart,
          userText ? "accepted" : "skipped",
          userText?.length ?? 0
        );
        if (signal.aborted) return;
        if (!userText) {
          outcome = "skipped";
          restoreListening = false;
          return;
        }

        sendVoiceJSON(
          connection,
          { type: "transcript_interim", text: "" },
          "VoiceInput"
        );

        sendVoiceJSON(
          connection,
          { type: "transcript", role: "user", text: userText },
          "VoiceInput"
        );

        await this.onTranscript(userText, connection);
      } catch (error) {
        if (signal.aborted) return;
        const voiceError = toVoiceError(error, "Transcript processing failed");
        outcome = "error";
        turn.emit("turn.error", {
          stage: "transcript",
          error: voiceError
        });
        logVoiceError({
          component: "VoiceInput",
          stage: "transcript",
          message: "Transcript processing failed",
          connectionId: connection.id,
          error: voiceError
        });
        sendVoiceJSON(
          connection,
          {
            type: "error",
            message: voiceErrorMessage(
              voiceError,
              "Transcript processing failed"
            )
          },
          "VoiceInput"
        );
      } finally {
        if (signal.aborted) {
          outcome = "aborted";
          turn.emit("turn.aborted");
        }
        turn.finish(outcome);
        this.#cm.clearPipelineAbort(connection.id, signal);
        this.#clearActiveTurn(connection.id, active);
        if (restoreListening && this.#cm.isInCall(connection.id)) {
          sendVoiceJSON(
            connection,
            { type: "status", status: "listening" },
            "VoiceInput"
          );
        }
      }
    }
  }

  return VoiceInputMixin as unknown as VoiceInputMixinReturn<TBase>;
}
