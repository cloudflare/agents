# Voice & Real-Time Audio Glossary

A plain-English reference for the terminology you'll encounter in the Cloudflare
Agents SDK voice support and the Cloudflare Realtime (SFU) product.

---

## Transport Protocols

### WebSocket
A persistent, two-way connection between a browser (or any client) and a server,
running over a normal HTTP connection that gets "upgraded" on the first request.
Unlike HTTP — which is strictly request/response — a WebSocket lets either side
send data at any moment.

In the Agents SDK this is the main pipe for the voice protocol.  The browser
sends binary PCM audio frames and JSON control messages down it; the server sends
back audio, transcripts, and status updates.  See `packages/voice/src/types.ts`
for the full message vocabulary (`VoiceClientMessage` / `VoiceServerMessage`).

### WebRTC (Web Real-Time Communication)
A browser standard that lets two peers (e.g. two browsers, or a browser and a
media server) exchange audio, video, and data **directly**, without routing every
packet through a central server.  Under the hood it uses several sub-protocols
(ICE, DTLS, SRTP, SDP — all explained below).

In the SDK, WebRTC appears in two places:
- The **Cloudflare Realtime SFU** integration (`packages/voice/src/sfu-utils.ts`),
  where the browser opens a WebRTC connection to Cloudflare's media infrastructure.
- The **Telnyx call bridge** (`voice-providers/telnyx/providers/call-bridge.ts`),
  where `@telnyx/webrtc` creates an `RTCPeerConnection` to bridge a phone call.

### RTP (Real-time Transport Protocol)
The packet format that carries audio (and video) over a network.  Each RTP packet
contains a small header — sequence number, timestamp, payload type — followed by
the raw audio data.  WebRTC uses RTP internally, but the browser hides it from you;
you never write RTP packets directly.

### RTCP (RTP Control Protocol)
A companion to RTP that travels alongside it on a separate stream.  It carries
statistics — packet loss, jitter, round-trip time — that both ends use to adapt
quality.  Again, the browser handles this automatically within WebRTC.

### PSTN (Public Switched Telephone Network)
The ordinary phone network — landlines, mobile calls, anything with a phone
number.  Telnyx and Twilio act as gateways between PSTN and internet protocols,
which is why the SDK has adapters for both.

---

## Session Negotiation

### SDP (Session Description Protocol)
A text-based format that describes a media session: what codecs you support, what
IP addresses and ports to use, which direction audio flows, etc.  Before a WebRTC
call can start, both sides exchange SDP "offer" and "answer" documents to agree on
the details.

In `sfu-utils.ts` you can see the SDK sending an SDP offer to Cloudflare Realtime
and receiving an SDP answer back.

### ICE (Interactive Connectivity Establishment)
The mechanism WebRTC uses to find a working network path between two peers.  It
gathers "candidates" (local IP, public IP via STUN, relayed address via TURN) and
tries them in order.  ICE is what lets WebRTC punch through NAT (home routers) and
firewalls.  The Telnyx call bridge triggers this automatically via `RTCPeerConnection`.

### STUN / TURN
Helper servers used during ICE.  A **STUN** server tells you your public IP address
(your router hides it with NAT).  A **TURN** server relays your media when a direct
path is impossible.  You rarely configure these by hand; the Telnyx and Cloudflare
SDKs bring their own.

### DTLS (Datagram TLS)
TLS for UDP packets.  WebRTC uses DTLS to authenticate peers and to derive the
encryption keys for SRTP.

### SRTP (Secure RTP)
Encrypted RTP.  All WebRTC audio is carried as SRTP; the keys come from the DTLS
handshake.  You never see the encryption — it happens inside the browser.

---

## Audio Codecs & Formats

A **codec** (coder-decoder) compresses audio for storage or transmission, and
decompresses it for playback.  Different codecs make different trade-offs between
file size, latency, and quality.

### PCM / PCM16 (Pulse-Code Modulation)
The simplest possible audio representation: the amplitude of the sound wave is
sampled at regular intervals and stored as a plain integer.  **PCM16** means each
sample is a 16-bit signed integer (range −32 768 to 32 767).  There is no
compression at all, which means large files but zero encoding/decoding delay.

The SDK uses PCM16 at **16 kHz, mono, little-endian** as its internal currency —
the format flowing between the browser and the voice pipeline, and between the STT
provider and the server.  `floatTo16BitPCM()` in `voice-client.ts` converts the
browser's native float audio into this format.

### WAV
A file container (not really a codec) that wraps PCM16 audio with a 44-byte header
describing the format.  The SDK's Telnyx STT provider wraps its PCM16 chunks in WAV
headers before sending them to the Telnyx transcription API.

