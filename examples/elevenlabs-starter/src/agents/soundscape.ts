import { createWorkersAI } from "workers-ai-provider";
import { Agent, callable } from "agents";
import { generateText } from "ai";
import { createClient, streamToDataUri } from "../lib/elevenlabs";

export interface SoundEffect {
  id: string;
  prompt: string;
  audio: string; // base64 data URI
}

export interface Scene {
  id: string;
  name: string;
  narrationText: string;
  narrationAudio?: string;
  effects: SoundEffect[];
}

export interface SoundscapeState {
  scenes: Scene[];
}

/**
 * Soundscape Builder agent — no chat, just @callable RPC methods.
 * The client orchestrates the multi-step generation: expand → narrate → SFX.
 */
export class SoundscapeAgent extends Agent<Env, SoundscapeState> {
  initialState: SoundscapeState = { scenes: [] };

  /** Use Workers AI to expand a scene description into narration + SFX prompts. */
  @callable()
  async expandScene(
    description: string
  ): Promise<{ narration: string; effects: string[] }> {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const { text } = await generateText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      prompt: `You are a sound designer. Given this scene description, produce:
1. A short narration (2-3 sentences) that sets the scene for a listener.
2. A list of 3-4 distinct ambient sound effects that would bring this scene to life. Each description should be 3-8 words, specific enough for a sound effects generator.

Scene: "${description}"

Respond with ONLY valid JSON, no markdown fences:
{"narration": "...", "effects": ["...", "...", "..."]}`
    });

    try {
      const cleaned = text.replace(/```[\s\S]*?```/g, "").trim();
      const jsonStr =
        cleaned.match(/\{[\s\S]*\}/)?.[0] ??
        `{"narration":"${description}","effects":["${description}"]}`;
      return JSON.parse(jsonStr);
    } catch {
      return {
        narration: `Welcome to: ${description}. Close your eyes and listen.`,
        effects: [description]
      };
    }
  }

  /** Generate narration audio via ElevenLabs TTS. */
  @callable()
  async generateNarration(text: string): Promise<string> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);
    const audio = await client.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
      text,
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128"
    });
    return streamToDataUri(audio);
  }

  /** Generate a sound effect via ElevenLabs Text-to-Sound-Effects API. */
  @callable()
  async generateEffect(prompt: string): Promise<string> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);
    const audio = await client.textToSoundEffects.convert({
      text: prompt,
      durationSeconds: 10,
      promptInfluence: 0.5
    });
    return streamToDataUri(audio);
  }

  /** Save a completed scene to agent state (persisted in SQLite, synced to clients). */
  @callable()
  async saveScene(scene: Scene) {
    this.setState({
      ...this.state,
      scenes: [...this.state.scenes, scene]
    });
  }

  @callable()
  async deleteScene(id: string) {
    this.setState({
      ...this.state,
      scenes: this.state.scenes.filter((s) => s.id !== id)
    });
  }
}
