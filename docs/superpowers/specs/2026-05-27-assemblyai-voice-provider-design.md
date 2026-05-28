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

This design adds **AssemblyAI as an STT provider**, locked to the **Universal-3 Pro
Streaming** model (`u3-rt-pro`) — AssemblyAI's model purpose-built for voice agents
(sub-300 ms time-to-final, punctuation-based turn detection, barge-in signals,
promptable, medical-capable). It is "Step 1" of a broader partnership (see the
AssemblyAI ↔ Cloudflare call, 2026-04-23): get AssemblyAI in as a type-compliant
provider via a PR, mirroring the Telnyx/Deepgram example.

Key facts established on the call that bound this design:

- The Agents SDK **only configures** which models a user wants; it does not run
  inference itself. The user chooses **AI Gateway vs Workers AI** in their agent
  definition.
- AssemblyAI does **not** need to host on Cloudflare hardware to be on the Agents SDK.
- This is fundamentally an **API-mapping exercise** — map AssemblyAI's Streaming v3
  API onto Cloudflare's `Transcriber` interface.
- STT is the only surface needed for this step.

API details below were verified against AssemblyAI's live API reference and the
Universal-3 Pro Streaming docs (via the AssemblyAI docs MCP), not from memory.

## 2. Goal

Ship a new workspace package `@cloudflare/voice-assemblyai` exposing an
`AssemblyAISTT` class that implements the `Transcriber` interface from
`@cloudflare/voice`, mapping **AssemblyAI Universal-3 Pro Streaming** to the voice
pipeline. The provider runs server-side inside the Agent's Durable Object. Includes
a `vitest` test file, a README, and documentation/listing updates.