### MP3 (MPEG Audio Layer 3)
A lossy compressed format.  It achieves roughly 10:1 compression versus PCM by
discarding audio frequencies the human ear is least sensitive to.  MP3 has some
encoding latency (a few hundred milliseconds) but browsers decode it very
efficiently.

The SDK uses MP3 as the default **TTS output** format — the Workers AI TTS provider
returns MP3, the browser's `AudioContext` decodes it.

### Opus
A modern, open codec designed for real-time communication.  It adapts bit-rate
on the fly, handles both speech and music well, and has very low latency (as little
as 2.5 ms per frame).  WebRTC almost always uses Opus for audio.

The Agents voice protocol lists `opus` as a supported `VoiceAudioFormat`
(`packages/voice/src/types.ts`).

### μ-law (Mulaw / G.711)
An old telephony codec standardised in the 1970s.  It compresses 16-bit PCM down
to 8 bits per sample using a logarithmic scale (louder sounds get less precision,
quieter ones more).  The result is 8 kHz, 8-bit audio — good enough for phone
calls, not for music.

Twilio's Media Streams API delivers audio in this format.  The SDK's Twilio adapter
(`voice-providers/twilio/src/index.ts`) includes a 256-entry lookup table
(`MULAW_DECODE_TABLE`) and `decodeMulawToPCM()` / `encodeMulaw()` functions to
convert to/from the SDK's internal PCM16.

---

## Audio Signal Concepts

### Sample Rate (Hz / kHz)
How many times per second the audio wave is measured.  Higher rates can represent
higher frequencies.  Common rates:

| Rate   | Where you see it |
|--------|-----------------|
| 8 kHz  | Old telephony (Twilio mulaw) |
| 16 kHz | Speech recognition — good enough for voice, lower bandwidth |
| 44.1 kHz | CD audio |
| 48 kHz | WebRTC / browser default |

The browser captures audio at 48 kHz; the Agents SDK resamples it down to 16 kHz
before sending to STT.  The Cloudflare Realtime SFU also works at 48 kHz, so
`sfu-utils.ts` contains `downsample48kStereoTo16kMono()` and its inverse.

### Bit Depth
The number of bits used per sample.  PCM16 = 16 bits.  More bits = finer amplitude
resolution = lower noise floor.  16-bit is standard for speech; telephony uses 8-bit.

### Channels (Mono / Stereo)
**Mono** = one audio channel.  **Stereo** = two (left + right).  The SDK works in
**mono** throughout the voice pipeline because speech recognition doesn't benefit
from stereo and mono halves the data rate.  The SFU outputs stereo (as is typical
for WebRTC), so `sfu-utils.ts` mixes the two channels down to mono during
downsampling.

### Resampling
Converting audio from one sample rate to another.  Simple nearest-neighbour
resampling sounds harsh; the SDK uses **linear interpolation** (blending adjacent
samples) which also acts as a basic low-pass filter to prevent *aliasing*
(unwanted high-frequency artefacts introduced by the rate conversion).

### RMS (Root Mean Square)
A measure of the average loudness of an audio chunk.  You take the square root of
the mean of the squared sample values.  The SDK computes RMS in `voice-client.ts`
to detect whether the user is speaking (voice activity) and drives the `onAudioLevel`
callback with it.

### VAD (Voice Activity Detection)
Automatically detecting when a person is speaking versus when there is silence.
Crude VAD uses an RMS threshold; modern approaches use a neural network.  The
SDK's STT providers do their own VAD internally (Deepgram's "endpointing" feature)
and emit events like `speech_final` or `EndOfTurn` so the SDK knows when the user
has finished speaking.

### Endpointing
A STT-specific term for deciding that the user has finished an utterance and the
recogniser should return a final transcript.  Too short = cuts the user off; too
long = slow response.  Deepgram exposes this as a configurable timeout in
milliseconds (`endpointing: 300` in `voice-providers/deepgram/src/index.ts`).

### Barge-in
Letting the user interrupt the assistant while it is speaking.  The SDK implements
this via the `interrupt` message type: as soon as the STT detects speech during
TTS playback, the client sends `{ type: "interrupt" }`, the server aborts the TTS
stream, and playback stops.

---

## Architecture Concepts

### STT (Speech-to-Text) / ASR (Automatic Speech Recognition)
Converting an audio stream into text.  The SDK feeds PCM16 chunks to an STT
provider (Deepgram Flux via Workers AI, Deepgram Nova-3, Telnyx, etc.) which
returns a transcript.  Streaming STT providers return partial results in real time
as the user speaks.

