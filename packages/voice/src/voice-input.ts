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
 *   import { withVoiceInput, WorkersAIFluxSTT } from "@cloudflare/voice";
 *
 *   const InputAgent = withVoiceInput(Agent);
 *
 *   class MyAgent extends InputAgent<Env> {
 *     streamingStt = new WorkersAIFluxSTT(this.env.AI);
 *
 *     onTranscript(text, connection) {
 *       console.log("User said:", text);
 *     }
 *   }
 *
 * @experimental This API is not yet stable and may change.
 */

import type { Connection, WSMessage } from "agents";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type { STTProvider, VADProvider, StreamingSTTProvider } from "./types";
import {
  AudioConnectionManager,
  sendVoiceJSON,
  DEFAULT_VAD_THRESHOLD,
  DEFAULT_MIN_AUDIO_BYTES,
  DEFAULT_VAD_PUSHBACK_SECONDS,
  DEFAULT_VAD_RETRY_MS
} from "./audio-pipeline";

// --- Public types ---

/** Configuration options for the voice input mixin. */
export interface VoiceInputAgentOptions {
  /** Minimum audio bytes to process (16kHz mono 16-bit). @default 16000 (0.5s) */
  minAudioBytes?: number;
  /** VAD probability threshold — only used when `vad` is set. @default 0.5 */
  vadThreshold?: number;
  /** Seconds of audio to push back to buffer when VAD rejects. @default 2 */
  vadPushbackSeconds?: number;
  /** Milliseconds to wait after VAD rejects before retrying without VAD. @default 3000 */
  vadRetryMs?: number;
}

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Voice-to-text input mixin. Adds STT-only voice input to an Agent class.
 *
 * Subclasses must set an `stt` or `streamingStt` provider property.
 * No TTS provider is needed. Override `onTranscript` to handle each
 * transcribed utterance.
 *
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceInputOptions - Optional pipeline configuration.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoiceInput, WorkersAIFluxSTT } from "@cloudflare/voice";
 *
 * const InputAgent = withVoiceInput(Agent);
 *
 * class MyAgent extends InputAgent<Env> {
 *   streamingStt = new WorkersAIFluxSTT(this.env.AI);
 *
 *   onTranscript(text, connection) {
 *     console.log("User said:", text);
 *   }
 * }
 * ```
 */
export function withVoiceInput<TBase extends Constructor>(
  Base: TBase,
  voiceInputOptions?: VoiceInputAgentOptions
) {
  console.log(
    "[@cloudflare/voice] Note: The voice API is experimental and may change between releases. Pin your version to avoid surprises."
  );

  const opts = voiceInputOptions ?? {};

  function opt<K extends keyof VoiceInputAgentOptions>(
    key: K,
    fallback: NonNullable<VoiceInputAgentOptions[K]>
  ): NonNullable<VoiceInputAgentOptions[K]> {
    return (opts[key] ?? fallback) as NonNullable<VoiceInputAgentOptions[K]>;
  }

  class VoiceInputMixin extends Base {
    // --- Provider properties (set by subclass) ---

    /** Speech-to-text provider (batch). Required unless streamingStt is set. */
    stt?: STTProvider;
    /** Streaming speech-to-text provider. Optional — if set, used instead of batch `stt`. */
    streamingStt?: StreamingSTTProvider;
    /** Voice activity detection provider. Optional. */
    vad?: VADProvider;

    // Shared per-connection audio state manager
    #cm = new AudioConnectionManager("VoiceInput");

    // Voice protocol message types handled internally
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

      // Capture the consumer's lifecycle methods (defined on the subclass
      // prototype) and wrap them so voice logic always runs first.
      // This is the same pattern used by Agent and PartyServer.

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
            protocol_version: VOICE_PROTOCOL_VERSION
          },
          "VoiceInput"
        );
        sendVoiceJSON(
          connection,
          { type: "status", status: "idle" },
          "VoiceInput"
        );
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
        this.#cm.cleanup(connection.id);
        return _onClose?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onMessage = (
        connection: Connection,
        message: WSMessage
      ) => {
        // Binary audio — always handled by voice, never forwarded
        if (message instanceof ArrayBuffer) {
          this.#cm.bufferAudio(connection.id, message);
          return;
        }

        if (typeof message !== "string") {
          return _onMessage?.(connection, message);
        }

        // Try to parse as voice protocol
        let parsed: { type: string };
        try {
          parsed = JSON.parse(message);
        } catch {
          // Not JSON — forward to consumer
          return _onMessage?.(connection, message);
        }

        // Voice protocol message — handle internally
        if (VoiceInputMixin.#VOICE_MESSAGES.has(parsed.type)) {
          switch (parsed.type) {
            case "hello":
              break;
            case "start_call":
              this.#handleStartCall(connection);
              break;
            case "end_call":
              this.#handleEndCall(connection);
              break;
            case "start_of_speech":
              this.#handleStartOfSpeech(connection);
              break;
            case "end_of_speech":
              this.#cm.clearVadRetry(connection.id);
              this.#handleEndOfSpeech(connection);
              break;
            case "interrupt":
              this.#handleInterrupt(connection);
              break;
          }
          return;
        }

        // Not a voice message — forward to consumer
        return _onMessage?.(connection, message);
      };
    }

    // --- User-overridable hooks ---

    /**
     * Called after each utterance is transcribed.
     * Override this to process the transcript (e.g. save to storage,
     * trigger a search, or forward to another service).
     *
     * @param text - The transcribed text.
     * @param connection - The WebSocket connection that sent the audio.
     */
    onTranscript(
      _text: string,
      _connection: Connection
    ): void | Promise<void> {}

    /**
     * Called before accepting a call. Return `false` to reject.
     */
    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(_connection: Connection): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    /**
     * Hook to transform audio before STT. Return null to skip this utterance.
     */
    beforeTranscribe(
      audio: ArrayBuffer,
      _connection: Connection
    ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
      return audio;
    }

    /**
     * Hook to transform or filter the transcript after STT.
     * Return null to discard this utterance.
     */
    afterTranscribe(
      transcript: string,
      _connection: Connection
    ): string | null | Promise<string | null> {
      return transcript;
    }

    // --- Streaming STT session management ---

    #handleStartOfSpeech(connection: Connection) {
      if (!this.streamingStt) return;
      if (this.#cm.hasSTTSession(connection.id)) return;
      if (!this.#cm.isInCall(connection.id)) return;

      // Clear EOT flag from any previous turn
      this.#cm.clearEOT(connection.id);

      // Accumulate finalized segments for the full transcript
      let accumulated = "";

      this.#cm.startSTTSession(connection.id, this.streamingStt, {
        onFinal: (text: string) => {
          accumulated += (accumulated ? " " : "") + text;
          sendVoiceJSON(
            connection,
            {
              type: "transcript_interim",
              text: accumulated
            },
            "VoiceInput"
          );
        },
        onInterim: (text: string) => {
          const display = accumulated ? accumulated + " " + text : text;
          sendVoiceJSON(
            connection,
            {
              type: "transcript_interim",
              text: display
            },
            "VoiceInput"
          );
        },
        // Provider-driven end-of-turn: transcribe immediately
        onEndOfTurn: (transcript: string) => {
          if (this.#cm.isEOTTriggered(connection.id)) return;
          this.#cm.setEOTTriggered(connection.id);

          this.#cm.removeSTTSession(connection.id);
          this.#cm.clearAudioBuffer(connection.id);
          this.#cm.clearVadRetry(connection.id);

          // Emit transcript and go straight back to listening
          this.#emitTranscript(connection, transcript);
        }
      });
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection) {
      const allowed = await this.beforeCallStart(connection);
      if (!allowed) return;

      this.#cm.initConnection(connection.id);
      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );

      await this.onCallStart(connection);
    }

    #handleEndCall(connection: Connection) {
      this.#cm.cleanup(connection.id);
      sendVoiceJSON(
        connection,
        { type: "status", status: "idle" },
        "VoiceInput"
      );

      this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      this.#cm.abortPipeline(connection.id);
      this.#cm.abortSTTSession(connection.id);
      this.#cm.clearVadRetry(connection.id);
      this.#cm.clearEOT(connection.id);
      this.#cm.clearAudioBuffer(connection.id);
      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );

      this.onInterrupt(connection);
    }

    // --- Internal: audio pipeline ---

    async #handleEndOfSpeech(connection: Connection, skipVad = false) {
      // If already triggered by provider-driven EOT, ignore
      if (this.#cm.isEOTTriggered(connection.id)) {
        this.#cm.clearEOT(connection.id);
        return;
      }

      const audioData = this.#cm.getAndClearAudio(connection.id);
      if (!audioData) return;

      const hasStreamingSession = this.#cm.hasSTTSession(connection.id);

      const minAudioBytes = opt("minAudioBytes", DEFAULT_MIN_AUDIO_BYTES);
      if (audioData.byteLength < minAudioBytes) {
        this.#cm.abortSTTSession(connection.id);
        sendVoiceJSON(
          connection,
          { type: "status", status: "listening" },
          "VoiceInput"
        );
        return;
      }

      if (this.vad && !skipVad) {
        const vadResult = await this.vad.checkEndOfTurn(audioData);
        const vadThreshold = opt("vadThreshold", DEFAULT_VAD_THRESHOLD);
        const shouldProceed =
          vadResult.isComplete || vadResult.probability > vadThreshold;

        if (!shouldProceed) {
          const pushbackSeconds = opt(
            "vadPushbackSeconds",
            DEFAULT_VAD_PUSHBACK_SECONDS
          );
          const maxPushbackBytes = pushbackSeconds * 16000 * 2;
          const pushback =
            audioData.byteLength > maxPushbackBytes
              ? audioData.slice(audioData.byteLength - maxPushbackBytes)
              : audioData;
          this.#cm.pushbackAudio(connection.id, pushback);
          sendVoiceJSON(
            connection,
            { type: "status", status: "listening" },
            "VoiceInput"
          );
          this.#cm.scheduleVadRetry(
            connection.id,
            () => this.#handleEndOfSpeech(connection, true),
            opt("vadRetryMs", DEFAULT_VAD_RETRY_MS) as number
          );
          return;
        }
      }

      // --- STT phase ---

      const signal = this.#cm.createPipelineAbort(connection.id);

      sendVoiceJSON(
        connection,
        { type: "status", status: "thinking" },
        "VoiceInput"
      );

      try {
        let userText: string | null;

        if (hasStreamingSession) {
          // Streaming STT path — flush and get final transcript
          const rawTranscript = await this.#cm.flushSTTSession(connection.id);

          if (signal.aborted) return;

          if (!rawTranscript || rawTranscript.trim().length === 0) {
            sendVoiceJSON(
              connection,
              {
                type: "status",
                status: "listening"
              },
              "VoiceInput"
            );
            return;
          }

          userText = await this.afterTranscribe(rawTranscript, connection);
        } else {
          // Batch STT path
          if (!this.stt) {
            sendVoiceJSON(
              connection,
              {
                type: "status",
                status: "listening"
              },
              "VoiceInput"
            );
            return;
          }

          const processedAudio = await this.beforeTranscribe(
            audioData,
            connection
          );
          if (!processedAudio || signal.aborted) {
            sendVoiceJSON(
              connection,
              {
                type: "status",
                status: "listening"
              },
              "VoiceInput"
            );
            return;
          }

          const rawTranscript = await this.stt.transcribe(
            processedAudio,
            signal
          );
          if (signal.aborted) return;

          if (!rawTranscript || rawTranscript.trim().length === 0) {
            sendVoiceJSON(
              connection,
              {
                type: "status",
                status: "listening"
              },
              "VoiceInput"
            );
            return;
          }

          userText = await this.afterTranscribe(rawTranscript, connection);
        }

        if (!userText || signal.aborted) {
          sendVoiceJSON(
            connection,
            { type: "status", status: "listening" },
            "VoiceInput"
          );
          return;
        }

        // Emit the transcript and go straight back to listening
        await this.#emitTranscript(connection, userText);
      } catch (error) {
        if (signal.aborted) return;
        console.error("[VoiceInput] STT pipeline error:", error);
        sendVoiceJSON(
          connection,
          {
            type: "error",
            message:
              error instanceof Error ? error.message : "Voice input failed"
          },
          "VoiceInput"
        );
        sendVoiceJSON(
          connection,
          { type: "status", status: "listening" },
          "VoiceInput"
        );
      } finally {
        this.#cm.clearPipelineAbort(connection.id);
      }
    }

    /**
     * Send the user transcript to the client and call the onTranscript hook.
     * Then immediately return to listening — no LLM/TTS pipeline.
     */
    async #emitTranscript(connection: Connection, text: string) {
      // Clear interim transcript
      sendVoiceJSON(
        connection,
        {
          type: "transcript_interim",
          text: ""
        },
        "VoiceInput"
      );

      // Send the final user transcript
      sendVoiceJSON(
        connection,
        {
          type: "transcript",
          role: "user",
          text
        },
        "VoiceInput"
      );

      // Call the user hook
      try {
        await this.onTranscript(text, connection);
      } catch (err) {
        console.error("[VoiceInput] onTranscript error:", err);
      }

      // Back to listening immediately
      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );
    }
  }

  return VoiceInputMixin;
}