**Design stance — opinionated and fully typed.** Lock the model to `u3-rt-pro`
(the voice-agent model) and expose only the knobs that actually apply to it as
typed fields. No generic `params` passthrough: with a single model the meaningful
surface is small and finite, so a curated typed interface is both cleaner and
safer (every field does something; no model-specific no-ops). Hardcode the values
the pipeline contract and the model already fix (16 kHz mono PCM16; formatting is
built into u3-rt-pro's end-of-turn).

## 3. Scope

### In scope
- `AssemblyAISTT` (`Transcriber`) + per-call `AssemblyAISession` (`TranscriberSession`).
- AssemblyAI Universal-3 Pro Streaming (`u3-rt-pro`) protocol mapping over a WebSocket.
- A fully typed options surface (see §7): `domain`, `keyterms`, `prompt`,
  turn-detection (`minTurnSilence`/`maxTurnSilence`), barge-in (`interruptionDelay`),
  `vadThreshold`, `continuousPartials`, `languageDetection` (+ `onLanguageDetected`
  callback), and a `baseUrl` override.
- Configurable endpoint via `baseUrl` (defaults to the AssemblyAI US streaming host),
  which also enables routing through Cloudflare AI Gateway and selecting the EU host.
  README documents both URL formats.
- A `vitest` test file, mirroring Telnyx's test setup.
- README and provider-listing/doc updates.

### Out of scope (documented as future work)
- **Model selection.** The provider is locked to `u3-rt-pro`. Other streaming models
  (`universal-streaming-english`, `universal-streaming-multilingual`, `whisper-rt`)
  are not selectable in v1. Add a `model` option when there is demand (e.g. for
  whisper-rt's 99-language coverage). See limitation §11.3.
- **Generic `params` passthrough.** Intentionally omitted (see Design stance).
  Niche u3-rt-pro params not typed in v1 — `inactivity_timeout`, `speaker_labels` /
  `max_speakers` — would be added as typed fields when needed.
- **Typed AI Gateway helper** (`buildGatewayUrl`, `gateway: {accountId, gatewayId}`):
  deferred until AssemblyAI-over-AI-Gateway-over-WebSocket is verified end-to-end.
  AssemblyAI is **not** currently in Cloudflare's `AIGatewayProviders` type. `baseUrl`
  covers the need in the meantime (see §12.1).
- **Workers AI self-hosted AssemblyAI models** (running U3 Pro on Cloudflare GPUs),
  **on-premises / pharmaceutical deployment** (req #5), and the **Replicate / unified
  catalog merge** (req #4) — all Cloudflare-side / future. Per the 2026-04-23 call
  AssemblyAI is already reachable via AI Gateway (to be verified — §12.1).
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

## 6. AssemblyAI Universal-3 Pro Streaming → Cloudflare mapping (the core)

Cloudflare interface (from `packages/voice/src/types.ts`):
- `Transcriber.createSession(options?) → TranscriberSession`
- `TranscriberSession.feed(chunk: ArrayBuffer)` + `close()` (note: `close()` is synchronous)
- `TranscriberSessionOptions` callbacks: `onInterim(text)`, `onSpeechStart(text?)`, `onUtterance(text)`
- Audio input is **16 kHz mono PCM16 little-endian** (fixed by the pipeline contract).

| Cloudflare side | AssemblyAI Universal-3 Pro Streaming |
| --- | --- |
| `createSession()` connect | `fetch()` WebSocket-upgrade to the resolved base URL with query params (see §7) and the `Authorization` header |
| `feed(chunk)` | send binary PCM16 frames to the WS (~50 ms chunks, never faster than real-time) |
| `onSpeechStart()` (barge-in) | `SpeechStarted` event (VAD). Note: u3-rt-pro's stable early partial (a `Turn` with `end_of_turn:false`) is the more reliable barge-in/eager-inference signal |
| `onInterim(text)` | `Turn` event with `end_of_turn: false` → `transcript` (stable cumulative partial) |
| `onUtterance(text)` | `Turn` event with `end_of_turn: true` → `transcript` (always formatted) |
| `close()` | send `{"type":"Terminate"}`, then close the WS (no await — see below) |
| (session start) | `Begin` event — confirms session `id`; no callback, optional debug log |

Connection lifecycle reuses the Deepgram/Flux pattern: a `#connect()` that does the
`fetch` upgrade and `ws.accept()`, a `#pendingChunks` buffer flushed once connected,
a `#closed` guard so late events are ignored, and the `resp.webSocket` accept-and-close
path for the race where `close()` happens before the socket opens.

**Verified API specifics (differences from Deepgram to get right):**
1. **Auth is the `Authorization` header**, set to the raw API key with **no prefix**
   (`Authorization: <apiKey>` — not `Bearer`, not Deepgram's `Token`). Confirmed by
   every official streaming example. The `?token=` query param is only for browser
   *temporary tokens* (`GET /v3/token`) and is not used here.
2. **Hardcoded query params:** `speech_model=u3-rt-pro`, `sample_rate=16000`,
   `encoding=pcm_s16le`. These are fixed by the model choice and pipeline contract,
   so they are not options.
3. **No `format_turns`.** Formatting is built into u3-rt-pro's end-of-turn system
   ("there is only ever one end-of-turn transcript per turn and it is always
   formatted"), so the param is unnecessary and is not sent.
4. **`close()` does not await `Termination`.** The interface defines `close(): void`
   (synchronous). Send `{"type":"Terminate"}` then close — matching Deepgram's
   send-then-close. (Billing accrues on connection-open duration and unclosed
   sessions auto-close after 3 h billed for the full duration, so closing promptly
   matters — but a graceful `Termination` ack is not worth a teardown-time timer.)
5. Audio is sent in ~50 ms chunks, not faster than real-time (v3 error 3007).

## 7. Public API and endpoint resolution

```typescript
export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `Authorization` header (raw key, no prefix). */
  apiKey: string;
  /**
   * Domain specialization → `domain=<value>`. Mirrors the AssemblyAI param.
   * `"medical-v1"` enables Medical Mode (en/es/de/fr); more domains (e.g. legal,
   * finance) may follow. The union keeps autocomplete for known values while
   * accepting any string for forward-compat.
   */
  domain?: "medical-v1" | (string & {});
  /** Domain vocabulary to bias recognition → `keyterms_prompt` (JSON-encoded). */
  keyterms?: string[];
  /**
   * Custom transcription prompt (u3-rt-pro is promptable) → `prompt`, set at
   * connection time. **Omit to use AssemblyAI's optimized default prompt
   * (recommended — 88% turn-detection accuracy out of the box).** If set, build
   * off the default prompt; custom prompts that reduce punctuation degrade the
   * punctuation-based turn detection. Also the lever for guiding transcription
   * language (e.g. prepend "Transcribe Spanish.").
   */
  prompt?: string;
  /**
   * Turn detection: minimum silence (ms) before a speculative end-of-turn check.
   * → `min_turn_silence`. Server default 100. Lower = faster partials but more
   * entity splitting; raise mid-flow for dictation of numbers/addresses.
   */
  minTurnSilence?: number;
  /**
   * Turn detection: maximum silence (ms) before a turn is forced to end.
   * → `max_turn_silence`. Server default 1000.
   */
  maxTurnSilence?: number;
  /**
   * Barge-in / time-to-first-token tuning: how soon the first partial is emitted
   * (ms, 0–1000; ~300 ms is added server-side). → `interruption_delay`. Server
   * default 500. Lower = faster barge-in signal; higher = more confident.
   */
  interruptionDelay?: number;
  /**
   * VAD confidence threshold (0.0–1.0) for classifying audio frames as silence
   * → `vad_threshold`. Raise in noisy environments (call centers, clinical rooms)
   * to reduce false speech detection. AssemblyAI suggests ~0.3 to align with a
   * client-side VAD.
   */
  vadThreshold?: number;
  /**
   * Emit a steady stream of non-final partials (~every 3 s) during long
   * uninterrupted turns (e.g. a caller reading a card/address). → `continuous_partials`.
   * Server default false.
   */
  continuousPartials?: boolean;
  /**
   * Return language metadata (`language_code`, `language_confidence`) on Turn
   * events → `language_detection`. u3-rt-pro transcribes multilingual audio
   * regardless; this only toggles the metadata. Surface it via `onLanguageDetected`
   * (the pipeline's transcript callbacks are text-only).
   */
  languageDetection?: boolean;
  /**
   * Called when a `Turn` carries detected-language metadata (requires
   * `languageDetection: true`). Provider-specific extension, since the pipeline's
   * text-only `onUtterance`/`onInterim` cannot carry this.
   */
  onLanguageDetected?: (languageCode: string, languageConfidence: number) => void;
  /**
   * Full WebSocket base URL override. Use to select the EU host or route through
   * Cloudflare AI Gateway — see README for the gateway URL format.
   * @default "wss://streaming.assemblyai.com/v3/ws"
   */
  baseUrl?: string;
}
```

**Endpoint resolution:** `baseUrl` if provided, else the default
`wss://streaming.assemblyai.com/v3/ws`.
- EU host: pass `baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"` (documented in README).

**Query-string construction:** always append `speech_model=u3-rt-pro`,
`sample_rate=16000`, `encoding=pcm_s16le`. Then append, **only when the option is
explicitly set** (so AssemblyAI's server defaults apply otherwise and the URL stays
minimal): `domain`, `keyterms_prompt` (JSON-stringified array), `prompt`,
`min_turn_silence`, `max_turn_silence`, `interruption_delay`, `vad_threshold`,
`continuous_partials`, `language_detection`. The API key is sent via the
`Authorization` header, not the query string.

### Usage
```typescript
import { Agent } from "agents";
import { withVoice, WorkersAITTS, type VoiceTurnContext } from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";

const VoiceAgent = withVoice(Agent);

export class ClinicalIntakeAgent extends VoiceAgent<Env> {
  transcriber = new AssemblyAISTT({
    apiKey: this.env.ASSEMBLYAI_API_KEY,
    domain: "medical-v1",            // pharma / clinical accuracy
    keyterms: ["metoprolol", "Skyrizi"],
    // "Patient" preset for entity dictation:
    minTurnSilence: 200,
    maxTurnSilence: 2000,
  });
  tts = new WorkersAITTS(this.env.AI); // mix-and-match: AssemblyAI STT + Workers AI TTS

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic; transcript is the finalized utterance (Turn end_of_turn=true)
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
- always-present params: `speech_model=u3-rt-pro`, `sample_rate=16000`, `encoding=pcm_s16le`;
- conditional params appear only when set: `domain`, `keyterms → keyterms_prompt`
  (JSON encoding), `prompt`, `min_turn_silence`, `max_turn_silence`,
  `interruption_delay`, `vad_threshold`, `continuous_partials`, `language_detection`;
  and are absent when unset (server defaults apply);
- `format_turns` is never sent;
- API key is placed in the `Authorization` header (no prefix), not in the query string;
- `baseUrl` override replaces the default host.

**Session behavior (mock WebSocket):**
- `SpeechStarted → onSpeechStart`;
- `Turn{end_of_turn:false} → onInterim`, `Turn{end_of_turn:true} → onUtterance`;
- pre-connect `feed()` buffers, then flushes on open;
- `close()` sends `{"type":"Terminate"}`, closes the socket, and tolerates a
  missing/late socket (no await);
- `Turn` carrying `language_code`/`language_confidence` (with `languageDetection`)
  → `onLanguageDetected`; not fired when the metadata is absent.

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
2. **Language is set via `prompt`, not a language param.** u3-rt-pro silently
   ignores the `language_code` connection parameter; transcription language is
   guided via the `prompt` option (e.g. prepend "Transcribe Spanish." to the
   default prompt — a beta mechanism AssemblyAI is still tuning). The pipeline's
   `TranscriberSessionOptions.language` is not auto-forwarded into a prompt.
   Detected-language metadata (`language_code`/`language_confidence`) is available
   by enabling `languageDetection` and reading the `onLanguageDetected` callback.
   Documented in the README.
3. **Single model / 6 languages.** Locked to `u3-rt-pro` (en/es/de/fr/pt/it).
   Use cases needing whisper-rt's 99-language coverage or a different streaming
   model are not served until a `model` option is added (see §3 out-of-scope).

## 12. Open items / assumptions to verify

1. **AI Gateway over WebSocket for AssemblyAI** — whether Cloudflare AI Gateway
   proxies AssemblyAI Streaming v3 WS connections, and the exact URL/path. The
   `baseUrl` override means the provider works regardless; the typed gateway helper
   (out of scope) waits on this verification.
