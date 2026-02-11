# Voice Agents on the Agents SDK

## The opportunity

There is no voice agent framework in JavaScript. Pipecat is Python. LiveKit agents are Go/Python. Vapi is hosted and opaque. The JS/TS developer population — the largest in the world — has zero options for building voice agents.

The Agents SDK is uniquely positioned to fill this gap because it already has the primitives that turn a voice *pipeline* into a voice *agent*: persistent state, SQL, scheduling, MCP tool use, workflows, React hooks, and bidirectional state sync. No other voice framework has any of these. They treat conversations as ephemeral. We don't.

The pitch: **"The Agent you already have can now talk."**

---

## Context and prior art

### What Renan's team built (`@cloudflare/realtime-agents`)

An existing package (0.0.6, 19.4 kB, 4 files) published to npm. The docs say "Realtime agents will be consolidated into the Agents SDK in a future release." Key characteristics:

- `RealtimeAgent` extends raw `DurableObject` (not the Agents SDK `Agent`)
- Uses RealtimeKit as transport — requires creating meetings, auth tokens, App ID/Secret
- Pipeline model: `[rtkTransport, DeepgramSTT, textProcessor, ElevenLabsTTS, rtkTransport]`
- External API keys required: Deepgram (STT), ElevenLabs (TTS)
- Has `/agentsInternal` routes suggesting a separate pipeline backend service
- No state management, no persistence, no scheduling, no MCP, no React hooks

Renan described the scalability problems: "every new model needs custom new integration and maintenance, and lower customizability for advanced use cases. In addition, this is a new backend service to maintain and figure out billing over time."

### Mark Dembo's proof of concept

Demo at https://cf-realtime-audio.not-a-single-bug.workers.dev/. A voice concierge agent running entirely in a Durable Object. Flow: agent intro → restaurant recommendation → booking → confirmation. All lookups mocked, but proves the architecture works.

### The ai-tts-stt example

https://github.com/cloudflare/realtime-examples/tree/main/ai-tts-stt — A reference implementation using Cloudflare's Realtime SFU with WebSocket adapters. Two Durable Objects (TTSAdapter, STTAdapter) handle audio processing with SpeexDSP WASM for resampling. Demonstrates the full pipeline: browser mic → WebRTC → SFU → WebSocket Adapter → DO → Workers AI → DO → WebSocket Adapter → SFU → WebRTC → browser speaker.

### Workers AI models available

- **STT**: `@cf/deepgram/nova-3` — speech-to-text via `env.AI.run()`, no API key needed
- **TTS**: `@cf/deepgram/aura-1` — text-to-speech via `env.AI.run()`, no API key needed  
- **VAD/Turn detection**: `@cf/pipecat-ai/smart-turn-v2` — detects when user has stopped speaking, returns `is_complete` boolean and `probability` score. $0.00034 per audio minute.
- **LLMs**: Full catalog of models via Workers AI binding

All accessed via `env.AI.run()` — a binding, not an npm package. Zero dependencies.

---

## Cloudflare Realtime infrastructure (reference)

### What is an SFU?

A Selective Forwarding Unit sits in the middle of WebRTC connections. Each participant sends one stream to the SFU; the SFU copies it to everyone who should receive it. Handles codec negotiation, NAT traversal (ICE/STUN/TURN), jitter buffering, DTLS encryption, packet loss concealment.

### The Cloudflare Realtime product stack

```
┌─────────────────────────────────────────────────────┐
│  RealtimeKit                                         │  High-level SDK for video/voice apps
│  UI Kit + Core SDK + Backend (REST APIs, signaling)  │  Meetings, participants, presets, rooms
├─────────────────────────────────────────────────────┤
│  Realtime SFU                                        │  Low-level WebRTC media server
│  Sessions, tracks, pub/sub, WebSocket adapters       │  $0.05/GB, 1TB free
├─────────────────────────────────────────────────────┤
│  TURN Service                                        │  NAT traversal relay
│  turn.cloudflare.com, anycast, free with SFU         │
└─────────────────────────────────────────────────────┘
```

### WebSocket Adapter (beta)

Bridges WebRTC and WebSocket. Lets a DO act as a "headless participant":
- **Ingest** (WebSocket → WebRTC): DO sends PCM audio → SFU converts to WebRTC track → users hear it
- **Stream** (WebRTC → WebSocket): User's mic via WebRTC → SFU sends PCM frames to DO
- Video egress: JPEG frames at ~1 FPS (added Nov 2025)
- Format: 16-bit signed LE PCM, 48 kHz, stereo, protobuf framing

