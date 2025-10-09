import { type Connection } from "./";
import RealtimeKitClient from "@cloudflare/realtimekit";

export const REALTIME_AGENTS_SERVICE = "https://agents.realtime.cloudflare.com";
// export const REALTIME_AGENTS_SERVICE = "https://curly-radios-eat.loca.lt";
export const CLOUDFLARE_BASE = "https://api.cloudflare.com";

export enum DataKind {
  Text = "TEXT",
  Media = "MEDIA", // can be audio or image or both
  Audio = "AUDIO"
}

export interface RealtimePipelineComponent {
  name: string;

  input_kind(): DataKind;
  output_kind(): DataKind;

  // schema to be passed to streamline pipeline
  schema(): { name: string; type: string; [K: string]: any };
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

/**
 * RealtimeKit transport component. Takes audio as input and outputs audio
 * @param meetingId RealtimeKit meeting ID
 * @param authToken RealtimeKit auth token
 * @param filters RealtimeKit media filters
 */
export class RealtimeKitTransport implements RealtimePipelineComponent {
  #rtkMeeting?: RealtimeKitClient;
  meetingId: string;
  authToken: string;
  filters?: RealtimeKitMediaFilter[];

  constructor(
    meetingId: string,
    authToken: string,
    filters?: RealtimeKitMediaFilter[]
  ) {
    this.meetingId = meetingId;
    this.authToken = authToken;
    this.filters = filters ?? [
      {
        media_kind: "audio",
        stream_kind: "microphone",
        preset_name: "*"
      }
    ];
  }

  async init(streamlineToken: string) {
    this.#rtkMeeting = await RealtimeKitClient.init({
      authToken: this.authToken,
      overrides: {
        socket_server_base: "socket-edge.realtime.cloudflare.com",
        streamline_url: REALTIME_AGENTS_SERVICE,
        streamline_token: streamlineToken
      },
      defaults: {
        audio: false,
        video: false
      }
    });
    return this.#rtkMeeting.join();
  }

  get meeting() {
    if (!this.#rtkMeeting) throw new Error("meeting not initialized");
    return this.#rtkMeeting;
  }

  get name() {
    return "realtime_kit";
  }

  input_kind() {
    return DataKind.Audio;
  }
  output_kind() {
    return DataKind.Audio;
  }

  schema() {
    return {
      name: this.name,
      type: "rtk",
      meeting_id: this.meetingId,
      auth_token: this.authToken,
      filters: this.filters
    };
  }
}

/**
 * Deepgram STT component. Takes audio as input and outputs streaming text
 * @param api_key Deepgram API key
 * @param config Deepgram config
 */
export class DeepgramSTT implements RealtimePipelineComponent {
  api_key: string;
  config?: { language?: string; model?: string };

  constructor(api_key: string, config?: { language?: string; model?: string }) {
    this.api_key = api_key;
    this.config = config;
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
          api_key: this.api_key,
          ...this.config
        }
      }
    };
  }
}

/**
 * ElevenLabs TTS component. Takes text as input and outputs audio
 * @param api_key ElevenLabs API key
 * @param config ElevenLabs config
 */
export class ElevenLabsTTS implements RealtimePipelineComponent {
  api_key: string;
  config?: { model?: string; voice_id?: string; language_code?: string };

  constructor(
    api_key: string,
    config?: { model?: string; voice_id?: string; language_code?: string }
  ) {
    this.api_key = api_key;
    this.config = config;
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
          api_key: this.api_key,
          ...this.config
        }
      }
    };
  }
}

export abstract class TextProcessor implements RealtimePipelineComponent {
  constructor() {}

  abstract get url(): string;

  abstract onRealtimeTranscript(
    text: string,
    reply: (response: string) => void
  ): void;

  get name() {
    return "text_processor";
  }

  input_kind() {
    return DataKind.Text;
  }

  output_kind() {
    return DataKind.Text;
  }

  schema() {
    return {
      name: this.name,
      type: "text_processor",
      url: this.url
    };
  }
}

export abstract class MediaProcessor implements RealtimePipelineComponent {
  constructor() {}

  abstract onRealtimeMediaFrame(
    frame: Uint8Array,
    reply: (response: Uint8Array) => void
  ): void;

  get name() {
    return "media_processor";
  }

  input_kind() {
    return DataKind.Media;
  }

  output_kind() {
    return DataKind.Media;
  }

  schema() {
    return {
      name: this.name,
      type: "media_processor"
    };
  }
}

export function createRealtimePipeline(
  cb: () => RealtimePipelineComponent[]
): RealtimePipelineComponent[] {
  const components = cb();
  return components;
}

export function isRealtimeInternalWebsocket(ws: Connection): boolean {
  const url = new URL(ws.url);
  return url.hostname === REALTIME_AGENTS_SERVICE.split("://")[1];
}

export async function* processNDJSONStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  leftOverBuffer = ""
) {
  const decoder = new TextDecoder();
  let buffer = leftOverBuffer;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        if (line.startsWith("data: ")) {
          const jsonLine = line.slice(6).trim();
          if (jsonLine === "[DONE]") {
            return; // End of stream
          }
          yield JSON.parse(jsonLine);
        }
      }
    }
  }

  // Handle leftover buffer
  if (buffer.trim()) {
    const lines = buffer.split("\n").filter((line) => line.trim());
    if (lines.length > 1) {
      /**
       * This case usually happens when leftOverBuffer has more than 1 line
       * and the reader returned DONE;
       */
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonLine = line.slice(6).trim();
          if (jsonLine === "[DONE]") {
            return; // End of stream
          }
          yield JSON.parse(jsonLine);
        }
      }
    } else if (buffer.startsWith("data: ")) {
      const jsonLine = buffer.slice(6).trim();
      if (jsonLine === "[DONE]") {
        return; // End of stream
      }
      yield JSON.parse(jsonLine);
    }
  }
}
