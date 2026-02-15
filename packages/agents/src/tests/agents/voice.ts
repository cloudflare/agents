import { Agent, type Connection } from "../../index";
import {
  withVoice,
  type VoiceTurnContext
} from "../../experimental/voice/voice";

const VoiceBase = withVoice(Agent);

/**
 * Test VoiceAgent that echoes back the transcript (no real AI).
 * Override STT/TTS/VAD to return deterministic results.
 */
export class TestVoiceAgent extends VoiceBase<Record<string, unknown>> {
  static options = { hibernate: false };

  #callStartCount = 0;
  #callEndCount = 0;
  #interruptCount = 0;
  #beforeCallStartResult = true;

  async transcribe(_audioData: ArrayBuffer): Promise<string> {
    return "test transcript";
  }

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const buffer = new ArrayBuffer(text.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < text.length; i++) {
      view[i] = text.charCodeAt(i) & 0xff;
    }
    return buffer;
  }

  async checkEndOfTurn(
    _audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }> {
    return { isComplete: true, probability: 1.0 };
  }

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<string> {
    return `Echo: ${transcript}`;
  }

  beforeCallStart(_connection: Connection): boolean {
    return this.#beforeCallStartResult;
  }

  onCallStart(_connection: Connection) {
    this.#callStartCount++;
  }

  onCallEnd(_connection: Connection) {
    this.#callEndCount++;
  }

  onInterrupt(_connection: Connection) {
    this.#interruptCount++;
  }

  getCallStartCount(): number {
    return this.#callStartCount;
  }

  getCallEndCount(): number {
    return this.#callEndCount;
  }

  getInterruptCount(): number {
    return this.#interruptCount;
  }

  setBeforeCallStartResult(result: boolean) {
    this.#beforeCallStartResult = result;
  }

  getMessageCount(): number {
    return (
      this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_voice_messages
    `[0]?.count ?? 0
    );
  }
}
