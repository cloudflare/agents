export type SttProvider =
  | "workers-ai-flux"
  | "workers-ai-nova-3"
  | "assemblyai"
  | "telnyx"
  | "elevenlabs";
export type AssemblyAIMode = "min_latency" | "balanced" | "max_accuracy";
export type VoiceFocus = "off" | "near-field" | "far-field";
export type TelnyxEngine = "Telnyx" | "Deepgram";

export interface SttSettings {
  provider: SttProvider;
  assemblyaiMode: AssemblyAIMode;
  voiceFocus: VoiceFocus;
  assemblyaiLanguageCodes: string;
  prompt: string;
  keyterms: string;
  telnyxEngine: TelnyxEngine;
  telnyxModel: string;
  language: string;
  elevenlabsNoVerbatim: boolean;
  elevenlabsFilterBackgroundAudio: boolean;
}

export type SettingsUpdate = (patch: Partial<SttSettings>) => void;
