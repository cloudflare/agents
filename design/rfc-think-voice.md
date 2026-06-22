Status: proposed (spike + design note)

# RFC: Voice in Think — spike and design note

This is a **spike + design note**, not a finished API RFC. It characterizes what
exists, defines a prototype to de-risk the unknowns, and recommends a direction.
The full implementation RFC follows once the spike confirms the open transport
and latency questions.

Related:

- [rfc-think-channels.md](./rfc-think-channels.md) — **seam shipped**: the `kind: "voice"` channel, `transport: "voice"` ingress, `deliverNotice({ channel: "voice" })`, and `DeliveryKind`/`turnEnded` are all built; this note fills the remaining audio-transport seam
- [rfc-think-turns.md](./rfc-think-turns.md) — an utterance dispatches `runTurn({ channel: "voice", mode: "stream" })`; barge-in maps to `cancelChat`
- [rfc-think-actions.md](./rfc-think-actions.md) — spoken approval prompts and `attachReply({ type: "voice_note" })`
- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) — interruption/recovery model (reuse the #1644 interrupted-reply handling)
- `packages/voice/` — the existing `@cloudflare/voice` package
- Strategy plan: `think_api_strategy` (Recommendation 5)

## What exists today

`@cloudflare/voice` (v0.3.1) is a **mixin over `Agent`**, fully parallel to
Think:

- `withVoice(Agent)` (`packages/voice/src/voice.ts:195`) adds a complete voice
  pipeline: per-call continuous STT session, streaming TTS with sentence
  chunking (`#streamingTTSPipeline`, `voice.ts:843`), barge-in
  (`#handleBargeIn`, `voice.ts:591`), interrupt, metrics, and binary audio
  transport.
- **Its own WS protocol** (`types.ts`, `VOICE_PROTOCOL_VERSION = 1`): client →
  server `hello | start_call | end_call | start_of_speech | end_of_speech |
interrupt | text_message`; server → client `welcome | status | audio_config |
transcript* | playback_interrupt | metrics | error`; **binary `ArrayBuffer`
  frames are audio**.
- **Its own turn loop**: `onTurn(transcript, ctx): Promise<TextSource>`
  (`voice.ts:338`) — the app returns a string / `AsyncIterable<string>` /
  `ReadableStream`. The playground example
  ([examples/playground/src/demos/voice/voice-agent.ts](../examples/playground/src/demos/voice/voice-agent.ts))
  calls `streamText` inline; nothing touches Think.
- **Its own transcript store**: `cf_voice_messages` (`voice.ts:240`), separate
  from Think's Session tree.
- Providers `WorkersAIFluxSTT` / `WorkersAINova3STT` / `WorkersAITTS`, a
  `VoiceClient`, React hooks (`voice-react.tsx`), and SFU utilities
  (`sfu-utils.ts`) for WebRTC transport.

Crucially, **coexistence with the agents WS is already a solved pattern**: the
mixin overrides `onMessage` (`voice.ts:282`) and intercepts only the voice
message types plus binary audio; **everything else passes through** to the
prior `_onMessage`. So a Think chat protocol frame (`MSG_CHAT_*`) would flow
straight through an installed voice interceptor untouched.

What is missing for the product story ("Think supports voice agents"): voice has
**no Think turns, sessions, actions, recovery, channels, or notices**. The
customer who left `AIChatAgent` needed exactly that — a channel runtime, not a
chat-protocol adapter — and `@cloudflare/voice` does not provide the durable
agent brain, only the voice plumbing.

## The problem / why a spike before a full RFC

The strategy wants voice as a first-class Think capability, modeled as a channel
(parent plan, Recommendation 5). But four questions are risky enough to
prototype before committing to an API:

1. **Transport coexistence** of binary audio + voice control frames with Think's
   WS chat protocol on a single Durable Object.
2. **API surface**: `getVoice()` vs `configureVoice()` vs a `voice` property vs a
   `configureChannels()` entry.
3. **Package migration**: absorb `@cloudflare/voice` into Think, depend on it, or
   bridge.
4. **Is voice literally a channel**, or a parallel surface that reuses turns?

A wrong call on any of these is expensive to undo, and latency (first-audio) is a
hard product constraint, so we spike first.

## Goals of the spike

- De-risk transport coexistence (audio + voice JSON vs `MSG_CHAT_*` on one DO/WS)
  with no frame cross-talk.
- Validate the loop **STT utterance → `runTurn({ channel: "voice", mode:
"stream" })` → text stream → TTS** against Think's real turn engine, and
  measure first-audio latency vs the inline `onTurn` baseline.
- Validate persisting voice turns into the **Think Session** (UIMessage parts)
  instead of `cf_voice_messages`.
- Validate **barge-in → `cancelChat(requestId)`** into the active Think turn +
  abort TTS, while keeping the transcriber session alive.
- Validate **`deliverNotice({ channel: "voice" })`** speaking deterministic
  status/approval without a model turn.
- Produce a confident recommendation for the API surface and package strategy.

## Non-goals

- The final production voice API (this note feeds the implementation RFC).
- New STT/TTS providers — reuse the existing ones.
- The channel contract itself — owned by the [Channels RFC](./rfc-think-channels.md),
  now **shipped**; voice is a built `ChannelKind` (`kind: "voice"`,
  `transport: "voice"`) there. This note only fills the audio transport behind
  that seam.

## The spike (what to build)

A throwaway prototype (in `experimental/` or a scratch example — **do not modify
the published packages yet**) that is a `Think` subclass which reuses
`@cloudflare/voice` primitives but routes the utterance into Think:

1. **Install the voice transport on a Think agent.** Reuse the
   `onMessage`-intercept pattern and `AudioConnectionManager` /
   `sendVoiceJSON` (`audio-pipeline.ts`), the transcriber providers,
   `SentenceChunker`, and the protocol types from `@cloudflare/voice`.
2. **Route the utterance into Think.** On `onUtterance(transcript)` call
   `this.runTurn({ channel: "voice", mode: "stream", input: transcript,
callback })` where `callback` is a `StreamCallback` whose `onEvent`
   text-deltas feed the sentence-chunked TTS pipeline. This means adapting
   `#streamingTTSPipeline` (`voice.ts:843`) to consume a `StreamCallback` /
   `AsyncIterable<string>` rather than an LLM `textStream` directly.
3. **Persist through the Think Session**, not `cf_voice_messages`, so memory /
   FTS / compaction / recovery apply.
4. **Barge-in** (`onSpeechStart` / `interrupt`) → `this.cancelChat(requestId)`
   for the active voice turn + abort the TTS pipeline; the transcriber session
   stays alive.
5. **Spoken status** via `deliverNotice({ channel: "voice" })` (no model turn).

Measurements: first-audio latency vs the inline `onTurn` baseline; whether
`MSG_CHAT_*` and voice frames coexist without cross-talk; barge-in correctness;
behavior on a DO restart mid-call.

## Spike questions and proposed answers

### Q1 — Transport coexistence

The `onMessage`-intercept pattern already proves the inbound path: voice control
frames + binary audio are intercepted; JSON chat frames pass through. Two
concrete risks the spike must confirm:

- **Outbound double-emit.** A voice turn run via `runTurn({ mode: "stream" })`
  uses the **stream sink** (an RPC-callback-like `TextStreamCallback`), **not**
  the `ws-broadcast` sink. So it must **not** also broadcast `MSG_CHAT_RESPONSE`
  to web chat clients. This mirrors how messenger delivery already uses
  `TextStreamCallback` (`delivery.ts:24`) instead of broadcasting. Confirm the
  Turns RFC `TurnSink` for voice is `rpc-callback`, never `ws-broadcast`.
- **`broadcast()` inspection.** Think's `broadcast` override inspects JSON frames
  for agent-tool forwarding (`think.ts:2739`); voice JSON frames are not
  `MSG_CHAT_RESPONSE`, so they pass through. Binary audio is sent per-connection
  (`connection.send(audio)`), and Think's chat protocol is JSON-text-only, so
  there is no binary/text ambiguity. Confirm in the spike.

Proposed answer: **coexistence works** with voice on the stream sink and audio as
binary per-connection sends; no protocol change to Think chat is needed.

### Q2 — API surface (`getVoice` vs `configureVoice` vs property)

Proposed: **voice is a channel declared in `configureChannels()`** (Channels RFC)
carrying its providers, with a thin **`getVoice()` convenience** that registers a
`kind: "voice"` channel from `{ transcriber, tts, options }`. A `voice` property
may remain as sugar, but the bare-property mixin style is not the lead API
because it does not compose with channels.

```ts
// Lead form — voice is just a channel:
configureChannels() {
  return {
    voice: voiceChannel({
      transcriber: new WorkersAIFluxSTT(this.env.AI),
      tts: new WorkersAITTS(this.env.AI),
      maxTurns: 4,
      instructions: "You are on a phone call. Keep replies short and speakable."
    })
  };
}

// Sugar — registers the voice channel for you:
getVoice() {
  return { transcriber: new WorkersAIFluxSTT(this.env.AI), tts: new WorkersAITTS(this.env.AI) };
}
```

Rationale: one mental model (channels), and per-channel policy
(`tools`/`instructions`/`maxTurns`), notices, and reply attachments come for
free from the Channels/Actions RFCs.

### Q3 — Package migration (absorb vs depend vs bridge)

Proposed: **bridge first, absorb selectively.**

- **Bridge (recommended).** Think provides the brain (turns, sessions, actions,
  recovery, notices, channels); `@cloudflare/voice` remains the voice engine
  (STT/TTS providers, `AudioConnectionManager`, `VoiceClient`, React hooks, SFU,
  protocol types). A small adapter — on the **Think** side (e.g. a
  `@cloudflare/think/voice` subpath) — maps voice ingress ↔ `runTurn` and TTS ↔
  channel delivery. This matches the repo's package-boundary preference: keep the
  adapter on the larger consumer rather than making the smaller package depend on
  the larger one.
- **Do not absorb wholesale up front.** `@cloudflare/voice` is independently
  useful over plain `Agent`; absorbing it would duplicate a maintained package
  and couple Think to provider churn. Absorb only protocol/pipeline glue if the
  spike shows the bridge is too thin to be ergonomic.
- **Do not invert the dependency** (`voice` → `think`): it would couple the small
  package to the large one and break its `Agent`-only use. Think may depend on
  `@cloudflare/voice` as an **optional/peer** dependency so non-voice Think apps
  do not pay for it.

### Q4 — Is voice literally a channel?

**Answered: yes.** The Channels RFC shipped voice as a `kind: "voice"` channel
with ingress `transport: "voice"` (STT utterance → `runTurn`) and a TTS delivery
surface. The parts that do not fit the messenger `post(text)` surface — binary
audio and interim/streaming semantics — are exactly why the Channels RFC made the
delivery surface kind-specific and added `DeliveryKind` (`final | interim |
notice | command`) + `turnEnded`. The seam (`kind: "voice"`,
`deliverNotice({ channel: "voice" })`, per-channel policy) is now real; the spike
only needs to fit the **audio transport** behind it. **Fallback retained:** if the
spike finds the audio transport cannot fit the channel delivery-surface contract,
voice can still fall back to a _parallel surface that reuses turns_ (keeps its own
transport but still calls `runTurn`).

## Interruption and recovery policy (explicit)

- **Barge-in / interrupt:** abort TTS immediately
  (`AudioConnectionManager.abortPipeline` + `playback_interrupt`),
  `cancelChat(requestId)` the active Think turn. Think may persist partial text
  and mark the turn `aborted`; the **transcriber session stays alive**. Settled
  server actions are **not** replayed (Actions ledger). This reuses the messenger
  interrupted-reply model (#1644, `delivery.ts:383`).
- **Recovery:** a dropped call cannot replay audio, but the turn/transcript is
  recoverable via the Think Session + recovery engine. On interruption, **speak a
  deterministic apology/notice** rather than replaying partial audio — the voice
  analogue of the messenger "apologize" recovery mode
  (`messengerReplyRecoveryMode`, `delivery.ts:249`).

## Session store reconciliation

Think-backed voice writes user/assistant turns as **Think Session UIMessages**
(with optional voice metadata such as `metadata.channel: "voice"` and audio
timing), gaining memory / FTS / compaction / recovery. `cf_voice_messages`
(`voice.ts:240`) remains only for the standalone `withVoice(Agent)` path
(back-compat), not for Think-backed voice.

## Coordination with the other RFCs

- **Channels RFC (shipped):** voice is the built `kind: "voice"` channel; this
  note fills the audio-transport seam behind it. `DeliveryKind`/`turnEnded` and
  `deliverNotice({ channel: "voice" })` are now real and are precisely what voice
  needs for spoken status/approval. The voice transport spike is **unblocked**.
- **Turns RFC:** utterance → `runTurn({ channel: "voice", mode: "stream",
callback })`; barge-in → `cancelChat(requestId)`. Voice uses the stream sink,
  never `ws-broadcast`.
- **Actions RFC:** approval prompts are spoken via a notice + the stable approval
  descriptor; server actions are preferred over browser client tools in a
  voice-only surface (the parent plan flags client tools as awkward for voice).
  `attachReply({ type: "voice_note" })` decides whether final text becomes audio.

## Versioning and compatibility

- `@cloudflare/voice` stays published and `Agent`-compatible (no breaking change).
- Think voice ships additively: the `kind: "voice"` channel plus
  `getVoice()`/`configureChannels()` voice entry. Pre-1.0 minor + changeset.

## Alternatives

- **Absorb everything into Think now.** Fastest single story, but duplicates a
  maintained package and couples Think to provider churn. Rejected as the first
  step; revisit if the bridge proves too thin.
- **Keep voice fully separate (status quo).** Leaves the customer pain (no
  actions/recovery/sessions/channels in voice). Rejected.
- **Voice as a parallel surface, not a channel.** Simpler transport story but
  loses unified notices/attachments/per-channel policy. Kept only as the spike's
  fallback if Q4 fails.

## Open questions

- Whether binary audio should ever share the chat WS in production or always use
  a separate transport/SFU (`VoiceTransport` already abstracts this,
  `types.ts:222`).
- Multi-connection voice (`speakAll`, `voice.ts:451`) vs the single-call
  assumption under Think turns.
- Whether `getVoice()` is its own hook or purely a `configureChannels()` entry
  (leaning: `configureChannels()` entry + `getVoice()` sugar).
- Client story: does `@cloudflare/voice/react` + `VoiceClient` stay the client,
  now pointed at a Think agent endpoint?
- Whether `#streamingTTSPipeline` should be extracted from `@cloudflare/voice`
  into a reusable consumer of `StreamCallback`/`AsyncIterable<string>` so Think
  can drive it without importing the whole mixin.

## Implementation notes (for a fresh session)

Line numbers are approximate (captured at writing time); search by symbol first.

Where things live:

- Voice package: `packages/voice/src/` — `voice.ts` (`withVoice`,
  `#streamingTTSPipeline`, `#runPipeline`, `#handleStartCall`, `#handleBargeIn`,
  `onTurn`), `types.ts` (protocol + `TTSProvider`/`StreamingTTSProvider`/
  `Transcriber`), `audio-pipeline.ts` (`AudioConnectionManager`,
  `sendVoiceJSON`), `sentence-chunker.ts`, `workers-ai-providers.ts`,
  `voice-client.ts`, `voice-react.tsx`, `sfu-utils.ts`. Example:
  `examples/playground/src/demos/voice/voice-agent.ts`.
- Think hooks to bridge into (`packages/think/src/think.ts`): `runTurn` (Turns
  RFC) / `chat` / `cancelChat`, Session persistence (`_appendMessageToHistory`),
  `configureChannels` + `deliverNotice` (Channels RFC), `getMessengerContext`/
  `_activeMessengerContext` for channel context.
- Build/test: `packages/voice` has `test:workers`/`test:react`; Think
  `test:workers`. Repo gate `pnpm run check`; changeset required; no `any`, use
  `import type`.

Spike steps:

1. Stand up the voice transport on a `Think` subclass (reuse the
   `onMessage`-intercept + `AudioConnectionManager`).
2. Route `onUtterance` → `runTurn({ channel: "voice", mode: "stream", callback })`
   feeding the sentence-chunked TTS pipeline.
3. Persist via the Think Session (drop `cf_voice_messages`).
4. Barge-in → `cancelChat` + abort TTS; keep the transcriber session.
5. `deliverNotice({ channel: "voice" })` for spoken status.
6. Measure first-audio latency, coexistence (no frame cross-talk), and recovery
   on DO restart mid-call.
7. Fold findings back into this note and promote it to a full Voice RFC.

## The decision

_Pending spike._ Proposed direction: **bridge `@cloudflare/voice` behind Think**,
model voice as a `kind: "voice"` channel, dispatch each utterance via
`runTurn({ channel: "voice", mode: "stream" })`, persist into the Think Session,
map barge-in to `cancelChat` + TTS abort, and speak deterministic status/approval
via `deliverNotice`. Run the spike to confirm transport coexistence and
first-audio latency before writing the full implementation RFC.
