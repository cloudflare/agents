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
`vitest` test file, a README, and documentation/listing updates.

**Design stance:** keep the typed surface lean. Expose the handful of common,
safe options as typed fields and route everything else (advanced / per-model /
future params) through a single `params` passthrough. Hardcode the values the
pipeline contract already fixes (16 kHz mono PCM16) rather than expose them as
footgun knobs.

## 3. Scope

### In scope
- `AssemblyAISTT` (`Transcriber`) + per-call `AssemblyAISession` (`TranscriberSession`).
- AssemblyAI Streaming v3 protocol mapping over a WebSocket connection.
- Configurable endpoint via a single `baseUrl` override (defaults to the AssemblyAI
  US streaming host). This also enables routing through Cloudflare AI Gateway — the
  user points `baseUrl` at their gateway endpoint. README documents the EU host and
  the AI Gateway URL format.
- Typed options for the common cases (model, Medical Mode, keyterms, turn-format)
  plus a `params` passthrough for advanced / forward-compat query parameters.
- A `vitest` test file, mirroring Telnyx's test setup.
- README and provider-listing/doc updates.

### Out of scope (documented as future work)
- **Typed AI Gateway helper** (`buildGatewayUrl`, `gateway: {accountId, gatewayId}`):
  deferred to a follow-up PR once AssemblyAI-over-AI-Gateway-over-WebSocket is
  verified end-to-end. AssemblyAI is **not** currently in Cloudflare's
  `AIGatewayProviders` type. `baseUrl` covers the need in the meantime.
- **`prompt` option** (natural-language transcription prompt for u3-rt-pro). Cut from
  v1: it is the only knob requiring a post-connect `UpdateConfiguration` round-trip
  and the mechanism is unverified. Add when there is a concrete need and a confirmed
  path; the `params` passthrough does not cover it because it is not a connection
  query param.
- **Workers AI self-hosted AssemblyAI models** (running U3 Pro on Cloudflare GPUs).
  Depends on separate self-hosting work with Cloudflare; once available it is a
  user config choice (Workers AI + model), not a change to this provider.
