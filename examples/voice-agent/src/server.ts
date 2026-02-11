import {
  Agent,
  type Connection,
  type WSMessage,
  routeAgentRequest
} from "agents";

/**
 * Audio protocol:
 * - Binary WebSocket messages = PCM audio (16kHz, mono, 16-bit signed LE)
 * - Text WebSocket messages = JSON control/status messages
 *
 * Client → Server JSON:
 *   { type: "start_call" }     — begin voice session
 *   { type: "end_call" }       — end voice session
 *   { type: "end_of_speech" }  — client detected silence, process the audio buffer
 *
 * Server → Client JSON:
 *   { type: "status", status: "idle" | "listening" | "thinking" | "speaking" }
 *   { type: "transcript", role: "user" | "assistant", text: string }
 *   { type: "error", message: string }
 *
 * Server → Client Binary:
 *   MP3 audio for playback
 */

type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface VoiceAgentState {
  status: VoiceStatus;
  transcript: TranscriptEntry[];
}

export class VoiceAgent extends Agent<Env, VoiceAgentState> {
  initialState: VoiceAgentState = {
    status: "idle",
    transcript: []
  };

  // Per-connection audio buffers (not persisted — lives only during active call)
  #audioBuffers = new Map<string, ArrayBuffer[]>();

  onConnect(connection: Connection) {
    console.log(`[VoiceAgent] Client connected: ${connection.id}`);
    // Send current state to newly connected client
    this.sendJSON(connection, { type: "status", status: this.state.status });
  }

  onClose(connection: Connection) {
    console.log(`[VoiceAgent] Client disconnected: ${connection.id}`);
    this.#audioBuffers.delete(connection.id);
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (message instanceof ArrayBuffer) {
      this.handleAudioChunk(connection, message);
      return;
    }

    // Text messages are JSON control messages
    if (typeof message !== "string") {
      console.log(
        `[VoiceAgent] Non-string, non-binary message from ${connection.id}:`,
        typeof message
      );
      return;
    }

    let parsed: { type: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      console.log(
        `[VoiceAgent] Non-JSON text message from ${connection.id}:`,
        message.slice(0, 100)
      );
      return;
    }

    console.log(
      `[VoiceAgent] JSON message from ${connection.id}:`,
      parsed.type
    );

    switch (parsed.type) {
      case "start_call":
        this.handleStartCall(connection);
        break;
      case "end_call":
        this.handleEndCall(connection);
        break;
      case "end_of_speech":
        this.handleEndOfSpeech(connection);
        break;
      default:
        console.log(`[VoiceAgent] Unknown message type: ${parsed.type}`);
    }
  }

  // --- Call lifecycle ---

  handleStartCall(connection: Connection) {
    console.log(`[VoiceAgent] Starting call for ${connection.id}`);
    this.#audioBuffers.set(connection.id, []);
    this.setStatus("listening");
    this.sendJSON(connection, { type: "status", status: "listening" });
    console.log(`[VoiceAgent] Call started, status: listening`);
  }

  handleEndCall(connection: Connection) {
    console.log(`[VoiceAgent] Ending call for ${connection.id}`);
    this.#audioBuffers.delete(connection.id);
    this.setStatus("idle");
    this.sendJSON(connection, { type: "status", status: "idle" });
    console.log(`[VoiceAgent] Call ended, status: idle`);
  }

  // --- Audio handling ---

  handleAudioChunk(connection: Connection, chunk: ArrayBuffer) {
    const buffer = this.#audioBuffers.get(connection.id);
    if (!buffer) {
      // First few are noisy, only log occasionally
      if (Math.random() < 0.01) {
        console.log(
          `[VoiceAgent] Received audio but no active call for ${connection.id}`
        );
      }
      return;
    }
    buffer.push(chunk);
    // Log every ~50 chunks (~5s of audio) to avoid spam
    if (buffer.length % 50 === 0) {
      const totalBytes = buffer.reduce((s, b) => s + b.byteLength, 0);
      console.log(
        `[VoiceAgent] Audio buffer: ${buffer.length} chunks, ${(totalBytes / 1024).toFixed(1)} KB`
      );
    }
  }

