# Voice Transcriber Readiness

Status: accepted

## The Problem

A startup race in the voice-agent example exposed that `withVoice()` has no transcriber readiness signal. On call start, `withVoice()` creates the transcriber session and then immediately calls `onCallStart()`. The example's `onCallStart()` speaks an initial greeting. The observed failure happened with Workers AI Flux STT and Inworld TTS 2: the Flux upstream WebSocket sometimes failed during startup with `InferenceUpstreamError`. The browser then continued sending audio, but the failed Flux session never emitted interim or final transcripts, so the app stayed in `listening` with no visible user transcript or assistant response.

The temporary example-level fix waited briefly before playing the greeting. That proved the issue was sequencing, but it was not the right abstraction. An example should not know that one provider combination needs to wait for a transcriber provider to finish async startup.

The core issue is that `TranscriberSession` has no readiness signal. The voice pipeline can feed audio into a pending session, but it cannot distinguish between:

- the session is still connecting and buffering audio;
- the session is connected and ready;
- the session failed to connect and will never emit transcripts.

## The Proposal

Add an optional transcriber readiness hook to `@cloudflare/voice` so `withVoice()` can wait for async transcriber startup before running `onCallStart()`.

This RFC intentionally scopes the first implementation to `withVoice()` and `WorkersAIFluxSTT`, because Flux is the transcriber path that exposed the race. Nova 3 and `withVoiceInput()` should use the same readiness shape later, but they do not need to be included in the minimal fix for async transcriber startup sequencing.

### API

Add an optional method to `TranscriberSession`:

```ts
export interface TranscriberSession {
  feed(chunk: ArrayBuffer): void;
  waitUntilReady?(): Promise<void>;
  close(): void;
}
```

The method is optional to preserve compatibility with existing custom transcribers. Providers that connect synchronously, or that do not need readiness sequencing, can omit it.

Use a method instead of a promise property to avoid unhandled rejection hazards for consumers that never observe readiness.

Provider contract:

- repeated calls return the same startup result;
- resolve only once the session can accept audio and emit transcripts;
- reject when startup fails and the session will not emit transcripts;
- settle when startup is abandoned by `close()` so callers do not hang forever.

### Audio Manager

Change `AudioConnectionManager.startTranscriberSession()` to return the created session:

```ts
startTranscriberSession(...): TranscriberSession {
  this.closeTranscriberSession(connectionId);
  const session = transcriber.createSession(options);
  this.#transcriberSessions.set(connectionId, session);
  return session;
}
```

Existing callers can ignore the return value.

### Voice Pipeline Sequencing

Update `withVoice()` call startup flow:

1. Initialize connection state.
2. Run `beforeCallStart()`.
3. Create the transcriber session.
4. Await `session.waitUntilReady?.()`.
5. Send `status: listening`.
6. Run `onCallStart()`.

The await must be guarded by the current call startup identity, not just by checking whether the connection is currently in a call. If the client sends `end_call`, disconnects, or starts another call while readiness is pending, the stale startup path must not later send `listening`, report a startup error, or run `onCallStart()`.

If session creation throws or readiness rejects:

- log the error server-side;
- send `{ type: "error", message: "Speech recognition failed to start" }` to the client;
- send `{ type: "status", status: "idle" }`;
- clean up the connection state;
- release the keepalive;
- run the same application-level call cleanup path used for an ended call, so state set in `beforeCallStart()` is released;
- do not call `onCallStart()`.

This makes the failure mode explicit instead of leaving the UI apparently listening forever.

The client currently clears errors on `idle`, so the implementation should ensure the startup error remains observable. The minimal preferred fix is to preserve startup errors when processing the following `idle` status; if that is not practical, send `idle` before the startup error so the final visible state includes the error.

### Workers AI Providers

Implement readiness in the Workers AI Flux streaming STT provider.

For `FluxSession`:

- create an internal readiness promise in the constructor;
- resolve after `ai.run("@cf/deepgram/flux", ..., { websocket: true })` returns a `webSocket`, the socket is accepted, event listeners are installed, and pending chunks are flushed;
- reject if `ai.run()` throws or returns no `webSocket`;
- keep current `feed()` buffering behavior unchanged while connecting.

Nova 3 should be handled in a follow-up together with `withVoiceInput()`. Implementing Nova 3 readiness without also making `withVoiceInput()` await readiness would be inconsistent and outside this narrow `withVoice()`/Flux fix.

### Example Cleanup

Remove any provider-specific startup delay workaround from `examples/voice-agent/src/server.ts` once `withVoice()` waits for transcriber readiness. The example should simply speak the greeting in `onCallStart()` without provider-specific sleeps.

## Implementation Plan

1. Update `packages/voice/src/types.ts`.
   Add optional `waitUntilReady?(): Promise<void>` to `TranscriberSession` with a short doc comment.

2. Update `packages/voice/src/audio-pipeline.ts`.
   Make `startTranscriberSession()` return the created `TranscriberSession`.

3. Update `packages/voice/src/voice.ts`.
   Capture the returned session in `#handleStartCall()`, record a per-startup identity token, await readiness before sending `listening` and before `onCallStart()`, and handle session creation or readiness failure with cleanup and a client-visible error.

