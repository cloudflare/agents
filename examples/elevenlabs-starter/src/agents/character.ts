import { createWorkersAI } from "workers-ai-provider";
import { callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  generateText,
  convertToModelMessages,
  pruneMessages
} from "ai";
import { createClient, streamToDataUri } from "../lib/elevenlabs";

export interface VoicePreview {
  generatedVoiceId: string;
  audioBase64: string; // base64 mp3 from ElevenLabs Voice Design
  mediaType: string;
}

export interface CharacterConfig {
  name: string;
  personality: string;
  systemPrompt: string;
  voiceId: string; // permanent voice ID created from a preview
  voiceDescription: string;
}

export interface CharacterState {
  phase: "idle" | "designing" | "chatting";
  character?: CharacterConfig;
  voicePreviews?: VoicePreview[];
}

/**
 * Character Creator agent — two-phase flow:
 * 1. Design: generate a system prompt (Workers AI) + voice previews (ElevenLabs)
 * 2. Chat: talk to the character with the custom voice
 */
export class CharacterAgent extends AIChatAgent<Env, CharacterState> {
  maxPersistedMessages = 50;

  initialState: CharacterState = { phase: "idle" };

  /** Use Workers AI to generate a system prompt from a personality description. */
  @callable()
  async generateSystemPrompt(personality: string): Promise<string> {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const { text } = await generateText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      prompt: `Create a system prompt for an AI character with this personality:

"${personality}"

The system prompt should define:
- Their personality traits and mannerisms
- How they speak (formal, casual, quirky, etc.)
- Their area of knowledge or interests
- Any catchphrases or verbal tics

Keep it under 200 words. Return ONLY the system prompt text, no wrapper or explanation.`
    });

    return text.trim();
  }

  /** Use ElevenLabs Voice Design to generate voice previews from a description. */
  @callable()
  async designVoice(voiceDescription: string): Promise<VoicePreview[]> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);

    const response = await client.textToVoice.createPreviews({
      voiceDescription,
      autoGenerateText: true,
      outputFormat: "mp3_22050_32"
    });

    const previews: VoicePreview[] = response.previews.map((p) => ({
      generatedVoiceId: p.generatedVoiceId,
      audioBase64: p.audioBase64,
      mediaType: p.mediaType
    }));

    this.setState({
      ...this.state,
      phase: "designing",
      voicePreviews: previews
    });
    return previews;
  }

  /** Save the chosen voice preview as a permanent ElevenLabs voice and switch to chat phase. */
  @callable()
  async saveCharacter(
    name: string,
    personality: string,
    systemPrompt: string,
    voiceDescription: string,
    generatedVoiceId: string
  ): Promise<string> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);

    // This creates a permanent voice in your ElevenLabs account
    const voice = await client.textToVoice.create({
      voiceName: name,
      voiceDescription,
      generatedVoiceId
    });

    const voiceId = voice.voiceId;

    this.setState({
      phase: "chatting",
      character: { name, personality, systemPrompt, voiceId, voiceDescription },
      voicePreviews: undefined
    });

    return voiceId;
  }

  /** Convert text to speech using the character's custom voice. */
  @callable()
  async speak(text: string): Promise<string> {
    const voiceId = this.state.character?.voiceId;
    if (!voiceId) throw new Error("No character voice configured");

    const client = createClient(this.env.ELEVENLABS_API_KEY);
    const audio = await client.textToSpeech.convert(voiceId, {
      text,
      modelId: "eleven_flash_v2_5",
      outputFormat: "mp3_44100_128"
    });
    return streamToDataUri(audio);
  }

  /** Reset back to design phase, clearing chat history. */
  @callable()
  async resetCharacter() {
    this.setState({
      phase: "idle",
      character: undefined,
      voicePreviews: undefined
    });
  }

  /** Stream a chat response using the character's system prompt. Only works in "chatting" phase. */
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    if (this.state.phase !== "chatting" || !this.state.character) {
      throw new Error("Create a character first");
    }

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      system: this.state.character.systemPrompt,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}
