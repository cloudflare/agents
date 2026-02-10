# RealtimeAgent Example

Build real-time voice agents using the Cloudflare Agents SDK with speech-to-text (Deepgram) and text-to-speech (ElevenLabs) capabilities.

## Quick Start

1. **Set environment variables**

Rename `.env.example` to `.env` and fill in the values:

```env
DEEPGRAM_API_KEY=your-deepgram-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key
ELEVENLABS_VOICE_ID=your-voice-id
AI_GATEWAY_ID=your-ai-gateway-id
```

2. **Deploy the agent**:

```bash
npm run deploy
```

## Overview

The pipeline processes audio bidirectionally:

```
Audio In → STT (Deepgram) → Your Agent → TTS (ElevenLabs) → Audio Out
```

**Components:**

- **RealtimeKitTransport** – Real-time audio I/O via WebRTC
- **DeepgramSTT** – Speech-to-text conversion
- **RealtimeAgent** – Your custom logic processing transcripts
- **ElevenLabsTTS** – Text-to-speech conversion

## Lifecycle Callbacks

### `onRealtimeMeeting(meeting: RealtimeKitClient)`

Called when a RealtimeKit meeting is initialized (when the agent joins a meeting):

```typescript
onRealtimeMeeting(meeting: RealtimeKitClient) {
  meeting.self.on("roomJoined", () => {
    this.speak("Welcome!");
  });
}
```

Setup your event listeners in this callback

### `onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined>`

Called when speech is transcribed. Return a response to speak or `undefined` to skip:

```typescript
async onRealtimeTranscript(text: string) {
  return {
    text: "Your response here", // or a streaming response from ai-sdk / workers ai binding
    canInterrupt: true
  };
}
```

## Starting the Agent

To start the agent, you need to specify which RealtimeKit meeting to connect to. There are several ways to do this:

### Automatic Start via RealtimeKit Dashboard

You can configure your agent to start automatically whenever a RealtimeKit meeting begins:

1. Go to the [RealtimeKit dashboard](https://dash.cloudflare.com/?to=/:account/realtime/kit)
2. Select your app
3. Navigate to the "Agents" tab
4. Create a mapping to the above agent worker

Whenever a meeting is created in this app, this agent will automatically start and join the meeting.

### Manual Start via HTTP Endpoint

Start the agent by sending a request to the built-in HTTP endpoint:

```
GET /agents/<agent-name>/<meeting-id>/realtime/start?meetingId=<meeting-id>
```

### Manual Programmatic Start

You can also start the agent programmatically using the `startRealtimePipeline` method:

```ts
const agent = getAgentByName(env.VoiceAgent, "meeting-id");
agent.startRealtimePipeline(meetingId);
```

```

## Additional Resources

- [Agents Documentation](https://agents.cloudflare.com)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
```
