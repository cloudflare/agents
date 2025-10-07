# Realtime Voice Agent Example

This example demonstrates how to create a voice agent using the Cloudflare Agents SDK with real-time audio processing capabilities.

## Basic Usage

```typescript
import {
  Agent,
  type RealtimePipelineComponent,
  RealtimeKitTransport,
  DeepgramSTT,
  ElevenLabsTTS
} from "@cloudflare/agents";

export class RealtimeVoiceAgent extends Agent {
  realtimePipelineComponents = (): RealtimePipelineComponent[] => {
    const {
      DEEPGRAM_GATEWAY_ID,
      ELEVENLABS_GATEWAY_ID,
      MEETING_ID,
      RTK_AUTH_TOKEN
    } = this.env as {
      DEEPGRAM_GATEWAY_ID: string;
      ELEVENLABS_GATEWAY_ID: string;
      MEETING_ID: string;
      RTK_AUTH_TOKEN: string;
    };

    // RealtimeKit transport for audio input/output
    const rtk = new RealtimeKitTransport({
      meetingId: MEETING_ID,
      authToken: RTK_AUTH_TOKEN,
      filters: [
        { media_kind: "audio", stream_kind: "microphone", preset_name: "*" }
      ]
    });

    // Deepgram for speech-to-text
    const stt = new DeepgramSTT(DEEPGRAM_GATEWAY_ID, {
      language: "en",
      model: "nova-2"
    });

    // ElevenLabs for text-to-speech
    const tts = new ElevenLabsTTS(ELEVENLABS_GATEWAY_ID, {
      model: "eleven_turbo_v2_5",
      voice_id: "21m00Tcm4TlvDq8ikWAM"
    });

    // The pipeline: Audio → Text → AI Processing (this agent) → Text → Audio
    return [rtk, stt, this, tts, rtk];
  };

  /**
   * Handle incoming transcribed text and generate intelligent responses
   * This is where you implement your AI logic, knowledge retrieval, etc.
   */
  onTranscript(
    text: string,
    reply: (
      text: string | ReadableStream<Uint8Array>,
      canInterrupt?: boolean
    ) => void
  ): void {
    // Simple echo example
    console.log("Received transcript:", text);
    reply(`You said: ${text}`);
  }
}
```

## Advanced Usage with AI Integration

```typescript
import {
  Agent,
  type RealtimePipelineComponent,
  RealtimeKitTransport,
  DeepgramSTT,
  ElevenLabsTTS
} from "@cloudflare/agents";

export class AIVoiceAssistant extends Agent<Env, ConversationState> {
  initialState = {
    conversationHistory: []
  };

  realtimePipelineComponents = (): RealtimePipelineComponent[] => {
    const {
      DEEPGRAM_GATEWAY_ID,
      ELEVENLABS_GATEWAY_ID,
      MEETING_ID,
      RTK_AUTH_TOKEN
    } = this.env as {
      DEEPGRAM_GATEWAY_ID: string;
      ELEVENLABS_GATEWAY_ID: string;
      MEETING_ID: string;
      RTK_AUTH_TOKEN: string;
    };

    const rtk = new RealtimeKitTransport({
      meetingId: MEETING_ID,
      authToken: RTK_AUTH_TOKEN
    });

    const stt = new DeepgramSTT(DEEPGRAM_GATEWAY_ID);
    const tts = new ElevenLabsTTS(ELEVENLABS_GATEWAY_ID);

    return [rtk, stt, this, tts, rtk];
  };

  async onTranscript(
    text: string,
    reply: (
      text: string | ReadableStream<Uint8Array>,
      canInterrupt?: boolean
    ) => void
  ): Promise<void> {
    // Add user message to conversation history
    const history = [
      ...this.state.conversationHistory,
      { role: "user", content: text }
    ];

    // Use Cloudflare AI to generate a response
    const { AI } = this.env as { AI: any };

    try {
      const response = await AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: history,
        stream: true
      });

      // Stream the AI response back
      reply(response as ReadableStream<Uint8Array>, true);

      // Update conversation history (you'd need to collect the full response)
      // This is simplified - in production you'd track the complete response
      this.setState({
        conversationHistory: [...history, { role: "assistant", content: "..." }]
      });
    } catch (error) {
      console.error("AI error:", error);
      reply("I'm sorry, I encountered an error processing your request.");
    }
  }

  /**
   * You can also call speak() directly from other methods
   */
  async someCustomMethod() {
    // Speak something to the user
    await this.speak("Hello! I'm your AI assistant.");
  }
}

type ConversationState = {
  conversationHistory: Array<{ role: string; content: string }>;
};
```

## Key Concepts

### 1. Pipeline Components

The realtime pipeline is a chain of components that process data:

- **RealtimeKitTransport**: Handles real-time audio I/O with meeting participants
- **DeepgramSTT**: Converts speech to text
- **Agent (this)**: Your custom logic that processes text and generates responses
- **ElevenLabsTTS**: Converts text back to speech

### 2. The Agent as a Pipeline Component

When you return `this` (the agent) in the `realtimePipelineComponents` array, it acts as a text processor in the pipeline. The `onTranscript` method is automatically called when text is received.

### 3. Speaking to Users

There are two ways to send audio to users:

#### A. Via the reply callback (in onTranscript):

```typescript
onTranscript(text: string, reply: (text: string) => void) {
  reply("Hello!"); // This goes through the TTS component
}
```

#### B. Via the speak() method (from anywhere):

```typescript
async someMethod() {
  await this.speak("This is an announcement!");
}
```

### 4. Streaming Responses

You can stream responses for more natural conversations:

```typescript
async onTranscript(
  text: string,
  reply: (text: string | ReadableStream<Uint8Array>) => void
) {
  const stream = await getStreamingAIResponse(text);
  reply(stream); // Stream gets processed by TTS
}
```

### 5. Context and Interruptions

The `contextId` parameter allows tracking conversation threads and handling interruptions:

```typescript
async onTranscript(
  text: string,
  reply: (text: string, canInterrupt?: boolean) => void
) {
  // canInterrupt = false means this response cannot be interrupted by user speech
  reply("Please don't interrupt this important message", false);
}
```

## Environment Variables Required

```toml
# wrangler.toml
[env.production]
AI = { binding = "AI" }
CF_ACCOUNT_ID = "your-account-id"
CF_API_TOKEN = "your-api-token"
DEEPGRAM_GATEWAY_ID = "your-deepgram-gateway"
ELEVENLABS_GATEWAY_ID = "your-elevenlabs-gateway"
```

## How It Works

1. **Audio Input**: User speaks → RealtimeKit captures audio
2. **Speech-to-Text**: Deepgram converts audio → text transcript
3. **AI Processing**: Your agent's `onTranscript` method processes the text
4. **Text-to-Speech**: ElevenLabs converts response text → audio
5. **Audio Output**: RealtimeKit sends audio back to user

The pipeline is bidirectional and handles real-time streaming for low-latency conversations.
