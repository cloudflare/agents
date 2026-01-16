# RealtimeAgent Demo

A comprehensive example showing how to build a real-time voice agent using the Cloudflare Agents SDK with speech-to-text and text-to-speech capabilities.

## Quick Start

```bash
npm install
npm start
```

This will start the agent on `http://localhost:5173` with hot reload enabled.

## Overview

This example demonstrates a voice agent that processes real-time audio using:

- **RealtimeKitTransport**: Handles real-time audio I/O with meeting participants
- **DeepgramSTT**: Converts speech to text
- **RealtimeAgent**: Your custom logic that processes transcripts and generates responses
- **ElevenLabsTTS**: Converts text back to speech

The pipeline processes audio bidirectionally for low-latency conversations:

1. **Audio Input** → User speaks, RealtimeKit captures audio
2. **Speech-to-Text** → Deepgram converts audio to text transcript
3. **AI Processing** → Your agent's `onRealtimeTranscript` method processes the text
4. **Text-to-Speech** → ElevenLabs converts response text to audio
5. **Audio Output** → RealtimeKit sends audio back to user

## Implementation

### Basic Example

```typescript
import {
  RealtimeAgent,
  type RealtimePipelineComponent,
  RealtimeKitTransport,
  DeepgramSTT,
  ElevenLabsTTS,
  type SpeakResponse
} from "agents/realtime";

export class RealtimeVoiceAgent extends RealtimeAgent {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env, env.AI);

    const rtk = new RealtimeKitTransport({
      meetingId: "your-meeting-id",
      filters: [
        { media_kind: "audio", stream_kind: "microphone", preset_name: "*" }
      ]
    });

    const stt = new DeepgramSTT("deepgram-gateway-id", {
      language: "en",
      model: "nova-2"
    });

    const tts = new ElevenLabsTTS("elevenlabs-gateway-id", {
      model: "eleven_turbo_v2_5",
      voice_id: "21m00Tcm4TlvDq8ikWAM"
    });

    // Pipeline: Audio → Text → Processing → Text → Audio
    this.setPipeline([rtk, stt, this, tts, rtk]);
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    console.log("User said:", text);
    return {
      text: `You said: ${text}`,
      canInterrupt: true
    };
  }
}
```

### With AI Integration

```typescript
export class AIVoiceAssistant extends RealtimeAgent<Env, ConversationState> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env, env.AI);
    // ... setup pipeline
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    // Get conversation history for context
    const history = this.getFormattedHistory(10);

    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: `${history}\n\nUser: ${text}\nAssistant:`,
      stream: true
    });

    // Store the transcript
    await this.addTranscript("user", text);

    return {
      text: response,
      canInterrupt: true
    };
  }
}

type ConversationState = {
  conversationHistory: Array<{ role: string; content: string }>;
};
```

## Core Features

### Lifecycle Callbacks

#### `onRealtimeMeeting(meeting: RealtimeKitClient)`

Called when a RealtimeKit meeting is initialized. Use this for meeting-specific setup:

```typescript
async onRealtimeMeeting(meeting: RealtimeKitClient) {
  meeting.participants.joined.on("participantJoined", (participant) => {
    await this.speak(`Welcome ${participant.name}!`);
  });
}
```

#### `onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined>`

Called when incoming text is received from the transcript. Return a response to speak or `undefined` to skip:

```typescript
async onRealtimeTranscript(text: string) {
  return {
    text: "Your response here",
    canInterrupt: true
  };
}
```

#### `onRealtimeVideoFrame(frame: string): Promise<SpeakResponse | undefined>`

Handle incoming video frames from the pipeline:

```typescript
async onRealtimeVideoFrame(frame: string) {
  // Process video frame
  return {
    text: "I see something",
    canInterrupt: true
  };
}
```

### Transcript History Management

The agent automatically maintains a persistent transcript history:

```typescript
// Access the history
const entries = agent.transcriptHistory;

// Add an entry manually
await agent.addTranscript("user", "Hello");

// Get formatted conversation
const history = agent.getFormattedHistory();
// Output: "User: Hello\nAssistant: Hi there!"

// Get last N entries
const recent = agent.getFormattedHistory(5);

// Clear all transcripts
await agent.clearTranscriptHistory();
```

Transcripts are stored in D1 database and automatically loaded on agent startup.

### Sending Audio

#### Via Response

Return a `SpeakResponse` from `onRealtimeTranscript`:

```typescript
async onRealtimeTranscript(text: string) {
  return {
    text: "Hello!",
    canInterrupt: true
  };
}
```

#### Via speak() Method

Call directly from anywhere in your agent:

```typescript
async someCustomMethod() {
  await this.speak("This is an announcement!");
}
```

### Streaming Responses

Return streaming responses for natural-sounding conversations:

```typescript
async onRealtimeTranscript(text: string) {
  const stream = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: text,
    stream: true
  });

  return {
    text: stream, // ReadableStream<Uint8Array>
    canInterrupt: true
  };
}
```

### Handling Interruptions

Control whether user speech can interrupt the agent's response:

```typescript
async onRealtimeTranscript(text: string) {
  return {
    text: "Please don't interrupt this important message",
    canInterrupt: false // User cannot interrupt
  };
}
```

## Type Reference

### SpeakResponse

```typescript
type SpeakResponse = {
  text: string | ReadableStream<Uint8Array>; // Response text or stream
  canInterrupt?: boolean; // Can user interrupt? (default: true)
};
```

### TranscriptEntry

```typescript
type TranscriptEntry = {
  id: string; // Unique identifier
  role: "user" | "assistant"; // Speaker
  text: string; // Transcript text
  timestamp: number; // When it occurred
};
```

## Environment Setup

1. Ensure you have the required environment variables in `.dev.vars`:

```env
DEEPGRAM_GATEWAY_ID=your-deepgram-gateway
ELEVENLABS_GATEWAY_ID=your-elevenlabs-gateway
```

2. Update `wrangler.jsonc` with your AI binding:

```json
{
  "env": {
    "production": {
      "bindings": [
        {
          "binding": "AI",
          "type": "ai"
        }
      ]
    }
  }
}
```

## Key Methods

- `setPipeline(components: RealtimePipelineComponent[])` - Configure the processing pipeline
- `async startRealtimePipeline()` - Start the pipeline
- `async stopRealtimePipeline()` - Stop the pipeline
- `async speak(text: string, contextId?: string)` - Send audio to participants
- `async addTranscript(role, text)` - Record a transcript entry
- `getFormattedHistory(maxEntries?)` - Get formatted conversation
- `async clearTranscriptHistory()` - Clear all transcripts

## Additional Resources

- [Agents Documentation](https://agents.cloudflare.com)
- [RealtimeKit Documentation](https://developers.dyte.in/web/core/realtimekit)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
