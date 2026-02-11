import { PartySocket } from "partysocket";
import { camelCaseToKebabCase } from "./utils";

// --- Public types ---

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

export interface PipelineMetrics {
  vad_ms: number;
  stt_ms: number;
  llm_ms: number;
  tts_ms: number;
  first_audio_ms: number;
  total_ms: number;
}

export interface VoiceClientOptions {
  /** Agent name (matches the server-side Durable Object class). */
  agent: string;
  /** Instance name for the agent. @default "default" */
  name?: string;

  // Connection options (optional — defaults work for same-origin)
  /** Host to connect to. @default window.location.host */
  host?: string;

  // Tuning knobs with sensible defaults
  /** RMS threshold below which audio is considered silence. @default 0.01 */
  silenceThreshold?: number;
  /** How long silence must last before sending end_of_speech (ms). @default 500 */
  silenceDurationMs?: number;
  /** RMS threshold for detecting user speech during agent playback. @default 0.02 */
  interruptThreshold?: number;
  /** Consecutive high-RMS chunks needed to trigger an interrupt. @default 2 */
  interruptChunks?: number;
}

export type VoiceClientEvent =
  | "statuschange"
  | "transcriptchange"
  | "metricschange"
  | "audiolevelchange"
  | "connectionchange"
  | "error"
  | "mutechange";

// --- Audio helpers (not exported) ---

const WORKLET_PROCESSOR = `
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sampleRate = sampleRate;
    this.targetRate = 16000;
    this.ratio = this.sampleRate / this.targetRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    for (let i = 0; i < channelData.length; i += this.ratio) {
      const idx = Math.floor(i);
      if (idx < channelData.length) {
        this.buffer.push(channelData[idx]);
      }
    }

    if (this.buffer.length >= 1600) {
      const chunk = new Float32Array(this.buffer);
      this.port.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
      this.buffer = [];
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
`;