### TTS (Text-to-Speech) / Speech Synthesis
Converting text into an audio stream.  The SDK calls a TTS provider (Deepgram
Aura-1 via Workers AI, ElevenLabs) with a text string and streams the resulting
audio back to the browser.  The SDK's `sentence-chunker.ts` splits LLM output
into sentences so TTS can start playing before the full response is generated.

### LLM (Large Language Model)
The AI model that decides what the assistant should say.  In the voice pipeline it
sits between STT (input) and TTS (output): transcript goes in, response text comes
out.  The `onTurn` callback in `voice.ts` is where you plug in your LLM logic.

### SFU (Selective Forwarding Unit)
A media server that sits in the middle of a multi-party call.  Unlike an MCU
(Multipoint Control Unit) which mixes all streams together, an SFU just forwards
individual streams to each participant — much lower CPU cost.  **Cloudflare
Realtime** is an SFU.

When you use the SFU integration (`sfu-utils.ts`), your browser opens a WebRTC
connection to Cloudflare's Realtime infrastructure, which then forwards audio
tracks to/from your Durable Object running the voice pipeline.

### Durable Object
Cloudflare's stateful serverless primitive.  Each `VoiceAgent` instance is a
Durable Object — a single-threaded process with persistent storage that lives at
the edge.  WebSocket connections from browsers attach directly to it, giving
low-latency, server-side state without a traditional server.

### Protobuf (Protocol Buffers)
A compact binary serialisation format from Google.  It encodes data as typed
fields with variable-length integers (**varints**) rather than human-readable JSON.
The Cloudflare Realtime SFU wraps audio packets in a minimal protobuf envelope
(sequence number, timestamp, PCM payload).  The SDK in `sfu-utils.ts` includes
hand-rolled varint encode/decode functions rather than pulling in the full protobuf
library.

---

## The Agents Voice Protocol at a Glance

```
Browser                              VoiceAgent (Durable Object)
  │                                          │
  │──── WebSocket upgrade ────────────────→  │
  │←─── { type: "welcome" } ─────────────── │
  │                                          │
  │──── { type: "start_call" } ──────────→  │
  │←─── { type: "audio_config" } ─────────  │
  │                                          │
  │──── [binary PCM16 frames] ───────────→  │  ← mic audio
  │──── { type: "start_of_speech" } ─────→  │
  │──── { type: "end_of_speech" } ───────→  │
  │                                          │
  │←─── { type: "transcript_delta" } ─────  │  ← STT result
  │←─── { type: "status", "thinking" } ───  │
  │←─── { type: "status", "speaking" } ───  │
  │←─── [binary MP3/PCM16 frames] ────────  │  ← TTS audio
  │                                          │
  │──── { type: "interrupt" } ───────────→  │  ← barge-in
  │←─── { type: "playback_interrupt" } ───  │
```

---

## Quick-Reference Table

| Term | One-liner |
|------|-----------|
| **WebSocket** | Persistent two-way connection; the SDK's main voice pipe |
| **WebRTC** | Browser standard for peer-to-peer audio/video |
| **RTP** | Packet format carrying the actual audio bytes |
| **RTCP** | Stats companion to RTP (loss, jitter) |
| **SDP** | Text document negotiating codec/address before a call |
| **ICE** | Finds a working network path through NAT/firewalls |
| **SRTP** | Encrypted RTP — all WebRTC audio is SRTP |
| **PCM16** | Raw uncompressed 16-bit audio — zero latency, large size |
| **MP3** | Compressed audio — smaller, slight latency, default TTS output |
| **Opus** | Modern low-latency codec — WebRTC's standard audio codec |
| **μ-law / Mulaw** | Old telephony 8-bit codec — used by Twilio |
| **WAV** | Container that wraps PCM with a header |
| **Sample rate** | Samples per second; 16 kHz = voice quality, 48 kHz = WebRTC default |
| **Mono / Stereo** | 1 or 2 audio channels; SDK uses mono throughout |
| **RMS** | Loudness measure used for voice-activity detection |
| **VAD** | Detecting speech vs silence |
| **Endpointing** | Deciding the user has finished speaking |
| **Barge-in** | User interrupting the assistant mid-playback |
| **STT / ASR** | Speech → text |
| **TTS** | Text → speech |
| **SFU** | Media server that forwards streams; Cloudflare Realtime is one |
| **Durable Object** | Cloudflare stateful edge worker; hosts each VoiceAgent |
| **Protobuf** | Compact binary serialisation used by the Cloudflare Realtime SFU |
| **PSTN** | The ordinary phone network (Twilio/Telnyx bridge to it) |
| **Resampling** | Converting between sample rates (e.g. 48 kHz → 16 kHz) |
