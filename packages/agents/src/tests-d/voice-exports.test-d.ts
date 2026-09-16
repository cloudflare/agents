import { Agent } from "agents";
import {
  VOICE_PROTOCOL_VERSION,
  WorkersAIFluxSTT,
  withVoice,
  withVoiceInput,
  type TTSProvider,
  type Transcriber,
  type VoiceAgentMixinMembers
} from "agents/voice";
import { VoiceClient, WebSocketVoiceTransport } from "agents/voice/client";
import { VoiceProviderError } from "agents/voice/errors";
import { useVoiceAgent, useVoiceInput } from "agents/voice/react";
import { createSFUSession } from "agents/voice/sfu";
import { SentenceChunker } from "agents/voice/text";
import type { VoiceServerMessage } from "agents/voice/types";
import { WorkersAITTS } from "agents/voice/workers-ai";

const VoiceAgent = withVoice(Agent);
withVoiceInput(Agent);
type ExportedVoiceMembers = VoiceAgentMixinMembers;
declare const voiceAgent: ExportedVoiceMembers;
void VoiceAgent;
void voiceAgent;
VOICE_PROTOCOL_VERSION satisfies number;
new VoiceClient({ agent: "voice-agent" });
new WebSocketVoiceTransport({ agent: "voice-agent" });
new VoiceProviderError("provider failed") satisfies Error;
new SentenceChunker();
useVoiceAgent({ agent: "voice-agent" }).connected satisfies boolean;
useVoiceInput({ agent: "voice-agent" }).isListening satisfies boolean;
void createSFUSession;
declare const workersAITranscriber: InstanceType<typeof WorkersAIFluxSTT>;
declare const workersAITTS: InstanceType<typeof WorkersAITTS>;
workersAITranscriber satisfies Transcriber;
workersAITTS satisfies TTSProvider;

declare const message: VoiceServerMessage;
message satisfies VoiceServerMessage;