  async handleEndOfSpeech(connection: Connection) {
    const chunks = this.#audioBuffers.get(connection.id);
    if (!chunks || chunks.length === 0) {
      console.log(
        `[VoiceAgent] end_of_speech but no audio chunks for ${connection.id}`
      );
      return;
    }

    // Grab the audio and reset the buffer for next utterance
    const audioData = this.concatenateBuffers(chunks);
    this.#audioBuffers.set(connection.id, []);

    console.log(
      `[VoiceAgent] End of speech: ${chunks.length} chunks, ${(audioData.byteLength / 1024).toFixed(1)} KB of audio`
    );

    // Skip very short audio (< 0.5s at 16kHz mono 16-bit = 16000 bytes)
    if (audioData.byteLength < 16000) {
      console.log(
        `[VoiceAgent] Audio too short (${audioData.byteLength} bytes), skipping`
      );
      this.sendJSON(connection, { type: "status", status: "listening" });
      return;
    }

    this.setStatus("thinking");
    this.sendJSON(connection, { type: "status", status: "thinking" });

    try {
      // 1. Speech-to-text
      console.log(`[VoiceAgent] Running STT...`);
      const sttStart = Date.now();
      const transcript = await this.transcribe(audioData);
      console.log(
        `[VoiceAgent] STT done in ${Date.now() - sttStart}ms: "${transcript}"`
      );

      if (!transcript || transcript.trim().length === 0) {
        console.log(`[VoiceAgent] Empty transcript, back to listening`);
        this.setStatus("listening");
        this.sendJSON(connection, { type: "status", status: "listening" });
        return;
      }

      // Send user transcript to client
      const userEntry: TranscriptEntry = {
        role: "user",
        text: transcript,
        timestamp: Date.now()
      };
      this.sendJSON(connection, {
        type: "transcript",
        role: "user",
        text: transcript
      });

      // 2. LLM response
      console.log(`[VoiceAgent] Running LLM...`);
      const llmStart = Date.now();
      const response = await this.generateResponse(transcript);
      console.log(
        `[VoiceAgent] LLM done in ${Date.now() - llmStart}ms: "${response.slice(0, 100)}..."`
      );

      const assistantEntry: TranscriptEntry = {
        role: "assistant",
        text: response,
        timestamp: Date.now()
      };

      // Update persisted transcript
      this.setState({
        ...this.state,
        transcript: [...this.state.transcript, userEntry, assistantEntry]
      });

      // Send assistant transcript to client
      this.sendJSON(connection, {
        type: "transcript",
        role: "assistant",
        text: response
      });

      // 3. Text-to-speech
      console.log(`[VoiceAgent] Running TTS...`);
      const ttsStart = Date.now();
      this.setStatus("speaking");
      this.sendJSON(connection, { type: "status", status: "speaking" });

      const audioResponse = await this.synthesize(response);
      console.log(
        `[VoiceAgent] TTS done in ${Date.now() - ttsStart}ms, audio: ${audioResponse ? `${(audioResponse.byteLength / 1024).toFixed(1)} KB` : "null"}`
      );

      if (audioResponse) {
        console.log(
          `[VoiceAgent] Sending ${(audioResponse.byteLength / 1024).toFixed(1)} KB audio to client`
        );
        // Send audio as binary WebSocket message
        connection.send(audioResponse);
      } else {
        console.log(`[VoiceAgent] No audio to send`);
      }

      // Back to listening
      this.setStatus("listening");
      this.sendJSON(connection, { type: "status", status: "listening" });
      console.log(
        `[VoiceAgent] Pipeline complete, total: ${Date.now() - sttStart}ms`
      );
    } catch (error) {
      console.error("[VoiceAgent] Pipeline error:", error);
      this.sendJSON(connection, {
        type: "error",
        message:
          error instanceof Error ? error.message : "Voice pipeline failed"
      });
      this.setStatus("listening");
      this.sendJSON(connection, { type: "status", status: "listening" });
    }
  }

