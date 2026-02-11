# Voice Agents on the Agents SDK

## The opportunity

There is no voice agent framework in JavaScript that runs on the edge. Pipecat is Python-only. LiveKit has a Node.js SDK, but it requires a long-running server process, native WebRTC bindings, and persistent connections to a LiveKit SFU — it does not work in Workers or any edge runtime. Vapi is hosted and opaque. The JS/TS developer population building on serverless and edge platforms has zero options for building voice agents.

The Agents SDK is uniquely positioned to fill this gap because it already has the primitives that turn a voice _pipeline_ into a voice _agent_: persistent state, SQL, scheduling, MCP tool use, workflows, React hooks, and bidirectional state sync. No other voice framework has any of these. They treat conversations as ephemeral. We don't.

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

| Capability                | What exists                                                           | Why it matters for voice                                     |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Durable Object base class | `Agent` extends partyserver `Server` — full DO lifecycle, hibernation | Agent's "brain" persists across conversations                |
| Bidirectional state sync  | `setState()` broadcasts to all clients, clients can push back         | Real-time UI updates (transcripts, status, voice indicators) |
| RPC                       | `@callable` methods, streaming via `StreamingResponse`                | Call agent methods from UI (start/stop, change settings)     |
| Scheduling                | Cron, delays, intervals in SQLite                                     | "Remind me tomorrow", session timeouts, proactive agents     |
| SQL                       | `this.sql` template tag with SQLite                                   | Conversation history, user preferences, knowledge base       |
| MCP client                | `MCPClientManager` with OAuth, auto-reconnect                         | Tool use during voice — agent can actually DO things         |
| Workflows                 | `AgentWorkflow` for multi-step orchestration                          | Complex voice-driven processes                               |
| WebSocket connections     | Connection management, broadcast, hibernation                         | The transport already exists                                 |
| React hooks               | `useAgent` with typed RPC stubs, state sync                           | Extend to `useVoiceAgent` for voice UI                       |
| Observability             | Event emission system                                                 | Track latency, model usage, conversation quality             |
| Email routing             | `routeAgentEmail()`, `onEmail()`                                      | Multi-channel: same agent, voice + email + chat              |

---

## The vision

### What makes this special vs. Pipecat, LiveKit, Vapi

**1. Stateful voice agents.** Every existing framework treats conversations as ephemeral. Here, the DO _is_ the agent's long-term memory. Conversations survive disconnects. The agent remembers what you talked about yesterday. Transformative for customer service, personal assistants, workflows that span sessions.

**2. Tool use during conversation (MCP).** The agent can actually do things mid-call. "Book me a table at Ocean Prime for 7pm" → MCP tool call → real booking → "Done, confirmed for 7pm." Not "I'll send you a link." Actual execution.

**3. Hybrid modality.** Same agent, same state, accessible via voice OR text OR API. Start a voice call on your phone, get disconnected, continue via text on your laptop. The agent doesn't care how you're talking to it.

**4. Scheduling = proactive agents.** "Remind me to call the dentist at 3pm" → `this.schedule()` → agent initiates at 3pm. The agent doesn't just respond, it can initiate.

**5. Zero infrastructure.** Write a class, deploy. No SFU to configure, no servers to manage, no API keys for basic functionality (Workers AI binding).

**6. JavaScript.** First voice agent framework in JS. Massive developer reach. Frontend developers who build voice UIs can now build the agents too, in the same language.

**7. Edge-native latency.** DO, SFU (if used), and AI models all on Cloudflare's edge. The entire roundtrip stays within the network. For voice, every 100ms matters.

### Actual developer experience (implemented)

Server side:

```typescript
import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

class RestaurantAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    const ai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: ai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      system: "You are a restaurant booking assistant...",
      messages: [
        ...context.messages.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      tools: { book_table: tool({...}) },
      abortSignal: context.signal
    });
    return result.textStream; // streamed through sentence chunker → TTS
  }

  async onCallStart(connection) {
    await this.speak(connection, "Hi! I can help you find a restaurant.");
  }
}
```

Client side (React):

