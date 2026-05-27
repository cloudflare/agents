# Design: AssemblyAI STT provider for the Cloudflare Agents voice pipeline

- **Date:** 2026-05-27
- **Status:** Approved design — pending implementation plan
- **Package:** `@cloudflare/voice-assemblyai` (`voice-providers/assemblyai/`)
- **Author:** dlange@assemblyai.com

## 1. Context

Cloudflare's Agents SDK has a voice pipeline (`@cloudflare/voice`) with a small,
well-defined provider interface. Third parties add speech-to-text (STT) or
text-to-speech (TTS) by shipping a package that implements that interface —
Deepgram (`@cloudflare/voice-deepgram`) and ElevenLabs (`@cloudflare/voice-elevenlabs`)
are existing examples, and Telnyx (`voice-providers/telnyx`) is a fuller reference
with a test suite.

This design adds **AssemblyAI as an STT provider**. It is "Step 1" of a broader
partnership (see the AssemblyAI ↔ Cloudflare call, 2026-04-23): get AssemblyAI in
as a type-compliant provider via a PR, mirroring the Telnyx/Deepgram example.

Key facts established on the call that bound this design:

- The Agents SDK **only configures** which models a user wants; it does not run
  inference itself. The user chooses **AI Gateway vs Workers AI** in their agent
  definition.
- AssemblyAI does **not** need to host on Cloudflare hardware to be on the Agents SDK.
- This is fundamentally an **API-mapping exercise** — map AssemblyAI's Streaming v3
  API onto Cloudflare's `Transcriber` interface.
- STT is the only surface needed for this step.

## 2. Goal

Ship a new workspace package `@cloudflare/voice-assemblyai` exposing an
`AssemblyAISTT` class that implements the `Transcriber` interface from
`@cloudflare/voice`, mapping **AssemblyAI Streaming v3** to the voice pipeline.
The provider runs server-side inside the Agent's Durable Object. Includes a
`vitest` test suite, a README, and documentation/listing updates.

## 3. Scope

### In scope
- `AssemblyAISTT` (`Transcriber`) + per-call `AssemblyAISession` (`TranscriberSession`).
- AssemblyAI Streaming v3 protocol mapping over a WebSocket connection.
- Configurable endpoint via `baseUrl` override + `region` selection (`us`/`eu`),
  which also enables routing through Cloudflare AI Gateway (user supplies the URL).
- AssemblyAI-specific options: model, Medical Mode, keyterms, prompt, sample rate,
  turn-format, turn-confidence.
- `vitest` unit + session tests (mock WebSocket), mirroring Telnyx's test setup.
- README and provider-listing/doc updates.

### Out of scope (documented as future work)
- **Typed AI Gateway helper** (`buildGatewayUrl`, `gateway: {accountId, gatewayId}`):
  deferred to a follow-up PR once AssemblyAI-over-AI-Gateway-over-WebSocket is
  verified end-to-end. AssemblyAI is **not** currently in Cloudflare's
  `AIGatewayProviders` type. `baseUrl` covers the need in the meantime.
- **Workers AI self-hosted AssemblyAI models** (running U3 Pro on Cloudflare GPUs).
  Depends on separate self-hosting work with Cloudflare; once available it is a
  user config choice (Workers AI + model), not a change to this provider.