  // --- AI Pipeline ---

  async transcribe(audioData: ArrayBuffer): Promise<string> {
    // Build a WAV file from raw PCM so the model knows the format
    const wavBuffer = this.pcmToWav(audioData, 16000, 1, 16);
    console.log(
      `[VoiceAgent] STT input: ${(wavBuffer.byteLength / 1024).toFixed(1)} KB WAV (${(audioData.byteLength / 32000).toFixed(1)}s of audio)`
    );

    // Wrap the WAV buffer in a ReadableStream — the AI binding expects
    // audio.body to be a ReadableStream (like fetch().body), not an ArrayBuffer
    const wavStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(wavBuffer));
        controller.close();
      }
    });

    const result = (await this.env.AI.run("@cf/deepgram/nova-3", {
      audio: {
        body: wavStream,
        contentType: "audio/wav"
      },
      language: "en",
      punctuate: true,
      smart_format: true
    })) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
          }>;
        }>;
      };
    };

    console.log(
      `[VoiceAgent] STT raw response:`,
      JSON.stringify(result).slice(0, 500)
    );

    // Extract transcript from Deepgram response
    const transcript =
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return transcript;
  }

  async generateResponse(userMessage: string): Promise<string> {
    // Build conversation context from recent transcript
    const recentMessages = this.state.transcript.slice(-10);
    const contextMessages = recentMessages.map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.text
    }));

    const result = (await (
      this.env.AI as {
        run: (model: string, input: unknown) => Promise<unknown>;
      }
    ).run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content: `You are a helpful voice assistant. Keep your responses concise and conversational — you're being spoken aloud, not read. Aim for 1-3 sentences unless the user asks for more detail. Be warm and natural.`
        },
        ...contextMessages,
        { role: "user", content: userMessage }
      ]
    })) as { response?: string };

    return result?.response ?? "Sorry, I couldn't generate a response.";
  }

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    console.log(
      `[VoiceAgent] TTS input: "${text.slice(0, 100)}..." (${text.length} chars)`
    );
    try {
      const response = (await this.env.AI.run(
        "@cf/deepgram/aura-1",
        {
          text,
          speaker: "asteria"
        },
        { returnRawResponse: true }
      )) as Response;

      console.log(
        `[VoiceAgent] TTS response status: ${response.status}, content-type: ${response.headers.get("content-type")}`
      );
      const buf = await response.arrayBuffer();
      console.log(
        `[VoiceAgent] TTS output: ${(buf.byteLength / 1024).toFixed(1)} KB`
      );
      return buf;
    } catch (error) {
      console.error("[VoiceAgent] TTS error:", error);
      return null;
    }
  }

  // --- Helpers ---

  setStatus(status: VoiceStatus) {
    this.setState({ ...this.state, status });
  }

  sendJSON(connection: Connection, data: unknown) {
    connection.send(JSON.stringify(data));
  }

  concatenateBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
    const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      result.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    return result.buffer;
  }

  /**
   * Wraps raw PCM data in a WAV header.
   * This lets the STT model know the sample rate, bit depth, and channel count.
   */
  pcmToWav(
    pcmData: ArrayBuffer,
    sampleRate: number,
    channels: number,
    bitsPerSample: number
  ): ArrayBuffer {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = pcmData.byteLength;
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, "WAVE");

    // fmt chunk
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    this.writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    // Copy PCM data
    new Uint8Array(buffer, headerSize).set(new Uint8Array(pcmData));

    return buffer;
  }

  writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    console.log(`[Worker] ${request.method} ${url.pathname}`);
    const resp = await routeAgentRequest(request, env);
    if (resp) {
      console.log(`[Worker] Routed to agent, status: ${resp.status}`);
      return resp;
    }
    console.log(`[Worker] No agent route matched`);
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
