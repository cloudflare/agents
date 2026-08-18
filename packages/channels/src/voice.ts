import {
  VOICE_PROTOCOL_VERSION,
  type TTSProvider,
  type VoiceAudioFormat,
  type VoiceServerMessage
} from "@cloudflare/voice";
import type {
  Channel,
  ChannelMessage,
  DeliveryFailure,
  DeliveryResult
} from "./channel";

/** The subset of an Agent WebSocket connection needed for audio delivery. */
export type BrowserVoiceConnection = {
  id: string;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
};

/** Configuration for an output-only browser voice channel. */
export type BrowserVoiceChannelOptions = {
  /** Text-to-speech provider used to synthesize each outbound message. */
  tts: TTSProvider;
  /** Return the browser voice surface to use, or undefined when unavailable. */
  getConnection: () => BrowserVoiceConnection | undefined;
  /** Encoded audio format returned by the TTS provider. @default "mp3" */
  audioFormat?: VoiceAudioFormat;
  /** Sample rate for raw PCM audio. Ignored by encoded formats. @default 16000 */
  sampleRate?: number;
  /** Project the canonical Markdown message into text suitable for speech. */
  toSpeechText?: (message: ChannelMessage) => string;
};

const DEFAULT_SAMPLE_RATE = 16_000;

function unavailable(): DeliveryResult {
  return {
    status: "failed",
    retryable: true,
    error: {
      code: "BROWSER_VOICE_UNAVAILABLE",
      message: "No browser voice surface is connected"
    }
  };
}

function synthesisFailure(error?: unknown): DeliveryResult {
  const failure: DeliveryFailure = {
    code: "BROWSER_VOICE_TTS_FAILED",
    message:
      error instanceof Error
        ? error.message
        : "The text-to-speech provider did not return audio"
  };
  return { status: "failed", retryable: true, error: failure };
}

function deliveryFailure(
  error: unknown,
  contentDeliveryStarted: boolean
): DeliveryResult {
  if (!contentDeliveryStarted) {
    const connectionClosed =
      error instanceof TypeError &&
      error.message.includes("WebSocket send() after close");
    return {
      status: "failed",
      retryable: true,
      error: {
        code: connectionClosed
          ? "BROWSER_VOICE_CONNECTION_CLOSED"
          : "BROWSER_VOICE_DELIVERY_FAILED",
        message: connectionClosed
          ? "The browser voice surface disconnected before delivery"
          : error instanceof Error
            ? error.message
            : "Browser voice delivery failed before sending content"
      }
    };
  }

  return {
    status: "uncertain",
    error: {
      code: "BROWSER_VOICE_DELIVERY_ERROR",
      message:
        error instanceof Error
          ? error.message
          : "Browser voice delivery failed with an unknown outcome"
    }
  };
}

function sendJSON(
  connection: BrowserVoiceConnection,
  message: VoiceServerMessage
): void {
  connection.send(JSON.stringify(message));
}

/**
 * Create an output-only channel that synthesizes one message and sends its
 * encoded audio to one browser using the Cloudflare Voice wire protocol.
 *
 * The browser should connect with `VoiceClient` or `useVoiceAgent()`. No
 * `withVoice()` mixin, microphone, or speech-to-text provider is required.
 */
export function browserVoice(options: BrowserVoiceChannelOptions): Channel {
  const audioFormat = options.audioFormat ?? "mp3";
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const toSpeechText = options.toSpeechText ?? ((message) => message.markdown);

  return {
    isAvailable() {
      return options.getConnection() !== undefined;
    },

    async deliver(message) {
      const connection = options.getConnection();
      if (!connection) return unavailable();

      let audio: ArrayBuffer | null;
      const speechText = toSpeechText(message);
      try {
        audio = await options.tts.synthesize(speechText);
      } catch (error) {
        return synthesisFailure(error);
      }
      if (!audio) return synthesisFailure();

      let contentDeliveryStarted = false;
      try {
        sendJSON(connection, {
          type: "welcome",
          protocol_version: VOICE_PROTOCOL_VERSION
        });
        sendJSON(connection, {
          type: "audio_config",
          format: audioFormat,
          sampleRate
        });
        sendJSON(connection, { type: "status", status: "speaking" });
        sendJSON(connection, {
          type: "transcript",
          role: "assistant",
          text: speechText
        });
        contentDeliveryStarted = true;
        connection.send(audio);
        sendJSON(connection, { type: "status", status: "idle" });
        return { status: "delivered" };
      } catch (error) {
        return deliveryFailure(error, contentDeliveryStarted);
      }
    }
  };
}