```tsx
import { useVoiceAgent } from "agents/voice-react";

function VoiceUI() {
  const {
    status, // "idle" | "listening" | "thinking" | "speaking"
    transcript, // TranscriptMessage[]
    connected,
    startCall,
    endCall,
    toggleMute
  } = useVoiceAgent({ agent: "restaurant-agent" });

  return <div>...</div>;
}
```

Client side (vanilla JS):

```typescript
import { VoiceClient } from "agents/voice-client";

const client = new VoiceClient({ agent: "restaurant-agent" });
client.addEventListener("statuschange", () => console.log(client.status));
client.connect();
await client.startCall();
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

### Layer 0: Proof of concept — DONE

**Goal:** Prove the architecture works with zero SDK changes.

**What was built:** `examples/voice-agent` — a fully working voice agent running inside a single Durable Object. Features: streaming TTS (sentence-level chunking), server-side VAD (smart-turn-v2), interruption handling, conversation persistence (SQLite), AI SDK tools (time, reminders, weather), proactive scheduling (spoken reminders).

**Key artifacts:**

- `examples/voice-agent/src/server.ts` — now ~130 lines (uses `VoiceAgent` from Layer 2)
- `examples/voice-agent/src/client.tsx` — ~270 lines (uses `useVoiceAgent` from Layer 1)
- `examples/voice-agent/src/sentence-chunker.ts` — moved to SDK in Layer 2

### Layer 1: Client-side audio utilities — DONE

**Goal:** Make the browser-side audio code reusable.

**What was built:** Two SDK exports with zero npm dependencies:

- `agents/voice-client` — `VoiceClient` class (~520 lines). Framework-agnostic. Handles `getUserMedia()` with AEC constraints, AudioWorklet PCM encoding/downsampling, binary WebSocket framing via PartySocket, audio playback queue with `AudioContext.decodeAudioData`, silence detection (configurable threshold + duration), interruption detection (configurable threshold + chunk count), and the full voice protocol (status, transcript streaming, metrics, error). Event-based API (`addEventListener`).

- `agents/voice-react` — `useVoiceAgent` hook (~100 lines). Thin React wrapper around `VoiceClient` that syncs state into `useState`. Returns `{ status, transcript, metrics, audioLevel, isMuted, connected, error, startCall, endCall, toggleMute }`.

**Tests:** 23 tests for `useVoiceAgent` (mocks PartySocket, tests protocol handling, state machine, actions).

### Layer 2: Server-side pipeline helpers — DONE

**Goal:** Extract the voice pipeline from the example into a reusable SDK base class.

**What was built:** `agents/voice` export (~830 lines):

- `VoiceAgent<Env, State>` extends `Agent` — handles the full pipeline:
  - `onMessage` intercept — routes binary (audio) vs JSON (voice protocol) vs non-voice messages
  - Audio buffer management — per-connection `Map<string, ArrayBuffer[]>` with cleanup on disconnect
  - VAD gate — `checkEndOfTurn()` with configurable threshold and window
  - STT — `transcribe()` with Workers AI default
  - Streaming TTS pipeline — `SentenceChunker` + concurrent TTS queue + ordered drain loop
  - Interruption handling — `AbortController` per connection, propagated to `onTurn` via `context.signal`
  - Conversation persistence — auto-creates SQLite table, auto-saves user/assistant messages
  - Protocol messages — status, transcript (streaming), metrics, error

- Provider interfaces: `STTProvider`, `TTSProvider`, `VADProvider` — defaults use Workers AI, override methods for custom providers

- User hooks: `onTurn()` (required — returns `string | AsyncIterable<string>`), `onCallStart()`, `onCallEnd()`, `onInterrupt()`, `onNonVoiceMessage()`

- Convenience: `speak(connection, text)`, `speakAll(text)`, `saveMessage()`, `getConversationHistory()`

- `SentenceChunker` — moved from example to `packages/agents/src/sentence-chunker.ts` with 14 tests

**Design decision: class extension, not composition.** `VoiceAgent extends Agent` follows the `AIChatAgent` pattern. The `voicePipeline()` config approach from the original roadmap was replaced with method overrides — simpler, more TypeScript-native, and consistent with the existing codebase.

**Design decision: `onTurn` return type.** Accepts both `string` (simple) and `AsyncIterable<string>` (streaming). The SDK detects the type: strings get synthesized as one TTS call, async iterables get piped through the sentence chunker for streaming TTS with low time-to-first-audio.

**Zero npm dependencies added.** Workers AI models are bindings, audio handling is pure TS, pipeline logic is TypeScript.

**Post-Layer 2 additions:**

- **Pipeline hooks** — four overridable methods between pipeline stages: `beforeTranscribe(audio, connection)`, `afterTranscribe(transcript, connection)`, `beforeSynthesize(text, connection)`, `afterSynthesize(audio, text, connection)`. Return `null` to skip a stage. Runs in both streaming and non-streaming paths, and in `speak()`/`speakAll()`. Inspired by Pipecat's frame processor model — gives advanced users pipeline composability without a full frame/processor architecture.
- **Language configuration** — `voiceOptions.language` (default `"en"`) passed to STT. No longer hardcoded.
- **AudioContext lifecycle fix** — VoiceClient now uses a single shared `AudioContext` for playback and mic capture, properly closed on `endCall()`.
- **`speak()`/`speakAll()` hook consistency** — convenience methods now route through `beforeSynthesize`/`afterSynthesize` so recording hooks, pronunciation filters, etc. apply to greetings and reminders.

### Layer 3: Provider ecosystem and advanced patterns — IN PROGRESS

**Goal:** Open it up without adding complexity to the core.

**What has been built:**

- `@cloudflare/agents-voice-elevenlabs` — reference TTS provider package. Implements `TTSProvider` with the ElevenLabs API. Published as a standalone npm package. Pattern: override `synthesize()` on `VoiceAgent` and delegate to the provider class.
- Pipeline hooks enable custom processing without provider packages (e.g., `beforeSynthesize` for pronunciation fixes).

**Provider pattern (actual, implemented):**

```typescript
import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
import { ElevenLabsTTS } from "@cloudflare/agents-voice-elevenlabs";