### Why we don't need the SFU for the core story

A voice agent is a 1:1 conversation — one user, one agent. The browser has `getUserMedia()` for the mic and Web Audio API for playback. Audio can flow as binary WebSocket frames over the connection the Agent already has via partyserver. No SFU needed.

What you give up without the SFU:
- Multi-participant (doesn't apply to 1:1)
- WebRTC-grade network resilience (TCP head-of-line blocking on bad networks)
- Tightly coupled echo cancellation (browser AEC constraints on mic input still work)
- Video ingestion (no WebRTC video track)

These are all Layer 4 concerns, not the core story.

### Where RealtimeKit fits (it doesn't, for the core story)

RealtimeKit is a meetings product. Its primitives are meetings, participants, presets, rooms, waiting rooms, recording, chat, polls, breakout rooms. It solves "N humans in a video call." The AI agent joining a meeting is a secondary use case.

The Agents SDK voice story is "talk to your agent" — no meeting to create, no tokens to generate, no dashboard to visit. Coupling to RealtimeKit means every developer must: create a Realtime app, get App ID/Secret, create meetings via REST API, generate auth tokens, join with the RTK SDK on the client, and separately connect to their Agent for state/RPC. That's terrible DX for a 1:1 audio conversation.

RealtimeKit could be a Layer 4 transport adapter for "AI participant in an existing meeting." That's a valid niche use case, not the primary story.

---

## What the Agents SDK already has

| Capability | What exists | Why it matters for voice |
|---|---|---|
| Durable Object base class | `Agent` extends partyserver `Server` — full DO lifecycle, hibernation | Agent's "brain" persists across conversations |
| Bidirectional state sync | `setState()` broadcasts to all clients, clients can push back | Real-time UI updates (transcripts, status, voice indicators) |
| RPC | `@callable` methods, streaming via `StreamingResponse` | Call agent methods from UI (start/stop, change settings) |
| Scheduling | Cron, delays, intervals in SQLite | "Remind me tomorrow", session timeouts, proactive agents |
| SQL | `this.sql` template tag with SQLite | Conversation history, user preferences, knowledge base |
| MCP client | `MCPClientManager` with OAuth, auto-reconnect | Tool use during voice — agent can actually DO things |
| Workflows | `AgentWorkflow` for multi-step orchestration | Complex voice-driven processes |
| WebSocket connections | Connection management, broadcast, hibernation | The transport already exists |
| React hooks | `useAgent` with typed RPC stubs, state sync | Extend to `useVoiceAgent` for voice UI |
| Observability | Event emission system | Track latency, model usage, conversation quality |
| Email routing | `routeAgentEmail()`, `onEmail()` | Multi-channel: same agent, voice + email + chat |

---

## The vision

### What makes this special vs. Pipecat, LiveKit, Vapi

**1. Stateful voice agents.** Every existing framework treats conversations as ephemeral. Here, the DO *is* the agent's long-term memory. Conversations survive disconnects. The agent remembers what you talked about yesterday. Transformative for customer service, personal assistants, workflows that span sessions.

**2. Tool use during conversation (MCP).** The agent can actually do things mid-call. "Book me a table at Ocean Prime for 7pm" → MCP tool call → real booking → "Done, confirmed for 7pm." Not "I'll send you a link." Actual execution.

**3. Hybrid modality.** Same agent, same state, accessible via voice OR text OR API. Start a voice call on your phone, get disconnected, continue via text on your laptop. The agent doesn't care how you're talking to it.

**4. Scheduling = proactive agents.** "Remind me to call the dentist at 3pm" → `this.schedule()` → agent initiates at 3pm. The agent doesn't just respond, it can initiate.

**5. Zero infrastructure.** Write a class, deploy. No SFU to configure, no servers to manage, no API keys for basic functionality (Workers AI binding).

**6. JavaScript.** First voice agent framework in JS. Massive developer reach. Frontend developers who build voice UIs can now build the agents too, in the same language.

**7. Edge-native latency.** DO, SFU (if used), and AI models all on Cloudflare's edge. The entire roundtrip stays within the network. For voice, every 100ms matters.

### Target developer experience

Server side:

```typescript
import { Agent } from "agents";
import { voicePipeline } from "agents/voice";

class RestaurantAgent extends Agent {
  voice = voicePipeline({
    stt: "workers-ai/deepgram-nova-3",
    tts: "workers-ai/deepgram-aura",
    turnDetection: "workers-ai/smart-turn-v2",
    interruptible: true,
  });

  initialState = { reservations: [], preferences: {} };

  onVoiceConnect(connection) {
    this.voice.speak("Hi! I can help you find a restaurant.");
  }

  async onTurn(transcript: string, context: ConversationContext) {
    // Full access to this.state, this.sql, this.schedule(), MCP tools
    const response = await this.generateResponse(transcript);
    return response; // automatically spoken via TTS
  }

  onInterrupt() {
    // user started speaking while agent was talking
  }
}
```

Client side:

```tsx
import { useVoiceAgent } from "agents/react";

function VoiceUI() {
  const {
    status,       // "idle" | "listening" | "thinking" | "speaking"
    transcript,   // live transcript
    isMicActive,
    startCall,
    endCall,
    state,        // synced agent state
  } = useVoiceAgent<RestaurantAgent>({ agent: "restaurant" });

  return <div>...</div>;
}
```

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser / Client                      │
│  useVoiceAgent() hook                                    │
│  ┌──────────┐                    ┌──────────────────┐   │
│  │ getUserMe-│  binary frames    │ WebSocket (same   │   │
│  │ dia() mic │──────────────────▶│ connection for    │   │
│  │           │◀──────────────────│ audio + state +   │   │
│  │ AudioCtx  │  binary frames    │ RPC + transcripts)│   │
│  │ (speaker) │                   │                   │   │
│  └──────────┘                    └────────┬──────────┘   │
└───────────────────────────────────────────┼──────────────┘
                                            │ WebSocket
                                            ▼
┌───────────────────────────────────────────────────────────┐
│              Durable Object (Agent)                        │
│                                                           │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Voice Pipeline                                     │   │
│  │                                                     │   │
│  │  Audio In (binary WS frames)                        │   │
│  │    ↓                                                │   │
│  │  VAD — smart-turn-v2 (env.AI.run)                   │   │
│  │    ↓                                                │   │
│  │  STT — deepgram-nova-3 (env.AI.run)                 │   │
│  │    ↓                                                │   │
│  │  onTurn() — your logic + LLM + MCP tools            │   │
│  │    ↓                                                │   │
│  │  TTS — deepgram-aura (env.AI.run)                   │   │
│  │    ↓                                                │   │
│  │  Audio Out (binary WS frames)                       │   │
│  └────────────────────────────────────────────────────┘   │
│                                                           │
│  + this.state (persistent, synced to clients)             │
│  + this.sql (SQLite — conversation history, preferences)  │
│  + this.schedule() (reminders, follow-ups, timeouts)      │
│  + MCP tools (book restaurants, check calendars, etc.)    │
│  + Workflows (multi-step voice-driven processes)          │
└───────────────────────────────────────────────────────────┘
```

One WebSocket carries everything: audio frames (binary), state updates (JSON), RPC calls (JSON), transcripts (JSON). No second connection, no SFU, no meeting infrastructure.

---

## Roadmap

Each layer is a complete, shippable product. Later layers add power, not fix gaps.

### Layer 0: Proof of concept (example, not SDK code)

**Goal:** Prove the architecture works with zero SDK changes. Build conviction before committing to API design.

**What:** An example in `examples/voice-agent`.

- Browser: `getUserMedia()` → AudioWorklet → PCM → binary WebSocket frames to Agent
- Agent: `onMessage` handles binary frames, buffers audio, calls `env.AI.run()` for VAD/STT/TTS, sends audio back as binary frames
- Browser: receives binary frames → AudioWorklet → speakers

**Dependencies added to SDK: zero.** Workers AI models are bindings. Binary WebSocket messages already work. This is an example, not a package change.

**Proves:** Entire voice loop runs inside a single DO. State, scheduling, MCP, SQL all available from day one.

**Timeline:** 1-2 weeks. This is Mark's demo, cleaned up.

### Layer 1: Client-side audio utilities

**Goal:** Make the browser-side audio code reusable. Layer 0's AudioWorklet/PCM/playback code is gnarly — nobody should write it from scratch.

**What:** Client-side utilities exported from `agents/voice-client` (or similar).

```typescript
import { VoiceClient } from "agents/voice-client";

const voice = new VoiceClient({
  agent: "voice-agent",
  onStateChange(status) { /* idle | listening | thinking | speaking */ },
  onTranscript(text, role) { /* live transcript updates */ },
});

voice.start();
voice.stop();
voice.mute();
voice.unmute();
```

And a React hook:

```tsx
const { status, transcript, start, stop, mute } = useVoiceAgent({
  agent: "voice-agent",
});
```

Handles: `getUserMedia()` with AEC constraints, AudioWorklet PCM encoding, binary WebSocket framing, audio playback queue with proper scheduling, interruption detection (user speaks while audio playing → stop playback, signal agent).

**Dependencies added: zero npm dependencies.** All Web Audio API (browser-native) + existing `AgentClient`/`useAgent` infrastructure.

**Timeline:** 2-3 weeks after Layer 0 (need Layer 0 to validate the wire protocol).

### Layer 2: Server-side pipeline helpers

**Goal:** Extract the messy `onMessage` audio buffering/VAD/STT/TTS orchestration into clean abstractions.

**What:** Server-side voice pipeline exported from `agents/voice`.

```typescript
import { Agent } from "agents";
import { voicePipeline } from "agents/voice";

class MyAgent extends Agent {
  voice = voicePipeline({
    stt: "workers-ai/deepgram-nova-3",
    tts: "workers-ai/deepgram-aura",
    turnDetection: "workers-ai/smart-turn-v2",
    interruptible: true,
  });

  async onTurn(transcript, context) {
    // your logic, full Agent access
    return response;
  }
}
```

**Key design decisions:**

1. **Provider interface** — clean `STTProvider` / `TTSProvider` / `VADProvider` interfaces. Ship Workers AI implementations built-in (just `env.AI.run()` calls). Third-party providers are classes that implement the interface — users bring their own.

2. **Conversation context** — automatic transcript accumulation. Rolling window stored in SQLite, survives hibernation. Available in `onTurn`. No other voice framework has this because they don't have persistence.

3. **Interruption state machine** — the hard problem. When user speaks while agent is mid-sentence: cancel TTS, flush audio buffer, emit `onInterrupt()`, switch to listening. `smart-turn-v2` detects turn boundaries. Getting this right with low latency is what makes it feel natural.

4. **Audio format handling** — resampling between client format and model format. Pure JS, no native deps.

**State machine:**

```
IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
                                    ↑          │
                                    └──────────┘
                                  (interruption)
```

**Dependencies added: still zero npm dependencies.** STT/TTS/VAD are `env.AI.run()`. Pipeline logic is pure TypeScript.

**Timeline:** 3-4 weeks. API design matters most here.

### Layer 3: Provider ecosystem and advanced patterns

**Goal:** Open it up without adding complexity to the core.

**Third-party providers** (separate packages, not SDK dependencies):

```typescript
import { ElevenLabsTTS } from "agents-voice-elevenlabs";
import { OpenAISTT } from "agents-voice-openai";

class MyAgent extends Agent {
  voice = voicePipeline({
    stt: new OpenAISTT({ model: "whisper-1" }),
    tts: new ElevenLabsTTS({ voice: "rachel" }),
    turnDetection: "workers-ai/smart-turn-v2",
  });
}
```

**Multi-modal** — voice + text on the same agent:

```typescript
class MyAgent extends Agent {
  voice = voicePipeline({ ... });

  onMessage(connection, message) {
    if (typeof message === "string") {
      // text chat — same agent, same state
    }
    // binary messages handled by voice pipeline automatically
  }
}
```

Client connects via `useVoiceAgent()` for voice or `useAgent()` for text. Same instance, same state, same tools.

**Proactive voice** (scheduling + voice):

```typescript
async onTurn(transcript) {
  if (shouldSetReminder(transcript)) {
    this.schedule(reminderTime, "remind", { message: "..." });
    return "Got it, I'll remind you.";
  }
}

async remind(payload) {
  this.voice.speak(`Reminder: ${payload.message}`);
}
```

**Timeline:** Ongoing, community-driven. Ship provider interface in Layer 2, build reference providers, let ecosystem fill in.

### Layer 4: SFU, video, telephony (future, optional)

**Goal:** Advanced use cases for those who need them. Explicitly separate.

- **SFU transport**: WebRTC-grade audio, multi-participant. Same transport interface, backed by Cloudflare SFU WebSocket Adapter instead of direct WebSocket. Separate package (`agents/voice-sfu` or similar).
- **Video ingestion**: SFU JPEG egress at ~1 FPS → feed to vision model. "Show me the product."
- **Telephony**: SIP/PSTN bridge for phone calls. RealtimeKit has SIP interconnect.
- **Agent-to-agent voice**: One agent calls another. Handoffs.
- **RealtimeKit integration**: Agent joins an existing video meeting as a participant. Niche but valid.

**Timeline:** After Layers 0-2 are solid and there are real users. Don't build until someone asks.

---

## Summary

| Layer | What | New deps | Timeframe | Ships as |
|---|---|---|---|---|
| **0** | Working example, proof of concept | Zero | 1-2 weeks | `examples/voice-agent` |
| **1** | Client-side audio utilities | Zero | 2-3 weeks | `agents/voice-client` export |
| **2** | Server-side pipeline + hooks | Zero | 3-4 weeks | `agents/voice` export |
| **3** | Provider ecosystem, multi-modal | User's choice | Ongoing | Separate packages + docs |
| **4** | SFU, video, telephony | SFU API | When needed | `agents/voice-sfu` export |

**Layers 0 through 2 add zero npm dependencies to the Agents SDK.** Workers AI models are bindings, audio handling is Web APIs and pure JS, the pipeline is TypeScript.

---

## Competitive landscape

| Framework | Language | Transport | State | Tool use | Scheduling | Infra required |
|---|---|---|---|---|---|---|
| **Pipecat** | Python | WebRTC (via Daily/LiveKit), WebSocket | None | Limited | None | Python server |
| **LiveKit Agents** | Go/Python | WebRTC (LiveKit SFU) | None | Limited | None | LiveKit server/cloud |
| **Vapi** | Hosted API | WebRTC | None (API calls) | Limited | None | Vapi subscription |
| **Agents SDK (proposed)** | JavaScript/TypeScript | WebSocket (built-in) | SQLite + bidirectional sync | MCP (built-in) | Cron/delays/intervals | `wrangler deploy` |

---

## Open questions

### Punted (independent of Layer 1/2 work, can answer later)

- **Wire protocol**: What's the right format for audio frames over WebSocket? Raw PCM? Opus-encoded? What sample rate and chunk size minimize latency while keeping bandwidth reasonable? *Punted: this is a transport detail. Whatever format audio arrives in, the pipeline does the same thing. Can swap later without touching pipeline logic.*
- **Hibernation**: How does hibernation interact with active voice sessions? The DO hibernates when no JS is executing — do we need to keep the connection "warm" during pauses in conversation? *Punted: this is a Workers runtime behavior question. If it's a problem, fix is likely a keepalive ping (one-liner). Doesn't affect pipeline/hooks/client SDK design.*
- **Latency budget**: Competitive voice agents target <500ms end-to-end (user stops speaking → agent starts speaking). Is that achievable with Workers AI models + WebSocket transport? *Punted: the number matters for tuning, but the architecture that improves it is streaming TTS, which we're building anyway. Measure after streaming is in.*

### Active

- What's the right abstraction boundary for the voice pipeline? The current thinking is `voicePipeline()` config + `onTurn()` hook, but should there be lower-level hooks for partial transcripts, audio-level events, etc.?
- How should conversation history be managed? Automatic rolling window in SQLite? User-controlled? What's the right default context window?
- Can we support streaming TTS (start speaking before the full LLM response is generated) to minimize time-to-first-audio? This requires chunking LLM output into sentence-sized pieces and pipelining TTS calls. **← Working on this next.**

## References

- Cloudflare Realtime SFU: https://developers.cloudflare.com/realtime/sfu
- Cloudflare Realtime overview: https://developers.cloudflare.com/realtime/
- WebSocket Adapter: https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/
- smart-turn-v2 model: https://developers.cloudflare.com/workers-ai/models/smart-turn-v2/
- ai-tts-stt example: https://github.com/cloudflare/realtime-examples/tree/main/ai-tts-stt
- Mark's demo: https://cf-realtime-audio.not-a-single-bug.workers.dev/
- Existing realtime-agents package: https://www.npmjs.com/package/@cloudflare/realtime-agents
- Existing realtime-agents docs: https://developers.cloudflare.com/realtime/agents/getting-started/
- Pipecat: https://docs.pipecat.ai/
- LiveKit Agents: https://livekit.io/field-guides/agents