- **On-premises / pharmaceutical deployment** (req #5) — future, depends on the
  Workers AI self-host path above.
- **Replicate / unified model catalog merge** (req #4) — Cloudflare-side. Per the
  2026-04-23 call AssemblyAI is already reachable via AI Gateway (to be verified —
  see §11.1), so no provider work is expected here.
- TTS (AssemblyAI is STT-only for this integration).

## 4. Requirements mapping

| Requirement (from brief) | Disposition |
| --- | --- |
| 1. PR adding AssemblyAI as a voice provider, like Telnyx/Deepgram | **Core of this PR** |
| 2. Map AssemblyAI API to Cloudflare's interface | **Core** — §6 protocol mapping |
| 3. User configures AI Gateway vs Workers AI in agent definition | **Partially in scope** — `baseUrl` enables AI Gateway routing now; Workers AI hosting of AssemblyAI models is future (out of scope) |
| 4. Replicate / AI Gateway unified catalog | **Out** — Cloudflare-side; AssemblyAI reportedly already on AI Gateway (verify, §11.1) |
| 5. On-prem for pharmaceutical customers | **Out / future** — depends on Workers AI self-host |

## 5. Architecture — package shape

Mirrors the Deepgram package structure plus Telnyx's `vitest` setup. The package is
picked up automatically by the root `voice-providers/*` workspace glob.

```
voice-providers/assemblyai/
  package.json        # @cloudflare/voice-assemblyai, private, peerDep "@cloudflare/voice": "*"
  tsconfig.json       # { "extends": "agents/tsconfig" }
  scripts/build.ts    # tsdown, identical pattern to deepgram/scripts/build.ts
  vitest.config.ts    # node env, include tests/**/*.test.ts (like telnyx)
  src/
    index.ts          # AssemblyAISTT, AssemblyAISession, internal URL builder
  tests/
    assemblyai-stt.test.ts      # option defaults + query-string + endpoint precedence
    assemblyai-session.test.ts  # event→callback mapping with a mock WebSocket
  README.md
```

Two units, each independently testable:

- **`AssemblyAISTT`** — holds config, builds the connection URL, and creates sessions.
  Pure/synchronous except for session creation. Easy to unit-test (URL/query building).
- **`AssemblyAISession`** — owns one WebSocket for one call: connects, buffers audio
  until ready, routes inbound events to callbacks, and tears down cleanly. Testable
  with a mock WebSocket.

## 6. AssemblyAI Streaming v3 → Cloudflare mapping (the core)

Cloudflare interface (from `packages/voice/src/types.ts`):
- `Transcriber.createSession(options?) → TranscriberSession`
- `TranscriberSession.feed(chunk: ArrayBuffer)` + `close()`
- `TranscriberSessionOptions` callbacks: `onInterim(text)`, `onSpeechStart(text?)`, `onUtterance(text)`
- Audio input is **16 kHz mono PCM16 little-endian**.

| Cloudflare side | AssemblyAI Streaming v3 |
| --- | --- |
| `createSession()` connect | `fetch()` WebSocket-upgrade to the resolved base URL with query params (see §7) |
| `feed(chunk)` | send binary PCM16 frames to the WS (50 ms chunks, never faster than real-time) |
| `onSpeechStart()` (barge-in) | `SpeechStarted` event (U3 Pro VAD) |
| `onInterim(text)` | `Turn` event with `end_of_turn: false` → `transcript` |
| `onUtterance(text)` | `Turn` event with `end_of_turn: true` → `transcript` |
| `close()` | send `{"type":"Terminate"}`, await `Termination`, then close the WS |
| (session start) | `Begin` event — confirms session `id`; no callback, optional debug log |

Connection lifecycle reuses the Deepgram/Flux pattern: a `#connect()` that does the
`fetch` upgrade and `ws.accept()`, a `#pendingChunks` buffer flushed once connected,
a `#closed` guard so late events are ignored, and the `resp.webSocket` accept-and-close
path for the race where `close()` happens before the socket opens.

**Differences from Deepgram to get right:**
1. **Auth** is via the `?token=<apiKey>` query parameter, **not** an
   `Authorization: Token` header. (REST endpoints use a bare `Authorization: <key>`
   header with no `Bearer` prefix, but Streaming v3 uses the token query param.)
   The provider runs server-side, so passing the API key directly is acceptable; a
   temporary-token exchange (`GET /v3/token`) is the browser-only alternative and is
   not needed here.
2. **Encoding** string is `pcm_s16le` (AssemblyAI), not `linear16` (Deepgram).
3. **Explicit terminate handshake** on `close()` — send `{"type":"Terminate"}` and
   wait for the `Termination` event before closing, rather than just closing.
4. Audio must be sent in **50 ms chunks** and not faster than real-time (v3 error 3007).

## 7. Public API and endpoint resolution

```typescript
export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `?token=` query param on the WS URL (server-side). */
  apiKey: string;
  /** Streaming model. @default "u3-rt-pro" */
  model?: string;
  /** Sample rate in Hz. Must match the pipeline (16 kHz). @default 16000 */
  sampleRate?: number;
  /**
   * Formatted finals (punctuation/casing/ITN). Applies to `universal-streaming-*`
   * models only; no effect on `u3-rt-pro`, whose finals are already formatted.
   * @default true
   */
  formatTurns?: boolean;
  /** Enable Medical Mode (`domain=medical-v1`). u3-rt-pro + en/es/de/fr. @default false */
  medical?: boolean;
  /** Domain vocabulary to bias recognition → `keyterms_prompt` (JSON-encoded). */
  keyterms?: string[];
  /** Natural-language transcription prompt (u3-rt-pro). Applied via UpdateConfiguration after connect. */
  prompt?: string;
  /** End-of-turn confidence (universal-streaming only; no effect on u3-rt-pro). */
  endOfTurnConfidenceThreshold?: number;
  /** Region host. @default "us" */
  region?: "us" | "eu";
  /**
   * Full WebSocket base URL override. Wins over `region`. Use this to route through
   * Cloudflare AI Gateway — see README for the gateway URL format.
   * @default region-derived AssemblyAI streaming host
   */
  baseUrl?: string;
}
```

**Endpoint resolution precedence:** `baseUrl` → `region` default.
- `region: "us"` → `wss://streaming.assemblyai.com/v3/ws`
- `region: "eu"` → `wss://streaming.eu.assemblyai.com/v3/ws`

**Query parameters appended to the resolved base URL:**
`token`, `speech_model`, `sample_rate`, `encoding=pcm_s16le`, `format_turns`,
and conditionally `domain=medical-v1`, `keyterms_prompt` (JSON-stringified array),
`end_of_turn_confidence_threshold`.

`prompt`, when set, is applied by sending an `UpdateConfiguration` message
immediately after the socket opens (it is not a connection query param).

### Usage
```typescript
import { Agent } from "agents";
import { withVoice, WorkersAITTS, type VoiceTurnContext } from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new AssemblyAISTT({
    apiKey: this.env.ASSEMBLYAI_API_KEY,
    medical: true // pharma / clinical accuracy
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // LLM logic
  }
}
```

## 8. Error handling

Mirror the existing providers: never throw out of WebSocket event handlers.
- Malformed/non-JSON messages are ignored.
- Connection failures and v3 error codes are logged via `console.error` with an
  `[AssemblyAISTT]` prefix. Notable codes to surface in the message: `1008`
  (missing auth / account issue), `3008` (session expired / token expired),
  `3009` (too many concurrent sessions), `3007` (audio pacing/duration violation).
- Audio fed before the socket is open is buffered in `#pendingChunks` and flushed
  on connect; after `close()` it is dropped.

## 9. Testing (`vitest`, like Telnyx)

`vitest.config.ts`: node environment, `include: ["tests/**/*.test.ts"]`.

**`assemblyai-stt.test.ts` (unit):**
- option defaults (model `u3-rt-pro`, sampleRate 16000, formatTurns true, region us);
- query-string construction: `encoding=pcm_s16le`, `format_turns`, `medical → domain=medical-v1`,
  `keyterms → keyterms_prompt` JSON encoding, `endOfTurnConfidenceThreshold`;
- endpoint precedence: `baseUrl` overrides `region`; `region: "eu"` host;
- API key is placed in `?token=` and not in headers.

**`assemblyai-session.test.ts` (mock WebSocket):**
- `SpeechStarted → onSpeechStart`;
- `Turn{end_of_turn:false} → onInterim`, `Turn{end_of_turn:true} → onUtterance`;
- pre-connect `feed()` buffers, then flushes on open;
- `close()` sends `{"type":"Terminate"}` and tolerates a missing/late socket;
- `prompt` set → `UpdateConfiguration` sent after open.

## 10. Repo integration tasks

- Add `@cloudflare/voice-assemblyai` to the **"Third-party providers"** table in
  `packages/voice/README.md`.
- Add a mention in `docs/voice.md` alongside the other providers.
- Changeset: the package is `private` (initial `0.0.1`, matching Deepgram), so a
  changeset is likely unnecessary; add one only if the package is to be published.
- Develop on branch `assemblyai-voice-provider`; PR targets `cloudflare/agents:main`.
- Verify lint/format (`oxlint`/`oxfmt`) and `build` (tsdown) pass for the new package.

## 11. Open items / assumptions to verify

1. **AI Gateway over WebSocket for AssemblyAI** — whether Cloudflare AI Gateway
   proxies AssemblyAI Streaming v3 WS connections, and the exact URL/path. The
   `baseUrl` override means the provider works regardless; the typed helper waits
   on this verification.
2. **`prompt` round-trip** — confirm `UpdateConfiguration` is the right mechanism to
   set a transcription prompt on a u3-rt-pro streaming session at connect time (vs.
   a connection query param). If it is not worth the extra round-trip for v1, the
   `prompt` option can be cut.
3. **Default model for `withVoice` vs `withVoiceInput`** — `u3-rt-pro` is the default
   here (promptable, punctuation turns, medical-capable). Confirm this is the desired
   default for conversational agents, or whether `withVoiceInput` (dictation) should
   suggest a different model in docs.
```