class MyAgent extends VoiceAgent<Env> {
  #tts: ElevenLabsTTS | null = null;

  #getTTS() {
    if (!this.#tts) {
      this.#tts = new ElevenLabsTTS({ apiKey: this.env.ELEVENLABS_API_KEY });
    }
    return this.#tts;
  }

  async synthesize(text: string) {
    return this.#getTTS().synthesize(text);
  }

  async onTurn(transcript: string, context: VoiceTurnContext) { ... }
}
```

**Multi-modal** — voice + text on the same agent (implemented via `onNonVoiceMessage`):

```typescript
class MyAgent extends VoiceAgent<Env> {
  onNonVoiceMessage(connection, message) {
    // text chat — same agent, same state, same conversation history
  }

  async onTurn(transcript, context) { ... }
}
```

Client connects via `useVoiceAgent()` for voice or `useAgent()` for text. Same instance, same state, same tools.

**Proactive voice** (scheduling + voice, implemented):

```typescript
async onTurn(transcript, context) {
  // schedule() and speakAll() are built into VoiceAgent
  return "Got it, I'll remind you.";
}

async speakReminder(payload: { message: string }) {
  await this.speakAll(`Reminder: ${payload.message}`);
}
```

**Still needed:**

- More provider packages: Deepgram STT (direct API), OpenAI Whisper STT, Cartesia TTS
- Documented multi-modal pattern (voice + text chat on same agent)
- Structured conversation flows (Pipecat Flows equivalent)

**Timeline:** Ongoing, community-driven.

### Layer 4: Telephony, SFU, handoffs — STARTED

**Goal:** Multi-channel distribution. The same agent answers web, phone, text, and email.

**What has been built:**

- `@cloudflare/agents-voice-twilio` — Twilio Media Streams adapter. Bridges Twilio's bidirectional WebSocket protocol (mulaw 8kHz, base64 JSON) to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). Handles mulaw decode/encode and sample rate conversion. Phone calls are routed to the same VoiceAgent Durable Object that handles web voice and text chat.
- Agent handoff documentation — two patterns (client-side reconnect, server-side context transfer) documented in `docs/voice.md`.
- SFU WebSocket adapter guide — documented how to bridge Cloudflare Realtime SFU WebRTC audio to VoiceAgent for use cases that need WebRTC-grade quality.

**Decisions on what is IN scope:**

1. **Telephony adapters** — thin packages that bridge provider WebSocket audio to VoiceAgent. Twilio is the first. Telnyx, Vonage, Plivo follow the same pattern. The SDK does NOT provision phone numbers — users bring their own from the telephony provider.
2. **Agent handoff patterns** — documented, not built into SDK. Client-side handoff (disconnect/reconnect) and server-side context transfer (DO-to-DO RPC) are both viable. No special SDK machinery needed.
3. **SFU integration** — documented as a guide, not SDK code. For the 5% of use cases that need WebRTC, use Cloudflare SFU with WebSocket adapter. The SDK stays WebSocket-native.

**Decisions on what is OUT of scope:**

1. **Video** — different modality, different models, different compute requirements. If built, it should be a separate feature (`VisionAgent`?), not bolted onto VoiceAgent.
2. **RealtimeKit integration** — RTK is a meetings product. Coupling to it requires meeting creation, auth tokens, participant management, and destroys the "zero infrastructure" story. If someone needs AI in a meeting, they bridge RTK audio to VoiceAgent via SFU WebSocket adapter.
3. **Agent-to-agent audio** — agents talking to each other via audio is wasteful. Use text/RPC for inter-agent communication. "Voice handoffs" are actually client reconnects, not audio-to-audio between DOs.
4. **Phone number provisioning** — not the SDK's job. Twilio/Telnyx/Vonage handle this.

**The multi-channel story:**

```
Web browser    →  VoiceClient (WebSocket)     →  ┐
Phone call     →  Twilio adapter (WebSocket)  →  ├→  VoiceAgent (Durable Object)
Text chat      →  sendText (WebSocket)        →  ┤     • same state
Email          →  routeAgentEmail (HTTP)      →  ┘     • same conversation history
                                                        • same tools / scheduling
