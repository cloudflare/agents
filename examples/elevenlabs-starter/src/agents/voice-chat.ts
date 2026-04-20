import { createWorkersAI } from "workers-ai-provider";
import { callable, type Connection } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, pruneMessages } from "ai";
import { createClient, streamToDataUri } from "../lib/elevenlabs";

export interface VoiceChatState {
  voiceId: string;
}

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

// Workers can't use wss:// in fetch — use https:// with Upgrade header instead
const STT_URL =
  "https://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000";

export class VoiceChatAgent extends AIChatAgent<Env, VoiceChatState> {
  maxPersistedMessages = 50;

  initialState: VoiceChatState = {
    voiceId: DEFAULT_VOICE_ID
  };

  // Outbound WebSocket to ElevenLabs Realtime STT, active while the user is recording
  #sttSocket: WebSocket | null = null;

  /** Open a WebSocket to ElevenLabs Realtime STT. The browser sends PCM chunks via onMessage. */
  @callable()
  async startTranscription() {
    if (this.#sttSocket) {
      this.#sttSocket.close();
      this.#sttSocket = null;
    }

    // fetch() with Upgrade: websocket is the Workers-native way to open an outbound WS
    const resp = await fetch(STT_URL, {
      headers: {
        Upgrade: "websocket",
        "xi-api-key": this.env.ELEVENLABS_API_KEY
      }
    });

    const ws = resp.webSocket;
    if (!ws) throw new Error("WebSocket upgrade failed");
    ws.accept();
    this.#sttSocket = ws;

    // Relay transcripts from ElevenLabs back to all connected browsers
    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        const msgType: string = data.message_type;

        if (
          msgType === "partial_transcript" ||
          msgType === "committed_transcript"
        ) {
          this.broadcast(
            JSON.stringify({
              type: "stt-transcript",
              partial: msgType === "partial_transcript",
              text: data.text ?? ""
            })
          );
        } else if (msgType === "session_started") {
          console.log("STT session started:", data.session_id);
        } else if (msgType.includes("error")) {
          console.error("STT error:", data);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.addEventListener("close", () => {
      this.#sttSocket = null;
    });

    ws.addEventListener("error", () => {
      console.error("STT WebSocket error");
      this.#sttSocket = null;
    });
  }

  /** Commit the final transcript and close the ElevenLabs WebSocket. */
  @callable()
  async stopTranscription() {
    if (!this.#sttSocket) return;
    try {
      this.#sttSocket.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: 16000
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      this.#sttSocket.close();
      this.#sttSocket = null;
    }
  }

  /**
   * Intercept raw WebSocket messages from the browser.
   * Audio chunks (type: "audio-chunk") are forwarded to ElevenLabs.
   * Everything else falls through to AIChatAgent's normal message handling.
   */
  onMessage(_connection: Connection, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);
        if (data.type === "audio-chunk" && this.#sttSocket) {
          this.#sttSocket.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: data.data,
              commit: false,
              sample_rate: 16000
            })
          );
          return;
        }
      } catch {
        // not our message, fall through
      }
    }
  }

  /** Convert text to speech using the user's selected ElevenLabs voice. */
  @callable()
  async speak(text: string): Promise<string> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);
    const audio = await client.textToSpeech.convert(
      this.state.voiceId || DEFAULT_VOICE_ID,
      {
        text,
        modelId: "eleven_flash_v2_5",
        outputFormat: "mp3_44100_128"
      }
    );
    return streamToDataUri(audio);
  }

  /** List available ElevenLabs voices for the voice selector dropdown. */
  @callable()
  async listVoices(): Promise<Array<{ voiceId: string; name: string }>> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);
    const response = await client.voices.search({ pageSize: 30 });
    return (response.voices ?? []).map((v) => ({
      voiceId: v.voiceId ?? "",
      name: v.name ?? "Unknown"
    }));
  }

  /** Persist the user's voice selection in agent state (syncs to all clients). */
  @callable()
  async setVoice(voiceId: string) {
    this.setState({ ...this.state, voiceId });
  }

  /** Handle incoming chat messages — stream a response from Workers AI. */
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6"),
      system:
        "You are a helpful, friendly assistant. Keep your responses concise — they will be read aloud via text-to-speech, so aim for natural spoken language rather than markdown formatting.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}
