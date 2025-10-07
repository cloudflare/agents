# Realtime Voice Assistant Agent

This example demonstrates how to build a complete voice assistant using Cloudflare's AI Agent framework with realtime capabilities. The assistant can:

- Listen to audio input via RealtimeKit
- Convert speech to text using Deepgram STT
- Process conversations with intelligent responses
- Convert responses back to speech using ElevenLabs TTS
- Stream audio output back to the client

## Architecture

The voice assistant uses a pipeline architecture:

```
Audio Input → RealtimeKit → Deepgram STT → Agent Logic → ElevenLabs TTS → Audio Output
```

## Setup

1. **Environment Variables**: Configure the following in your `wrangler.toml` or environment:

```toml
[vars]
ACCOUNT_ID = "your-cloudflare-account-id"
API_TOKEN = "your-cloudflare-api-token"
DEEPGRAM_API_KEY = "your-deepgram-api-key"
ELEVENLABS_API_KEY = "your-elevenlabs-api-key"
RTK_MEETING_ID = "your-realtimekit-meeting-id"  # Optional
RTK_AUTH_TOKEN = "your-realtimekit-auth-token"  # Optional
```

2. **API Keys**:
   - Get a Deepgram API key from [https://deepgram.com](https://deepgram.com)
   - Get an ElevenLabs API key from [https://elevenlabs.io](https://elevenlabs.io)
   - Get your Cloudflare Account ID and API token from the Cloudflare dashboard

3. **Deploy**:

```bash
npm run dev  # For local development
wrangler deploy  # For production deployment
```

## Usage

Once deployed, the agent creates WebSocket connections for real-time voice interaction.

### Basic Flow:

1. Client connects to the agent WebSocket endpoint
2. Agent initializes the realtime pipeline
3. Client streams audio → Agent processes → Agent streams audio back
4. Agent handles conversation logic in `onRealtimeTranscript()` method

### Customization:

- Modify `onRealtimeTranscript()` method to add your own conversational AI logic
- Integrate with OpenAI, Anthropic, or other language models
- Add knowledge base queries, tool calling, or context management
- Customize voice settings in ElevenLabsTTS configuration

## Key Components

### RealtimeVoiceAgent

- Extends `Agent` class with realtime pipeline components
- Implements `onRealtimeTranscript()` for conversation handling
- Manages pipeline initialization and cleanup via `realtimePipelineComponents`

### MyAgent (Durable Object)

- Manages agent lifecycle and WebSocket connections
- Handles client connect/disconnect events
- Implements alarm handling for maintenance tasks

### Pipeline Components:

- **RealtimeKitTransport**: Audio input/output via RealtimeKit
- **DeepgramSTT**: Speech-to-text conversion
- **ElevenLabsTTS**: Text-to-speech synthesis

## Pipeline Configuration

The agent uses a pipeline component system defined in `realtimePipelineComponents` method:

```typescript
createRealtimePipeline() {
  const rtk = new RealtimeKitTransport(
    this.env.RTK_MEETING_ID || "default-meeting",
    this.env.RTK_AUTH_TOKEN || "default-token",
    [{
      media_kind: "audio",
      stream_kind: "microphone",
      preset_name: "*"
    }]
  );

  const stt = new DeepgramSTT(this.env.DEEPGRAM_API_KEY);
  const tts = new ElevenLabsTTS(this.env.ELEVENLABS_API_KEY);

  // Pipeline: Audio Input → STT → Agent → TTS → Audio Output
  return [rtk, stt, this, tts, rtk];
}
```

### Pipeline Flow

1. **Audio Input**: RealtimeKit captures microphone audio
2. **Speech Recognition**: Deepgram converts audio to text
3. **Agent Processing**: Your agent receives transcribed text via `onRealtimeTranscript()`
4. **Response Generation**: Agent generates text response
5. **Speech Synthesis**: ElevenLabs converts response to audio
6. **Audio Output**: RealtimeKit streams audio back to client

### Customizing the Pipeline

You can modify the pipeline components in `createRealtimePipeline()`:

```typescript
// Different STT provider
const stt = new CustomSTT(this.env.CUSTOM_API_KEY);

// Multiple TTS voices
const tts1 = new ElevenLabsTTS(this.env.ELEVENLABS_KEY, { voice_id: "voice1" });
const tts2 = new ElevenLabsTTS(this.env.ELEVENLABS_KEY, { voice_id: "voice2" });

// Audio preprocessing
const processor = new AudioProcessor();

return [rtk, processor, stt, this, tts1, rtk];
```

## Implementation Details

The Agent class implements the `RealtimePipelineComponent` interface, allowing it to be used directly in realtime pipelines:

```typescript
class RealtimeVoiceAgent extends Agent<Env> {
  realtimePipelineComponents = this.createRealtimePipeline;

  createRealtimePipeline() {
    const rtk = new RealtimeKitTransport(...);
    const stt = new DeepgramSTT(...);
    const tts = new ElevenLabsTTS(...);

    // Use 'this' to include the agent in the pipeline
    return [rtk, stt, this, tts, rtk];
  }

  // This method receives transcribed text
  onRealtimeTranscript(text: string, reply: (response: string) => void) {
    // Your conversation logic here
    const response = processConversation(text);
    reply(response);
  }
}
```

**Key Features:**

- ✅ **Direct agent integration** - Use `this` to include your agent in the pipeline
- ✅ **Type safety** - Full TypeScript support for pipeline components
- ✅ **Flexible positioning** - Place the agent anywhere in the processing flow
- ✅ **Clean separation** - Clear distinction between pipeline setup and conversation logic

## Examples

The current implementation includes basic conversational responses like:

- Greetings and farewells
- Time and date queries
- Simple jokes
- Help information

You can extend this by integrating with:

- OpenAI GPT models for advanced conversations
- Knowledge bases for domain-specific responses
- Weather APIs, calendars, or other external services
- Custom business logic and workflows

## Development

Run locally:

```bash
npm run dev
```

The agent will be available at the WebSocket endpoint provided by Wrangler.

## Troubleshooting

- Ensure all API keys are properly configured
- Check Cloudflare account ID and API token permissions
- Verify RealtimeKit meeting configuration
- Monitor logs for pipeline initialization errors