```

No other platform can tell this story. One agent, every channel, same instance.

---

## Summary

| Layer | What                              | New deps      | Status      | Ships as                                     |
| ----- | --------------------------------- | ------------- | ----------- | -------------------------------------------- |
| **0** | Working example, proof of concept | Zero          | **Done**    | `examples/voice-agent`                       |
| **1** | Client-side audio utilities       | Zero          | **Done**    | `agents/voice-client`, `agents/voice-react`  |
| **2** | Server-side pipeline + hooks      | Zero          | **Done**    | `agents/voice` export                        |
| **3** | Provider ecosystem, multi-modal   | User's choice | **Started** | `@cloudflare/agents-voice-elevenlabs` + docs |
| **4** | Telephony, SFU, handoffs          | User's choice | **Started** | `@cloudflare/agents-voice-twilio` + guides   |

**Layers 0 through 2 added zero npm dependencies to the Agents SDK.** Workers AI models are bindings, audio handling is Web APIs and pure JS, the pipeline is TypeScript.

---

## Competitive landscape

| Framework          | Language              | Transport                             | State                       | Tool use       | Scheduling            | Infra required       |
| ------------------ | --------------------- | ------------------------------------- | --------------------------- | -------------- | --------------------- | -------------------- |
| **Pipecat**        | Python                | WebRTC (via Daily/LiveKit), WebSocket | None                        | Limited        | None                  | Python server        |
| **LiveKit Agents** | Go/Python/Node.js     | WebRTC (LiveKit SFU)                  | None                        | Limited        | None                  | LiveKit server/cloud |
| **Vapi**           | Hosted API            | WebRTC                                | None (API calls)            | Limited        | None                  | Vapi subscription    |
| **Agents SDK**     | JavaScript/TypeScript | WebSocket (built-in)                  | SQLite + bidirectional sync | MCP (built-in) | Cron/delays/intervals | `wrangler deploy`    |

Detailed competitive analyses with architecture comparisons, gap assessments, and strategic recommendations:

- [design/voice-livekit.md](/design/voice-livekit.md) — LiveKit Agents: process-per-session model, 80+ provider plugins, telephony, speech-to-speech. Our structural advantage: Durable Object persistence.
- [design/voice-pipecat.md](/design/voice-pipecat.md) — Pipecat: frame/processor pipeline model (more composable), 80+ integrations, telephony depth. Python-only, no persistence. Best idea to steal: pipeline composability.
- [design/voice-vapi.md](/design/voice-vapi.md) — Vapi: managed service (not a framework), proprietary orchestration models (endpointing, backchanneling, emotion detection, filler injection). Best idea to steal: conversation quality via orchestration.

---

## Open questions

### Punted

- **Wire protocol**: What's the right format for audio frames over WebSocket? Raw PCM? Opus-encoded? What sample rate and chunk size minimize latency while keeping bandwidth reasonable? _Punted: this is a transport detail. Whatever format audio arrives in, the pipeline does the same thing. Can swap later without touching pipeline logic._
- **Latency budget**: Competitive voice agents target <500ms end-to-end (user stops speaking → agent starts speaking). Is that achievable with Workers AI models + WebSocket transport? _Punted: the number matters for tuning, but the architecture that improves it is streaming TTS, which we're building anyway. Measure after streaming is in._

### Analyzed: Hibernation and voice sessions

Hibernation is ON by default (`static options = { hibernate: true }`). The DO evicts from memory when no JS is executing, but WebSocket connections and SQLite data survive.

**What survives hibernation:** WebSocket connections (platform-managed), SQLite (`cf_voice_messages`), scheduled alarms.

**What is lost on eviction:** `#audioBuffers` (accumulated PCM chunks), `#activePipeline` (AbortControllers for in-flight pipelines), any in-progress TTS synthesis or LLM streams.

