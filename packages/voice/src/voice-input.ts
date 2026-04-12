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
import { VOICE_PROTOCOL_VERSION } from "./types";
import type { Transcriber } from "./types";
import { AudioConnectionManager, sendVoiceJSON } from "./audio-pipeline";

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<Pick<Agent<Cloudflare.Env>, "keepAlive">>;

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
  Base: TBase
): VoiceInputMixinReturn<TBase> {
  class VoiceInputMixin extends Base {
    /** Continuous transcriber provider. */
    transcriber?: Transcriber;

    #cm = new AudioConnectionManager("VoiceInput");
    #keepAliveDispose = new Map<string, () => void>();

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
              this.#handleStartCall(connection);
              break;
            case "end_call":
              this.#handleEndCall(connection);
              break;
            case "start_of_speech":
            case "end_of_speech":
              break;
            case "interrupt":
              this.#handleInterrupt(connection);
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

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection) {
      if (this.#cm.isInCall(connection.id)) return;

      const allowed = await this.beforeCallStart(connection);
      if (!allowed) return;

      const provider = this.createTranscriber(connection) ?? this.transcriber;
      if (!provider) {
        throw new Error(
          "No transcriber configured. Set 'transcriber' on your VoiceInput subclass or override createTranscriber()."
        );
      }

      this.#cm.initConnection(connection.id);

      const dispose = await this.keepAlive();
      this.#keepAliveDispose.set(connection.id, dispose);

      this.#cm.startTranscriberSession(connection.id, provider, {
        onInterim: (text: string) => {
          sendVoiceJSON(
            connection,
            { type: "transcript_interim", text },
            "VoiceInput"
          );
        },
        onUtterance: (transcript: string) => {
          this.#emitTranscript(connection, transcript);
        }
      });

      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );

      await this.onCallStart(connection);
    }

    #releaseKeepAlive(connectionId: string) {
      const dispose = this.#keepAliveDispose.get(connectionId);
      if (dispose) {
        dispose();
        this.#keepAliveDispose.delete(connectionId);
      }
    }

    #handleEndCall(connection: Connection) {
      this.#cm.cleanup(connection.id);
      this.#releaseKeepAlive(connection.id);
      sendVoiceJSON(
        connection,
        { type: "status", status: "idle" },
        "VoiceInput"
      );
      this.onCallEnd(connection);
    }

    #handleInterrupt(connection: Connection) {
      this.#cm.abortPipeline(connection.id);
      this.#cm.clearAudioBuffer(connection.id);
      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );
      this.onInterrupt(connection);
    }

    // --- Internal: transcript emission ---

    async #emitTranscript(connection: Connection, transcript: string) {
      const userText = await this.afterTranscribe(transcript, connection);
      if (!userText) return;

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

      try {
        await this.onTranscript(userText, connection);
      } catch (err) {
        console.error("[VoiceInput] onTranscript error:", err);
      }

      sendVoiceJSON(
        connection,
        { type: "status", status: "listening" },
        "VoiceInput"
      );
    }
  }

  return VoiceInputMixin as unknown as VoiceInputMixinReturn<TBase>;
}