4. Update `packages/voice/src/workers-ai-providers.ts`.
   Add a readiness promise to `FluxSession`. Resolve only after the upstream WebSocket is accepted and ready to receive buffered audio. Reject startup failures. Ensure closing the session while startup is pending settles readiness so callers do not wait forever.

5. Update tests.
   Add or adjust tests in `packages/voice/src/tests/audio-pipeline.test.ts` to assert that `startTranscriberSession()` returns the session. Add tests in `packages/voice/src/tests/voice.test.ts` for readiness sequencing, readiness failure, stale pending startup after `end_call`, and compatibility with transcribers that omit `waitUntilReady()`.

6. Remove the workaround.
   Delete any provider-specific startup delay in `examples/voice-agent/src/server.ts`.

7. Verify.
   Run the voice tests, relevant provider tests, voice-agent build, and full repo check. Deploy the voice-agent example and verify Flux with an initial `onCallStart()` greeting in the browser, including the known Inworld TTS 2 repro path if available.

## Tests

Add focused tests for the behavior change.

### Audio Manager

- `startTranscriberSession()` returns the created session.
- Existing lifecycle behavior remains unchanged: replacing a session closes the previous one, cleanup closes the active session, and audio still feeds the active session.

### Voice Startup Readiness

Create a test transcriber with a controllable readiness promise.

- Start a call.
- Assert `onCallStart()` does not run before readiness resolves.
- Resolve readiness.
- Assert `status: listening` and greeting behavior proceed.

### Readiness Failure

Create a test transcriber whose `waitUntilReady()` rejects.

- Start a call.
- Assert the client receives an error.
- Assert status returns to `idle`.
- Assert `onCallStart()` does not run.
- Assert connection state is cleaned up so a later call attempt can start normally.
- Assert application-level call cleanup runs so state set by `beforeCallStart()` is released.
- Repeat with a transcriber whose `createSession()` throws and assert the same cleanup behavior.

### Stale Startup

Create a test transcriber whose readiness promise remains pending.

- Start a call.
- End the call before readiness resolves.
- Resolve or reject readiness.
- Assert no stale `listening`, startup error, or `onCallStart()` occurs after the call has ended.

### Custom Transcriber Compatibility

Use the existing test transcriber without `waitUntilReady()`.

- Assert startup still proceeds immediately.
- Assert existing transcript and lifecycle behavior remains unchanged.

### Provider Readiness

For Workers AI Flux provider unit tests, assert readiness resolves when the mock `ai.run()` returns a WebSocket and rejects when the mock throws or returns no WebSocket. Also assert close-before-connect does not hang readiness.

Nova 3 provider readiness tests should be added in the follow-up that wires readiness through `withVoiceInput()`.

## Diagnostics Follow-Up

This change fixes sequencing, but the debugging experience showed a separate observability gap. A future design should add structured diagnostics to `@cloudflare/voice`, including:

- transcriber connect start, ready, and failure events;
- provider names and model names;
- audio chunk counts and optional redacted level statistics;
- transcript interim/final timing;
- pipeline timing from call start through first audio.

Provider packages and Workers AI should surface errors through the same diagnostic path where possible. Platform errors like `InferenceUpstreamError` should include model name, upstream stage, retryability, and a correlation ID.

## Alternatives

### Keep an Example-Level Startup Delay

This is the smallest tactical fix, and it was proven to work for the original repro. It is not desirable long-term because it encodes a transcriber startup dependency as a provider-specific delay in an example. It also leaves other provider combinations or future startup races unsolved.

### Start the Greeting Only After First Audio Chunk

Waiting for user audio before greeting would avoid some startup races, but it changes the UX and still does not prove STT is connected. The greeting should be independent of user speech.

### Make `createSession()` Async

An async `createSession()` would express readiness directly, but it would be a larger breaking change for the transcriber interface. Optional `waitUntilReady()` gives us the same sequencing ability without forcing every provider and custom implementation to change.

### Implement Flux and Nova 3 Together

Implementing both Workers AI streaming STT providers would make provider semantics more uniform, but it expands this fix into `withVoiceInput()` as well. The immediate production issue is Flux under `withVoice()`, so the first change should stay narrow and avoid altering Nova 3 behavior until it is tested end-to-end in its primary input-only path.

### Retry Flux Startup Internally

Retries may be useful, but they do not replace readiness. The voice pipeline still needs to know whether startup succeeded before it proceeds. Retries can be added behind `waitUntilReady()` later.

## Tradeoffs

- Call startup may be delayed by STT connection latency for providers that implement readiness.
- `onCallStart()` behavior changes slightly: it runs after the transcriber is ready instead of immediately after session creation.
- A failed STT startup becomes visible to users as a call-start error instead of silently continuing.
- The optional API keeps compatibility, but providers that omit readiness can still race in provider-specific ways.
- The first implementation fixes Flux only; Nova 3 remains on the old startup behavior until the follow-up wires readiness through `withVoiceInput()`.

## Decision

Accepted. Implement the generic optional readiness hook first, wire it through `withVoice()`, and add provider readiness only for Workers AI Flux STT. Defer Nova 3 and `withVoiceInput()` readiness until that path is designed and tested end-to-end.