**When can hibernation happen during a voice call?** Only during pauses — when the pipeline finishes and the agent is "listening" but no audio chunks are arriving (user is silent, muted, or thinking). The window is small because even silence produces low-level audio data from the mic, but it is possible with a muted mic or very long pause.

**Edge cases identified:**

1. **Audio buffer loss during silence gaps.** User speaks, pauses mid-thought (no `end_of_speech` yet), DO hibernates, `#audioBuffers` evicted. When user resumes, pre-pause audio is gone. Worst case: one missed utterance. Unlikely in practice because the 500ms silence timer fires quickly.

2. **Orphaned fetch requests.** If the DO hibernates while an LLM stream or TTS fetch is in-flight (very unlikely — JS is actively executing during pipeline), the AbortController is lost and the fetch is orphaned. No way to cancel it on wake.

3. **`onConnect` sends wrong status on wake.** When the DO wakes from hibernation, partyserver calls `onConnect` for the connection that triggered it. Our `onConnect` sends `{ type: "status", status: "idle" }`. If the user was mid-call, this incorrectly tells the client the call ended. **This is a real bug** — the client receives "idle" while audio is still flowing from the mic.

4. **`onStart` re-runs on wake.** Our `onStart` is idempotent (`CREATE TABLE IF NOT EXISTS`), so this is fine. But user overrides that are not idempotent (e.g., sending a greeting, incrementing a counter) would re-fire.

5. **PartySocket reconnect does not restore call state.** `VoiceClient` uses `PartySocket` (auto-reconnecting WebSocket). If the connection drops and reconnects, the client does not re-send `start_call` — it just sets `connected = true`. The user must manually restart the call.

**Recommended fixes (in order of priority):**

1. **Keepalive during active calls.** Start a `setInterval` on `start_call` (e.g., every 5 seconds, execute a no-op) to keep JS running and prevent hibernation. Stop on `end_call`/`onClose`. This is the most robust solution — prevents all hibernation edge cases during active calls. Cost: DO stays alive (billable) for the duration of the call, which it should be anyway.

2. **Smarter `onConnect` status.** Track active call state in SQLite (survives hibernation). On `onConnect`, check if the connection was previously in a call and restore the correct status instead of always sending "idle". Alternatively, use partyserver's per-connection `.state` (also survives hibernation) to store call status.

3. **Accept buffer loss gracefully.** Even with the keepalive, there may be edge cases. The pipeline already handles empty/short buffers (returns to "listening" if audio is too short). No additional code needed — just document that mid-pause audio may be lost in extreme hibernation scenarios.