- **On-premises / pharmaceutical deployment** (req #5) — future, depends on the
  Workers AI self-host path above.
- **Replicate / unified model catalog merge** (req #4) — Cloudflare-side. Per the
  2026-04-23 call AssemblyAI is already reachable via AI Gateway (to be verified —
  see §12.1), so no provider work is expected here.
- TTS (AssemblyAI is STT-only for this integration).

## 4. Requirements mapping

| Requirement (from brief) | Disposition |
| --- | --- |
| 1. PR adding AssemblyAI as a voice provider, like Telnyx/Deepgram | **Core of this PR** |
| 2. Map AssemblyAI API to Cloudflare's interface | **Core** — §6 protocol mapping |
| 3. User configures AI Gateway vs Workers AI in agent definition | **Partially in scope** — `baseUrl` enables AI Gateway routing now; Workers AI hosting of AssemblyAI models is future (out of scope) |
| 4. Replicate / AI Gateway unified catalog | **Out** — Cloudflare-side; AssemblyAI reportedly already on AI Gateway (verify, §12.1) |
| 5. On-prem for pharmaceutical customers | **Out / future** — depends on Workers AI self-host |

## 5. Architecture — package shape

Mirrors the Deepgram package structure plus a single-file `vitest` test, picked up
automatically by the root `voice-providers/*` workspace glob.

```
voice-providers/assemblyai/
  package.json        # @cloudflare/voice-assemblyai, private, peerDep "@cloudflare/voice": "*"
  tsconfig.json       # { "extends": "agents/tsconfig" }
  scripts/build.ts    # tsdown, identical pattern to deepgram/scripts/build.ts
  vitest.config.ts    # node env, include tests/**/*.test.ts (like telnyx)
  src/
    index.ts          # AssemblyAISTT, AssemblyAISession, internal URL builder
  tests/
    index.test.ts     # option/query-string building + event→callback mapping (mock WS)
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
- `TranscriberSession.feed(chunk: ArrayBuffer)` + `close()` (note: `close()` is synchronous)
- `TranscriberSessionOptions` callbacks: `onInterim(text)`, `onSpeechStart(text?)`, `onUtterance(text)`
- Audio input is **16 kHz mono PCM16 little-endian** (fixed by the pipeline contract).

| Cloudflare side | AssemblyAI Streaming v3 |
| --- | --- |
| `createSession()` connect | `fetch()` WebSocket-upgrade to the resolved base URL with query params (see §7) |
| `feed(chunk)` | send binary PCM16 frames to the WS (50 ms chunks, never faster than real-time) |
| `onSpeechStart()` (barge-in) | `SpeechStarted` event (U3 Pro VAD) |
| `onInterim(text)` | `Turn` event with `end_of_turn: false` → `transcript` |
| `onUtterance(text)` | `Turn` event with `end_of_turn: true` → `transcript` |
| `close()` | send `{"type":"Terminate"}`, then close the WS (no await — see below) |
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
2. **Encoding/sample rate are hardcoded** to `pcm_s16le` and `16000` — the pipeline
   contract fixes them, so they are not exposed as options.
3. **`close()` does not await `Termination`.** The interface defines `close(): void`
   (synchronous), and we are tearing the session down regardless. Send
   `{"type":"Terminate"}` then close the socket — matching Deepgram's send-then-close
   approach. We do not add a timer/state machine to wait for the `Termination` ack.
4. Audio must be sent in **50 ms chunks** and not faster than real-time (v3 error 3007).

## 7. Public API and endpoint resolution

```typescript
export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `?token=` query param on the WS URL (server-side). */
  apiKey: string;
  /** Streaming model. @default "u3-rt-pro" */
  model?: string;
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
  /**
   * Full WebSocket base URL override. Use this to select the EU host or to route
   * through Cloudflare AI Gateway — see README for the gateway URL format.
   * @default "wss://streaming.assemblyai.com/v3/ws"
   */
  baseUrl?: string;
  /**
   * Advanced / forward-compat connection query parameters, merged into the WS URL.
   * Escape hatch for per-model tuning (e.g. end_of_turn_confidence_threshold,
   * min_turn_silence, speaker_labels, inactivity_timeout) without growing the typed
   * surface. Values are stringified; provider-managed params (token, speech_model,
   * encoding, sample_rate) cannot be overridden here.
   */
  params?: Record<string, string | number | boolean>;
}
```

**Endpoint resolution:** `baseUrl` if provided, else the default
`wss://streaming.assemblyai.com/v3/ws`.
- EU host: pass `baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"` (documented in README).

**Query parameters appended to the resolved base URL:** `token`, `speech_model`,
`sample_rate=16000`, `encoding=pcm_s16le`, `format_turns`, conditionally
`domain=medical-v1` and `keyterms_prompt` (JSON-stringified array), then any
`params` entries (which cannot override the provider-managed params above).

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

See §11 for the interface limitation on surfacing fatal errors to the agent.

## 9. Testing (`vitest`, like Telnyx)

`vitest.config.ts`: node environment, `include: ["tests/**/*.test.ts"]`.
Single file `tests/index.test.ts` covering both units:

**Config / query-string building:**
- option defaults (model `u3-rt-pro`, formatTurns true);
- query-string construction: hardcoded `encoding=pcm_s16le` and `sample_rate=16000`,
  `format_turns`, `medical → domain=medical-v1`, `keyterms → keyterms_prompt` JSON
  encoding, `params` entries merged in;
- `params` cannot override provider-managed params (token/speech_model/encoding/sample_rate);
- `baseUrl` override replaces the default host;
- API key is placed in `?token=` and not in headers.

**Session behavior (mock WebSocket):**
- `SpeechStarted → onSpeechStart`;
- `Turn{end_of_turn:false} → onInterim`, `Turn{end_of_turn:true} → onUtterance`;
- pre-connect `feed()` buffers, then flushes on open;
- `close()` sends `{"type":"Terminate"}`, closes the socket, and tolerates a
  missing/late socket (no await).

## 10. Repo integration tasks

- Add `@cloudflare/voice-assemblyai` to the **"Third-party providers"** table in
  `packages/voice/README.md`.
- Add a mention in `docs/voice.md` alongside the other providers.
- Changeset: the package is `private` (initial `0.0.1`, matching Deepgram), so a
  changeset is likely unnecessary; add one only if the package is to be published.
- Develop on branch `assemblyai-voice-provider`; PR targets `cloudflare/agents:main`.
- Verify lint/format (`oxlint`/`oxfmt`) and `build` (tsdown) pass for the new package.

## 11. Known limitations (documented, not fixed in this PR)

1. **No error path to the agent.** `TranscriberSession` exposes no `onError`
   callback (only `onInterim`/`onSpeechStart`/`onUtterance`), so a fatal failure
   such as an auth error (v3 `1008`) can only be logged — the agent simply goes
   quiet. Fixing this would require extending the shared `@cloudflare/voice`
   interface, which is out of scope here.
2. **Streaming language is model-determined.** Unlike Deepgram, Streaming v3 has no
   `language` connection parameter — the selected model drives language behavior.
   The pipeline's `TranscriberSessionOptions.language` is therefore effectively
   ignored (a custom value can still be forwarded via `params` if AssemblyAI adds
   support). Documented in the README to avoid surprise.

## 12. Open items / assumptions to verify

1. **AI Gateway over WebSocket for AssemblyAI** — whether Cloudflare AI Gateway
   proxies AssemblyAI Streaming v3 WS connections, and the exact URL/path. The
   `baseUrl` override means the provider works regardless; the typed gateway helper
   (out of scope) waits on this verification.
2. **Default model for `withVoice` vs `withVoiceInput`** — `u3-rt-pro` is the default
   here (promptable, punctuation turns, medical-capable). Confirm this is the desired
   default for conversational agents, or whether `withVoiceInput` (dictation) should
   suggest a different model in docs.