function floatTo16BitPCM(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// --- VoiceClient ---

type Listener = () => void;

export class VoiceClient {
  // Internal state
  #status: VoiceStatus = "idle";
  #transcript: TranscriptMessage[] = [];
  #metrics: PipelineMetrics | null = null;
  #audioLevel = 0;
  #isMuted = false;
  #connected = false;
  #error: string | null = null;

  // Options (with defaults applied)
  #silenceThreshold: number;
  #silenceDurationMs: number;
  #interruptThreshold: number;
  #interruptChunks: number;

  // WebSocket
  #socket: PartySocket | null = null;
  #options: VoiceClientOptions;

  // Audio refs
  #audioContext: AudioContext | null = null;
  #workletNode: AudioWorkletNode | null = null;
  #stream: MediaStream | null = null;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #isSpeaking = false;
  #playbackQueue: ArrayBuffer[] = [];
  #isPlaying = false;
  #activeSource: AudioBufferSourceNode | null = null;
  #interruptChunkCount = 0;

  // Event listeners
  #listeners = new Map<VoiceClientEvent, Set<Listener>>();

  constructor(options: VoiceClientOptions) {
    this.#options = options;
    this.#silenceThreshold = options.silenceThreshold ?? 0.01;
    this.#silenceDurationMs = options.silenceDurationMs ?? 500;
    this.#interruptThreshold = options.interruptThreshold ?? 0.02;
    this.#interruptChunks = options.interruptChunks ?? 2;
  }

  // --- Public getters ---

  get status(): VoiceStatus {
    return this.#status;
  }

  get transcript(): TranscriptMessage[] {
    return this.#transcript;
  }

  get metrics(): PipelineMetrics | null {
    return this.#metrics;
  }

  get audioLevel(): number {
    return this.#audioLevel;
  }

  get isMuted(): boolean {
    return this.#isMuted;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get error(): string | null {
    return this.#error;
  }

  // --- Event system ---

  addEventListener(event: VoiceClientEvent, listener: Listener): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
  }

  removeEventListener(event: VoiceClientEvent, listener: Listener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  #emit(event: VoiceClientEvent): void {
    const set = this.#listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener();
      }
    }
  }

  // --- Connection ---

  connect(): void {
    if (this.#socket) return;

    const agentNamespace = camelCaseToKebabCase(this.#options.agent);

    const socket = new PartySocket({
      party: agentNamespace,
      room: this.#options.name ?? "default",
      host: this.#options.host ?? window.location.host,
      prefix: "agents"
    });

    socket.onopen = () => {
      this.#connected = true;
      this.#error = null;
      this.#emit("connectionchange");
      this.#emit("error");
    };

    socket.onclose = () => {
      this.#connected = false;
      this.#emit("connectionchange");
    };

    socket.onerror = () => {
      this.#error = "Connection lost. Reconnecting...";
      this.#emit("error");
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.#handleJSONMessage(event.data);
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          this.#playbackQueue.push(buffer);
          this.#processPlaybackQueue();
        });
      } else if (event.data instanceof ArrayBuffer) {
        this.#playbackQueue.push(event.data);
        this.#processPlaybackQueue();
      }
    };

    this.#socket = socket;
  }

  disconnect(): void {
    this.endCall();
    this.#socket?.close();
    this.#socket = null;
    this.#connected = false;
    this.#emit("connectionchange");
  }

  // --- Public actions ---

  async startCall(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#error = null;
      this.#metrics = null;
      this.#emit("error");
      this.#emit("metricschange");
      this.#socket.send(JSON.stringify({ type: "start_call" }));
      await this.#startMic();
    }
  }

  endCall(): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "end_call" }));
    }
    this.#stopMic();
    this.#activeSource?.stop();
    this.#activeSource = null;
    this.#playbackQueue = [];
    this.#isPlaying = false;
    this.#closeAudioContext();
    this.#status = "idle";
    this.#emit("statuschange");
  }

  toggleMute(): void {
    this.#isMuted = !this.#isMuted;
    this.#emit("mutechange");
  }

  // --- Voice protocol handler ---

  #handleJSONMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "status":
          this.#status = msg.status;
          if (msg.status === "listening" || msg.status === "idle") {
            this.#error = null;
            this.#emit("error");
          }
          this.#emit("statuschange");
          break;
        case "transcript":
          this.#transcript = [
            ...this.#transcript,
            { role: msg.role, text: msg.text, timestamp: Date.now() }
          ];
          this.#emit("transcriptchange");
          break;
        case "transcript_start":
          this.#transcript = [
            ...this.#transcript,
            { role: "assistant", text: "", timestamp: Date.now() }
          ];
          this.#emit("transcriptchange");
          break;
        case "transcript_delta": {
          if (this.#transcript.length === 0) break;
          const updated = [...this.#transcript];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = {
              ...last,
              text: last.text + msg.text
            };
            this.#transcript = updated;
            this.#emit("transcriptchange");
          }
          break;
        }
        case "transcript_end": {
          if (this.#transcript.length === 0) break;
          const updated = [...this.#transcript];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = { ...last, text: msg.text };
            this.#transcript = updated;
            this.#emit("transcriptchange");
          }
          break;
        }
        case "metrics":
          this.#metrics = {
            vad_ms: msg.vad_ms,
            stt_ms: msg.stt_ms,
            llm_ms: msg.llm_ms,
            tts_ms: msg.tts_ms,
            first_audio_ms: msg.first_audio_ms,
            total_ms: msg.total_ms
          };
          this.#emit("metricschange");
          break;
        case "error":
          this.#error = msg.message;
          this.#emit("error");
          break;
      }
    } catch {
      // ignore non-JSON messages (state sync etc.)
    }
  }

  // --- Audio context management ---

  /** Get or create the shared AudioContext. */
  async #getAudioContext(): Promise<AudioContext> {
    if (!this.#audioContext) {
      this.#audioContext = new AudioContext({ sampleRate: 48000 });
    }
    if (this.#audioContext.state === "suspended") {
      await this.#audioContext.resume();
    }
    return this.#audioContext;
  }

  /** Close the AudioContext and release resources. */
  #closeAudioContext(): void {
    if (this.#audioContext) {
      this.#audioContext.close().catch(() => {});
      this.#audioContext = null;
    }
  }

  // --- Audio playback ---

  async #playAudio(mp3Data: ArrayBuffer): Promise<void> {
    try {
      const ctx = await this.#getAudioContext();

      const audioBuffer = await ctx.decodeAudioData(mp3Data.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      this.#activeSource = source;

      return new Promise<void>((resolve) => {
        source.onended = () => {
          if (this.#activeSource === source) {
            this.#activeSource = null;
          }
          resolve();
        };
        source.start();
      });
    } catch (err) {
      console.error("[VoiceClient] Audio playback error:", err);
    }
  }

  async #processPlaybackQueue(): Promise<void> {
    if (this.#isPlaying || this.#playbackQueue.length === 0) return;
    this.#isPlaying = true;

    while (this.#playbackQueue.length > 0) {
      const audioData = this.#playbackQueue.shift()!;
      await this.#playAudio(audioData);
    }

    this.#isPlaying = false;
  }

  // --- Mic capture ---

  async #startMic(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.#stream = stream;

      const ctx = await this.#getAudioContext();

      const blob = new Blob([WORKLET_PROCESSOR], {
        type: "application/javascript"
      });
      const workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, "audio-capture-processor");
      this.#workletNode = workletNode;

      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "audio" && !this.#isMuted) {
          const samples = event.data.samples as Float32Array;
          const rms = computeRMS(samples);
          this.#audioLevel = rms;
          this.#emit("audiolevelchange");

          // Send PCM to agent
          const pcm = floatTo16BitPCM(samples);
          if (this.#socket?.readyState === WebSocket.OPEN) {
            this.#socket.send(pcm);
          }

          // Interruption detection: user speaking during agent playback
          if (this.#isPlaying && rms > this.#interruptThreshold) {
            this.#interruptChunkCount++;
            if (this.#interruptChunkCount >= this.#interruptChunks) {
              this.#activeSource?.stop();
              this.#activeSource = null;
              this.#playbackQueue = [];
              this.#isPlaying = false;
              this.#interruptChunkCount = 0;
              if (this.#socket?.readyState === WebSocket.OPEN) {
                this.#socket.send(JSON.stringify({ type: "interrupt" }));
              }
            }
          } else {
            this.#interruptChunkCount = 0;
          }

          // Silence detection
          if (rms > this.#silenceThreshold) {
            this.#isSpeaking = true;
            if (this.#silenceTimer) {
              clearTimeout(this.#silenceTimer);
              this.#silenceTimer = null;
            }
          } else if (this.#isSpeaking) {
            if (!this.#silenceTimer) {
              this.#silenceTimer = setTimeout(
                () => {
                  this.#isSpeaking = false;
                  this.#silenceTimer = null;
                  if (this.#socket?.readyState === WebSocket.OPEN) {
                    this.#socket.send(
                      JSON.stringify({ type: "end_of_speech" })
                    );
                  }
                },
                this.#silenceDurationMs
              );
            }
          }
        }
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination);
    } catch (err) {
      console.error("[VoiceClient] Mic error:", err);
      this.#error =
        "Microphone access denied. Please allow microphone access and try again.";
      this.#emit("error");
    }
  }

  #stopMic(): void {
    this.#workletNode?.disconnect();
    this.#workletNode = null;
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    if (this.#silenceTimer) {
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = null;
    }
    this.#isSpeaking = false;
    this.#audioLevel = 0;
    this.#emit("audiolevelchange");
  }
}