### Resolved

- ~~What's the right abstraction boundary for the voice pipeline?~~ **Resolved.** `VoiceAgent` class extension with `onTurn()` hook. The `voicePipeline()` config approach was replaced with method overrides — simpler and more consistent with the `AIChatAgent` pattern.
- ~~How should conversation history be managed?~~ **Resolved.** Automatic rolling window in SQLite (`cf_voice_messages` table), configurable limit (default 20), loaded into `context.messages` for every `onTurn()` call.
- ~~Can we support streaming TTS?~~ **Done.** See "Streaming TTS implementation" below.
- ~~Interruption handling?~~ **Done.** See "Interruption handling implementation" below.
- ~~Server-side VAD?~~ **Done.** See "Server-side VAD implementation" below.

### Resolved (post-Layer 2)

- ~~Should there be lower-level hooks for partial transcripts or audio-level events on the server side?~~ **Resolved.** Added four pipeline hooks: `beforeTranscribe(audio)`, `afterTranscribe(transcript)`, `beforeSynthesize(text)`, `afterSynthesize(audio, text)`. Each can modify data or return `null` to skip. Hooks run in both the streaming and non-streaming paths, and in `speak()`/`speakAll()` convenience methods.
- ~~What does the third-party provider packaging story look like?~~ **Resolved.** Built `@cloudflare/agents-voice-elevenlabs` as the reference implementation. Pattern: standalone npm package implementing `TTSProvider`, used via method override delegation in `VoiceAgent.synthesize()`. Same pattern works for STT and VAD.

### Active

- How should multi-modal (voice + text on the same agent) work? The `onNonVoiceMessage` hook exists but there is no built-in text-to-voice bridging.
- Should `VoiceAgent` support speech-to-speech models (OpenAI Realtime API, Gemini Live)? Current decision: punt — users who want this can wire it up manually, and `call-my-agent` example already covers the pattern.
- Interruption classification: distinguishing "stop" from "uh-huh" before aborting the pipeline. No Workers AI model for this currently. Heuristic (keyword list) is the likely first approach when we get to it.

## Streaming TTS implementation

Implemented in `examples/voice-agent` — the key improvement for time-to-first-audio.

### Architecture

```
LLM (streaming) → SentenceChunker → TTS (per sentence, concurrent) → audio to client
```

**Timeline visualization:**

```
LLM:   [--tok--tok--SENT1--tok--tok--SENT2--tok--DONE]
TTS:            [----TTS(S1)----]  [----TTS(S2)----] [--TTS(flush)--]
Audio:                          [send S1]          [send S2]       [send flush]
```

The user hears the first sentence while the LLM is still generating the rest.

### Key components

1. **`sentence-chunker.ts`** — isolated, testable module. Accumulates streaming tokens and emits complete sentences. Splits on `.` `!` `?` followed by space, with a minimum length threshold (20 chars) to avoid splitting on abbreviations. Intentionally simple — optimize later.

2. **`streamingPipeline()` in server.ts** — orchestrates the flow:
   - Streams LLM tokens via `{ stream: true }` option to Workers AI
   - Feeds tokens into `SentenceChunker`
   - Starts TTS for each sentence eagerly (promises execute concurrently)
   - A concurrent drain loop sends audio to the client in order
   - Uses a notify/wake pattern to avoid polling

3. **Streaming transcript on client** — new message types:
   - `transcript_start` — adds empty assistant message
   - `transcript_delta` — appends token to current message (user sees text appear token-by-token)
   - `transcript_end` — finalizes with full text

### Protocol changes

New Server → Client messages:

```
{ type: "transcript_start", role: "assistant" }   // stream begins
{ type: "transcript_delta", text: "token" }         // each LLM token
{ type: "transcript_end", text: "full response" }   // stream ends
[binary MP3]                                         // audio per sentence (multiple)
```

### Future optimisation (sentence chunking)

The current chunker is deliberately naive — split on sentence-ending punctuation. Known limitations:

