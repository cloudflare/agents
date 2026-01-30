import RealtimeKitClient from "@cloudflare/realtimekit";
import { REALTIME_AGENTS_SERVICE } from "./api";

export enum DataKind {
  Text = "TEXT",
  Media = "MEDIA",
  Audio = "AUDIO"
}

export interface RealtimePipelineComponent {
  name: string;
  input_kind(): DataKind;
  output_kind(): DataKind;
  schema(): { name: string; type: string; [K: string]: unknown };
  validate(): void;
}

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

  constructor(config: RealtimeKitMeetingConfig) {
    this.meetingId = config.meetingId;

    this.#authToken = config.authToken;
    this.filters =
      config.filters ??
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

  validate(): void {
    // RealtimeKit doesn't require validation as auth is handled separately
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

export class DeepgramSTT implements RealtimePipelineComponent {
  constructor(
    private gatewayId?: string,
    private apiKey?: string,
    private readonly config?: { language?: string; model?: string }
  ) {
    this.gatewayId = gatewayId;
    this.apiKey = apiKey;
    this.config = config;
  }

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

  validate(): void {
    if (!this.gatewayId && !this.apiKey) {
      throw new Error(
        "DeepgramSTT: Either gatewayId or apiKey must be provided"
      );
    }
  }

  schema() {
    const provider: Record<string, unknown> = {};

    if (this.gatewayId) {
      provider.gateway_id = this.gatewayId;
    }
    if (this.apiKey) {
      provider.api_key = this.apiKey;
    }

    return {
      name: this.name,
      type: "speech_to_text",
      provider: {
        deepgram: {
          ...provider,
          ...this.config
        }
      }
    };
  }
}

export class ElevenLabsTTS implements RealtimePipelineComponent {
  constructor(
    private gatewayId?: string,
    private apiKey?: string,
    private readonly config?: {
      model?: string;
      voice_id?: string;
      language_code?: string;
    }
  ) {
    this.gatewayId = gatewayId;
    this.apiKey = apiKey;
  }

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

  validate(): void {
    if (!this.gatewayId && !this.apiKey) {
      throw new Error(
        "ElevenLabsTTS: Either gatewayId or apiKey must be provided"
      );
    }
  }

  schema() {
    const provider: Record<string, unknown> = {};

    if (this.gatewayId) {
      provider.gateway_id = this.gatewayId;
    }
    if (this.apiKey) {
      provider.api_key = this.apiKey;
    }

    return {
      name: this.name,
      type: "text_to_speech",
      provider: {
        elevenlabs: {
          ...provider,
          ...this.config
        }
      }
    };
  }
}
