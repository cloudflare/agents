import RealtimeKitClient from "@cloudflare/realtimekit";
import { REALTIME_AGENTS_SERVICE } from "./api";
export type { RealtimeKitClient };

export enum DataKind {
  Text = "TEXT",
  Media = "MEDIA",
  Audio = "AUDIO"
}

export type RealtimePipelineComponent = {
  name: string;
  input_kind(): DataKind;
  output_kind(): DataKind;
  schema(): { name: string; type: string; [K: string]: unknown };
} & { setGatewayId?: (gatewayId: string) => void };

export interface RealtimeKitMeetingConfig {
  meetingId?: string;
  authToken?: string;
  filters?: RealtimeKitMediaFilter[];
}

export type RealtimeKitMediaFilter =
  | {
      media_kind: "audio";
      stream_kind: "screenshare" | "microphone";
      preset_name: string;
    }
  | {
      media_kind: "video";
      stream_kind: "screenshare" | "webcam";
      preset_name: string;
    };

export class RealtimeKitTransport implements RealtimePipelineComponent {
  #meeting?: RealtimeKitClient;
  meetingId?: string;
  #authToken?: string;
  readonly filters: RealtimeKitMediaFilter[];

  constructor(config?: RealtimeKitMeetingConfig) {
    this.meetingId = config?.meetingId;

    this.#authToken = config?.authToken;
    this.filters =
      config?.filters ??
      ([
        { media_kind: "audio", stream_kind: "microphone", preset_name: "*" }
      ] as const);
  }

  async init(streamlineToken: string) {
    if (!this.#authToken) {
      throw new Error("RealtimeKit auth token not available");
    }
    const auth = this.#authToken;
    this.#meeting = await RealtimeKitClient.init({
      authToken: auth,
      overrides: {
        socket_server_base: "socket-edge.realtime.cloudflare.com",
        streamline_url: REALTIME_AGENTS_SERVICE,
        streamline_token: streamlineToken
      },
      defaults: { audio: false, video: false }
    });
  }

  get meeting() {
    if (!this.#meeting) throw new Error("RealtimeKit meeting not initialized");
    return this.#meeting;
  }

  get name() {
    return "realtime_kit";
  }

  get authToken(): string | undefined {
    return this.#authToken;
  }

  set authToken(authToken: string) {
    this.#authToken = authToken;
  }

  input_kind() {
    return DataKind.Audio;
  }

  output_kind() {
    return DataKind.Audio;
  }

  schema() {
    const schema: Record<string, unknown> = {
      name: this.name,
      type: "rtk",
      meeting_id: this.meetingId,
      filters: this.filters
    };

    if (this.authToken) {
      schema.auth_token = this.authToken;
    }

    return schema as { name: string; type: string; [K: string]: unknown };
  }
}

export type DeepgramConfig = {
  language?: string;
  model?: string;
  apiKey?: string;
};

export class DeepgramSTT implements RealtimePipelineComponent {
  private gatewayId?: string;

  /**
   * Creates a new DeepgramSTT instance for speech-to-text transcription.
   * @param config - Optional configuration object
   * @param config.language - Language code for transcription
   * @param config.model - Deepgram model to use
   * @param config.apiKey - Deepgram API key for authentication
   */
  constructor(private readonly config?: DeepgramConfig) {}

  setGatewayId(gatewayId: string): void {
    this.gatewayId = gatewayId;
  }

  get name() {
    return "transcription_deepgram";
  }

  input_kind() {
    return DataKind.Audio;
  }

  output_kind() {
    return DataKind.Text;
  }

  schema() {
    return {
      name: this.name,
      type: "speech_to_text",
      provider: {
        deepgram: {
          gateway_id: this.gatewayId,
          model: this.config?.model,
          language: this.config?.language,
          api_key: this.config?.apiKey
        }
      }
    };
  }
}

type ElevenLabsConfig = {
  model?: string;
  voice_id?: string;
  language_code?: string;
  apiKey?: string;
};
export class ElevenLabsTTS implements RealtimePipelineComponent {
  private gatewayId?: string;

  /**
   * Creates a new ElevenLabsTTS instance for text-to-speech synthesis.
   * @param config - Optional configuration object
   * @param config.model - ElevenLabs model to use
   * @param config.voice_id - Voice ID for speech synthesis
   * @param config.language_code - Language code for speech output
   * @param config.apiKey - ElevenLabs API key for authentication
   */
  constructor(private readonly config?: ElevenLabsConfig) {}

  setGatewayId(gatewayId: string): void {
    this.gatewayId = gatewayId;
  }

  get name() {
    return "tts_elevenlabs";
  }

  input_kind() {
    return DataKind.Text;
  }

  output_kind() {
    return DataKind.Audio;
  }

  schema() {
    return {
      name: this.name,
      type: "text_to_speech",
      provider: {
        elevenlabs: {
          gateway_id: this.gatewayId,
          api_key: this.config?.apiKey,
          model: this.config?.model,
          voice_id: this.config?.voice_id,
          language_code: this.config?.language_code
        }
      }
    };
  }
}