- Abbreviations like "Dr." or "U.S." can cause false splits if the preceding text is long enough
- No special handling for quotes, parentheses, or lists
- No consideration of prosody-friendly splitting (e.g. splitting on commas for long clauses)

The chunker is a standalone module with 14 tests (`sentence-chunker.test.ts`), so it can be improved without touching the pipeline.

## Interruption handling implementation

Implemented in `examples/voice-agent` — lets the user cut off the agent mid-sentence.

### How it works

```
User speaks during agent playback
  → Client detects sustained speech (RMS > 0.02 for ≥2 chunks / ~200ms)
  → Client stops active AudioBufferSourceNode, clears playback queue
  → Client sends { type: "interrupt" } to server
  → Server aborts active pipeline (LLM stream, in-flight TTS), clears audio buffer
  → Server sets status to "listening"
  → User's new speech is captured normally
```

### Client changes (`client.tsx`)

- `activeSourceRef` tracks the currently playing `AudioBufferSourceNode` so it can be `.stop()`'d
- `interruptChunkCountRef` counts consecutive high-RMS audio chunks during playback — requires `INTERRUPT_CHUNKS_NEEDED` (2) consecutive chunks above `INTERRUPT_THRESHOLD` (0.02) to trigger, preventing false triggers from audio artifacts leaking through echo cancellation
- On interrupt: stop source, clear queue, reset `isPlayingRef`, send `{ type: "interrupt" }` to server

### Server changes (`server.ts`)

- New `"interrupt"` case in `onMessage` switch
- `handleInterrupt(connection)`: aborts the active pipeline via `AbortController`, clears audio buffers, sends status "listening" — reuses the same abort pattern as `handleEndCall`

### Design decisions

- **Higher threshold for interrupt vs silence detection** (0.02 vs 0.01): the mic picks up some of the agent's audio even with echo cancellation enabled. A higher bar avoids the agent interrupting itself.
- **Chunk-count debounce instead of timer**: simpler, no setTimeout, and naturally adapts to the audio chunk rate (~100ms/chunk).
- **Server abort is fire-and-forget**: no acknowledgment needed. The `AbortController` signal propagates through the LLM stream and any in-flight TTS requests.

## Server-side VAD implementation

Implemented in `examples/voice-agent` — uses `@cf/pipecat-ai/smart-turn-v2` to validate end-of-speech before starting the pipeline.

### Approach: hybrid client + server

```
Client detects 500ms silence → sends end_of_speech
  → Server receives end_of_speech, concatenates audio buffer
  → Server runs smart-turn-v2 on last ~2s of audio
  → If is_complete OR probability > 0.5 → proceed with STT + LLM + TTS
  → If not → push audio back to buffer, send status "listening", keep accumulating
```

The client silence timer (500ms) acts as a free pre-filter. The VAD model only runs when the client thinks speech ended — not continuously. This keeps costs low ($0.00034/audio-min, but only called on silence events, not every frame).

### `checkEndOfTurn()` method

- Extracts the last ~2 seconds of audio from the buffer (64KB at 16kHz mono 16-bit)
- Wraps in WAV header (same `pcmToWav` helper used by STT)
- Sends to `@cf/pipecat-ai/smart-turn-v2` as a ReadableStream
- Returns `{ isComplete, probability }`
- On error, fails open (returns `isComplete: true`) — never blocks the pipeline due to a VAD failure

### Latency tuning

- Silence timer reduced from 800ms to 500ms (VAD compensates for the lower confidence of a shorter silence)
- Total pre-pipeline latency: ~500ms silence + ~100-200ms VAD ≈ 600-700ms
- Net improvement: slightly faster than the original 800ms, with better accuracy (fewer false triggers on mid-sentence pauses)
- VAD probability threshold: 0.5 — proceed if `is_complete` is true OR probability exceeds 0.5. The model sometimes returns `is_complete: false` with high probability on short utterances.
- `vad_ms` is included in the metrics sent to the client for visibility

### Protocol changes

New Client → Server message:

```
{ type: "interrupt" }  // user spoke during playback
```

Updated metrics message:

```
{ type: "metrics", vad_ms, stt_ms, llm_ms, tts_ms, first_audio_ms, total_ms }
```

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
