# AssemblyAI Voice STT Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@cloudflare/voice-assemblyai` — a type-compliant Universal-3 Pro Streaming STT provider for the Cloudflare Agents voice pipeline, mirroring the Deepgram/Telnyx example.

**Architecture:** New workspace package at `voice-providers/assemblyai/` exporting `AssemblyAISTT` (implements `Transcriber`) and an internal `AssemblyAISession` (implements `TranscriberSession`). The session connects to AssemblyAI Streaming v3 at `wss://streaming.assemblyai.com/v3/ws` via a `fetch()` WebSocket-upgrade with the API key in the `Authorization` header. Model is locked to `u3-rt-pro`; encoding/sample-rate are pipeline-fixed. Inbound `Turn`/`SpeechStarted` events route to the pipeline's `onInterim`/`onUtterance`/`onSpeechStart` callbacks; language metadata routes to a provider-specific `onLanguageDetected`. URL construction is factored into a pure helper for direct testing; session lifecycle is tested via a mocked global `fetch` returning a mock `WebSocket`.

**Tech Stack:** TypeScript, Cloudflare Workers runtime types, `@cloudflare/voice` (peer dep), `tsdown` (build, identical to Deepgram), `vitest` (tests, node env, `vi.stubGlobal('fetch', …)`).

**Companion spec:** `docs/superpowers/specs/2026-05-27-assemblyai-voice-provider-design.md` — read first; this plan implements §7's options interface and §6's protocol mapping.

---

## File Structure

**New files:**
- `voice-providers/assemblyai/package.json` — workspace package config (private, peerDep `@cloudflare/voice: *`)
- `voice-providers/assemblyai/tsconfig.json` — extends `agents/tsconfig`
- `voice-providers/assemblyai/scripts/build.ts` — `tsdown` build, identical to `voice-providers/deepgram/scripts/build.ts`
- `voice-providers/assemblyai/vitest.config.ts` — node env, `tests/**/*.test.ts`
- `voice-providers/assemblyai/src/index.ts` — `AssemblyAISTTOptions`, `AssemblyAISTT`, internal `AssemblyAISession`, internal `_buildConnectionUrl` (exported for tests, underscore-prefixed)
- `voice-providers/assemblyai/tests/index.test.ts` — all unit + session tests + shared mock-WS helper
- `voice-providers/assemblyai/README.md` — install, usage, options table, AI Gateway URL / EU host docs, known limitations

**Modified files:**
- `packages/voice/README.md` — add row to "Third-party providers" table
- `docs/voice.md` — add provider mention alongside Deepgram/ElevenLabs

The root `package.json` already globs `voice-providers/*` into the workspaces array, so no root changes are needed.

---

## Task 1: Scaffold the package

**Files:**
- Create: `voice-providers/assemblyai/package.json`
- Create: `voice-providers/assemblyai/tsconfig.json`
- Create: `voice-providers/assemblyai/scripts/build.ts`
- Create: `voice-providers/assemblyai/vitest.config.ts`
- Create: `voice-providers/assemblyai/src/index.ts` (placeholder)
- Create: `voice-providers/assemblyai/tests/index.test.ts` (placeholder)
- Create: `voice-providers/assemblyai/README.md` (placeholder)

- [ ] **Step 1: Create `package.json`** — mirror Deepgram, add `test`/`test:run` scripts like Telnyx.

```json
{
  "name": "@cloudflare/voice-assemblyai",
  "private": true,
  "version": "0.0.1",
  "description": "AssemblyAI Universal-3 Pro Streaming STT provider for Cloudflare Agents voice pipeline",
  "repository": {
    "directory": "voice-providers/assemblyai",
    "type": "git",
    "url": "git+https://github.com/cloudflare/agents.git"
  },
  "bugs": { "url": "https://github.com/cloudflare/agents/issues" },
  "peerDependencies": { "@cloudflare/voice": "*" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsx ./scripts/build.ts",
    "test": "vitest --run"
  },
  "keywords": ["cloudflare", "agents", "voice", "stt", "assemblyai", "speech-to-text", "streaming"],
  "author": "Cloudflare Inc.",
  "license": "MIT",
  "type": "module",
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 2: Create `tsconfig.json`** — extends the workspace base, identical to Deepgram.

```json
{ "extends": "agents/tsconfig" }
```

- [ ] **Step 3: Create `scripts/build.ts`** — identical to Deepgram's build (use `tsdown` and `formatDeclarationFiles`).

```typescript
import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts"],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });
  formatDeclarationFiles();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Create `vitest.config.ts`** — node environment, mirror Telnyx.

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 5: Create placeholder `src/index.ts`** — exports the package symbol so the smoke test in Step 6 passes.

```typescript
// Placeholder — filled in by subsequent tasks.
export const __PACKAGE__ = "@cloudflare/voice-assemblyai";
```

- [ ] **Step 6: Create placeholder `tests/index.test.ts`** — smoke test that the package imports.

```typescript
import { describe, it, expect } from "vitest";
import { __PACKAGE__ } from "../src/index";

describe("@cloudflare/voice-assemblyai", () => {
  it("loads", () => {
    expect(__PACKAGE__).toBe("@cloudflare/voice-assemblyai");
  });
});
```

- [ ] **Step 7: Create placeholder `README.md`** — short stub; filled in by Task 12.

```markdown
# @cloudflare/voice-assemblyai

AssemblyAI Universal-3 Pro Streaming STT provider for the Cloudflare Agents voice pipeline. See [companion spec](../../docs/superpowers/specs/2026-05-27-assemblyai-voice-provider-design.md) for the design.
```

- [ ] **Step 8: Install workspace** — picks up the new package via the existing `voice-providers/*` glob.

```bash
npm install
```
Expected: `npm` resolves the new workspace; no errors.

- [ ] **Step 9: Verify build and test green on the empty package.**

```bash
npm run build --workspace @cloudflare/voice-assemblyai
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: build emits `dist/index.js` + `dist/index.d.ts`; test prints `1 passed` for the smoke test.

- [ ] **Step 10: Commit.**

```bash
git add voice-providers/assemblyai
git commit -m "feat(voice-assemblyai): scaffold package"
```

---

## Task 2: Define `AssemblyAISTTOptions` and the URL builder (TDD)

URL construction is factored into a pure helper `_buildConnectionUrl(opts)` exported from `src/index.ts` for direct testing. This task writes the helper and exercises every connection parameter described in spec §7. All tests live in `tests/index.test.ts`.

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write failing tests for URL building** — covering hardcoded params, each conditional param, and the `baseUrl` override.

Replace `tests/index.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { _buildConnectionUrl, type AssemblyAISTTOptions } from "../src/index";

function parse(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("_buildConnectionUrl — always-present params", () => {
  it("uses the AssemblyAI streaming host by default", () => {
    const url = new URL(_buildConnectionUrl({ apiKey: "k" }));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("streaming.assemblyai.com");
    expect(url.pathname).toBe("/v3/ws");
  });

  it("hardcodes speech_model, sample_rate, encoding", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    expect(p.get("speech_model")).toBe("u3-rt-pro");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("encoding")).toBe("pcm_s16le");
  });

  it("never sends format_turns or the API key in the query", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "secret" }));
    expect(p.has("format_turns")).toBe(false);
    expect(p.has("token")).toBe(false);
    expect(p.has("apikey")).toBe(false);
    expect(p.has("ApiKey")).toBe(false);
  });
});

describe("_buildConnectionUrl — conditional params (only when set)", () => {
  it("omits all conditional params when none set", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    for (const k of [
      "domain", "keyterms_prompt", "prompt",
      "min_turn_silence", "max_turn_silence",
      "interruption_delay", "vad_threshold",
      "continuous_partials", "language_detection"
    ]) {
      expect(p.has(k)).toBe(false);
    }
  });

  it("forwards domain", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k", domain: "medical-v1" }));
    expect(p.get("domain")).toBe("medical-v1");
  });

  it("JSON-encodes keyterms into keyterms_prompt", () => {
    const p = parse(_buildConnectionUrl({
      apiKey: "k",
      keyterms: ["metoprolol", "Skyrizi"]
    }));
    expect(p.get("keyterms_prompt")).toBe('["metoprolol","Skyrizi"]');
  });

  it("forwards prompt", () => {
    const p = parse(_buildConnectionUrl({
      apiKey: "k",
      prompt: "Transcribe Spanish."
    }));
    expect(p.get("prompt")).toBe("Transcribe Spanish.");
  });

  it("forwards turn-detection and barge-in knobs", () => {
    const p = parse(_buildConnectionUrl({
      apiKey: "k",
      minTurnSilence: 200,
      maxTurnSilence: 2000,
      interruptionDelay: 0,
      vadThreshold: 0.3
    }));
    expect(p.get("min_turn_silence")).toBe("200");
    expect(p.get("max_turn_silence")).toBe("2000");
    expect(p.get("interruption_delay")).toBe("0");
    expect(p.get("vad_threshold")).toBe("0.3");
  });

  it("forwards continuousPartials and languageDetection as booleans", () => {
    const p = parse(_buildConnectionUrl({
      apiKey: "k",
      continuousPartials: true,
      languageDetection: true
    }));
    expect(p.get("continuous_partials")).toBe("true");
    expect(p.get("language_detection")).toBe("true");
  });
});

describe("_buildConnectionUrl — baseUrl override", () => {
  it("baseUrl replaces the default host", () => {
    const url = new URL(_buildConnectionUrl({
      apiKey: "k",
      baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"
    }));
    expect(url.host).toBe("streaming.eu.assemblyai.com");
    expect(url.pathname).toBe("/v3/ws");
  });

  it("baseUrl keeps the same hardcoded query params", () => {
    const p = parse(_buildConnectionUrl({
      apiKey: "k",
      baseUrl: "wss://gateway.example.com/v1/acct/gw/assemblyai/v3/ws"
    }));
    expect(p.get("speech_model")).toBe("u3-rt-pro");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("encoding")).toBe("pcm_s16le");
  });
});
```

- [ ] **Step 2: Run tests; verify they fail** with "no such export `_buildConnectionUrl` / `AssemblyAISTTOptions`".

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: tests fail to import (compile error). This is the red bar.

- [ ] **Step 3: Replace `src/index.ts`** with the options interface and the helper. Drop the placeholder export.

```typescript
/**
 * @cloudflare/voice-assemblyai — Universal-3 Pro Streaming STT provider for
 * the Cloudflare Agents voice pipeline. See companion design spec at
 * docs/superpowers/specs/2026-05-27-assemblyai-voice-provider-design.md.
 */

export interface AssemblyAISTTOptions {
  /** AssemblyAI API key. Sent as the `Authorization` header (raw key, no prefix). */
  apiKey: string;
  /** Domain specialization → `domain=<value>`. `"medical-v1"` enables Medical Mode. */
  domain?: "medical-v1" | (string & {});
  /** Domain vocabulary → `keyterms_prompt` (JSON-encoded). */
  keyterms?: string[];
  /**
   * Custom transcription prompt → `prompt`. Omit to use AssemblyAI's optimized
   * default prompt (recommended — 88% turn-detection accuracy). If set, build
   * off the default; prompts that reduce punctuation degrade turn detection.
   */
  prompt?: string;
  /** Min silence (ms) before EOT check → `min_turn_silence`. Server default 100. */
  minTurnSilence?: number;
  /** Max silence (ms) before forced EOT → `max_turn_silence`. Server default 1000. */
  maxTurnSilence?: number;
  /** First-partial timing 0–1000 ms → `interruption_delay`. Server default 500. */
  interruptionDelay?: number;
  /** VAD silence threshold 0–1 → `vad_threshold`. Raise in noisy environments. */
  vadThreshold?: number;
  /** Steady ~3 s partials during long turns → `continuous_partials`. */
  continuousPartials?: boolean;
  /** Return language metadata on Turn → `language_detection`. Surface via `onLanguageDetected`. */
  languageDetection?: boolean;
  /** Called when a Turn carries language metadata. Requires `languageDetection: true`. */
  onLanguageDetected?: (languageCode: string, languageConfidence: number) => void;
  /**
   * Full WebSocket base URL override (e.g. EU host or Cloudflare AI Gateway URL).
   * @default "wss://streaming.assemblyai.com/v3/ws"
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";

/**
 * Build the AssemblyAI Streaming v3 WebSocket URL from provider options.
 * Underscore-prefixed: internal helper, exported only for unit tests.
 */
export function _buildConnectionUrl(opts: AssemblyAISTTOptions): string {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    speech_model: "u3-rt-pro",
    sample_rate: "16000",
    encoding: "pcm_s16le"
  });

  if (opts.domain !== undefined) params.set("domain", opts.domain);
  if (opts.keyterms !== undefined) {
    params.set("keyterms_prompt", JSON.stringify(opts.keyterms));
  }
  if (opts.prompt !== undefined) params.set("prompt", opts.prompt);
  if (opts.minTurnSilence !== undefined) {
    params.set("min_turn_silence", String(opts.minTurnSilence));
  }
  if (opts.maxTurnSilence !== undefined) {
    params.set("max_turn_silence", String(opts.maxTurnSilence));
  }
  if (opts.interruptionDelay !== undefined) {
    params.set("interruption_delay", String(opts.interruptionDelay));
  }
  if (opts.vadThreshold !== undefined) {
    params.set("vad_threshold", String(opts.vadThreshold));
  }
  if (opts.continuousPartials !== undefined) {
    params.set("continuous_partials", String(opts.continuousPartials));
  }
  if (opts.languageDetection !== undefined) {
    params.set("language_detection", String(opts.languageDetection));
  }

  return `${base}?${params.toString()}`;
}
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 9 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): options interface and URL builder"
```

---

## Task 3: `AssemblyAISTT` class implements `Transcriber`

Add the public class. `createSession()` will be expanded in Task 4 to actually connect; for this task it just returns a session shell that implements the interface (no-op `feed`/`close`). This isolates the type-conformance step from the network logic.

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write the failing test** — `AssemblyAISTT` implements `Transcriber` and `createSession()` returns a session with `feed` and `close`.

Append to `tests/index.test.ts`:

```typescript
import { AssemblyAISTT } from "../src/index";

describe("AssemblyAISTT class shape", () => {
  it("createSession returns an object with feed() and close()", () => {
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    expect(typeof session.feed).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});
```

- [ ] **Step 2: Run tests; verify the new test fails** with "no such export `AssemblyAISTT`".

```bash
npm test --workspace @cloudflare/voice-assemblyai
```

- [ ] **Step 3: Add the class to `src/index.ts`** — minimal session shell that implements the interface (the connect logic comes in Task 4).

Append to `src/index.ts`:

```typescript
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "@cloudflare/voice";

/**
 * AssemblyAI Universal-3 Pro Streaming STT provider for the Cloudflare Agents
 * voice pipeline. Connects via WebSocket per call; the model handles turn
 * detection via punctuation (no client-side speech-boundary signalling needed).
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new AssemblyAISTT({ apiKey: this.env.ASSEMBLYAI_API_KEY });
 *   tts = new WorkersAITTS(this.env.AI);
 * }
 * ```
 */
export class AssemblyAISTT implements Transcriber {
  #options: AssemblyAISTTOptions;

  constructor(options: AssemblyAISTTOptions) {
    this.#options = options;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new AssemblyAISession(this.#options, options);
  }
}

/** Per-call AssemblyAI streaming session. Lives for the entire call. */
class AssemblyAISession implements TranscriberSession {
  #providerOpts: AssemblyAISTTOptions;
  #sessionOpts: TranscriberSessionOptions | undefined;

  constructor(
    providerOpts: AssemblyAISTTOptions,
    sessionOpts?: TranscriberSessionOptions
  ) {
    this.#providerOpts = providerOpts;
    this.#sessionOpts = sessionOpts;
  }

  feed(_chunk: ArrayBuffer): void {
    // Task 5 wires this to the WebSocket.
  }

  close(): void {
    // Task 8 wires this to the Terminate handshake.
  }
}
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 10 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): AssemblyAISTT class skeleton"
```

---

## Task 4: Session connects via `fetch()` upgrade with `Authorization` header

Wire `createSession` to call `fetch(url, { headers: { Upgrade: "websocket", Authorization: apiKey } })`, accept the returned `webSocket`, and store it on the session. No event handling yet — that's Tasks 5–7.

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Add the mock-WebSocket helper to the test file** — this is reused by every subsequent session test.

Append to `tests/index.test.ts`:

```typescript
import { vi, beforeEach, afterEach } from "vitest";

class MockWebSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setupMockFetch(): { ws: MockWebSocket; calls: MockFetchCall[] } {
  const ws = new MockWebSocket();
  const calls: MockFetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // Cloudflare's fetch-upgrade returns a Response-shaped object with
      // a webSocket property. Cast deliberately to mirror the real runtime.
      return { webSocket: ws } as unknown as Response;
    })
  );
  return { ws, calls };
}

// Flush microtasks so the session's async #connect() runs.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });
```

- [ ] **Step 2: Write the failing test** — creating a session calls `fetch` with the built URL, the `Upgrade: "websocket"` header, and the API key in `Authorization` (raw, no `Bearer`/`Token` prefix). The returned socket is accepted.

Append to `tests/index.test.ts`:

```typescript
describe("AssemblyAISession — connect", () => {
  it("calls fetch with the built URL and Authorization header, then accepts the WebSocket", async () => {
    const { ws, calls } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "MY_KEY" });

    provider.createSession();
    await flush();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(_buildConnectionUrl({ apiKey: "MY_KEY" }));
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Upgrade).toBe("websocket");
    expect(headers?.Authorization).toBe("MY_KEY");
    // Raw key — no Bearer or Token prefix.
    expect(headers?.Authorization).not.toMatch(/^Bearer /);
    expect(headers?.Authorization).not.toMatch(/^Token /);

    expect(ws.accept).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run tests; verify the new test fails.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: failure on `expect(calls).toHaveLength(1)` (no fetch was called yet).

- [ ] **Step 4: Implement the connect** — replace the `AssemblyAISession` constructor + add `#connect`. Add the `WebSocket` field. The class body is replaced wholesale here so the engineer sees the final shape; subsequent tasks add behavior to `#handleMessage`/`close`/`feed`.

Replace the `AssemblyAISession` class in `src/index.ts` with:

```typescript
class AssemblyAISession implements TranscriberSession {
  #providerOpts: AssemblyAISTTOptions;
  #sessionOpts: TranscriberSessionOptions | undefined;
  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;
  #pendingChunks: ArrayBuffer[] = [];

  constructor(
    providerOpts: AssemblyAISTTOptions,
    sessionOpts?: TranscriberSessionOptions
  ) {
    this.#providerOpts = providerOpts;
    this.#sessionOpts = sessionOpts;
    void this.#connect();
  }

  async #connect(): Promise<void> {
    try {
      const url = _buildConnectionUrl(this.#providerOpts);
      const resp = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          Authorization: this.#providerOpts.apiKey
        }
      });

      const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        console.error("[AssemblyAISTT] Failed to establish WebSocket connection");
        return;
      }

      if (this.#closed) {
        ws.accept();
        ws.close();
        return;
      }

      ws.accept();
      this.#ws = ws;
      this.#connected = true;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });
      ws.addEventListener("close", () => { this.#connected = false; });
      ws.addEventListener("error", (event: Event) => {
        console.error("[AssemblyAISTT] WebSocket error:", event);
        this.#connected = false;
      });

      for (const chunk of this.#pendingChunks) ws.send(chunk);
      this.#pendingChunks = [];
    } catch (err) {
      console.error("[AssemblyAISTT] Connection error:", err);
    }
  }

  feed(_chunk: ArrayBuffer): void {
    // Wired in Task 7.
  }

  close(): void {
    // Wired in Task 8.
  }

  #handleMessage(_event: MessageEvent): void {
    // Wired in Tasks 5 + 6.
  }
}
```

- [ ] **Step 5: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 11 tests pass.

- [ ] **Step 6: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): connect via fetch upgrade with Authorization header"
```

---

## Task 5: `Turn` events → `onInterim` / `onUtterance`

Map AssemblyAI `Turn` events to the pipeline callbacks: `end_of_turn: false` → `onInterim(transcript)`, `end_of_turn: true` → `onUtterance(transcript)`. Empty transcripts do not fire callbacks.

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write the failing tests.**

Append to `tests/index.test.ts`:

```typescript
describe("AssemblyAISession — Turn routing", () => {
  it("routes Turn{end_of_turn:false} to onInterim", async () => {
    const { ws } = setupMockFetch();
    const onInterim = vi.fn();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });

    provider.createSession({ onInterim, onUtterance });
    await flush();

    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "Turn", transcript: "hello", end_of_turn: false })
    }));

    expect(onInterim).toHaveBeenCalledWith("hello");
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it("routes Turn{end_of_turn:true} to onUtterance", async () => {
    const { ws } = setupMockFetch();
    const onInterim = vi.fn();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });

    provider.createSession({ onInterim, onUtterance });
    await flush();

    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "Turn", transcript: "Hello world.", end_of_turn: true })
    }));

    expect(onUtterance).toHaveBeenCalledWith("Hello world.");
    expect(onInterim).not.toHaveBeenCalled();
  });

  it("ignores Turn events with an empty transcript", async () => {
    const { ws } = setupMockFetch();
    const onInterim = vi.fn();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });

    provider.createSession({ onInterim, onUtterance });
    await flush();

    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "Turn", transcript: "", end_of_turn: true })
    }));

    expect(onInterim).not.toHaveBeenCalled();
    expect(onUtterance).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests; verify the new tests fail.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```

- [ ] **Step 3: Implement `#handleMessage`** — replace the body of the method on `AssemblyAISession` with:

```typescript
  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    let data: Record<string, unknown> | null;
    try {
      data = typeof event.data === "string"
        ? (JSON.parse(event.data) as Record<string, unknown>)
        : null;
    } catch {
      return; // ignore malformed JSON
    }
    if (!data || typeof data.type !== "string") return;

    if (data.type === "Turn") {
      const transcript = typeof data.transcript === "string" ? data.transcript : "";
      if (!transcript) return;
      if (data.end_of_turn === true) {
        this.#sessionOpts?.onUtterance?.(transcript);
      } else {
        this.#sessionOpts?.onInterim?.(transcript);
      }
    }
  }
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 14 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): map Turn events to onInterim/onUtterance"
```

---

## Task 6: `SpeechStarted` → `onSpeechStart` and language metadata → `onLanguageDetected`

Add the remaining event mappings: `SpeechStarted` (u3-rt-pro VAD) → `onSpeechStart()`, and Turn carrying `language_code`/`language_confidence` → the provider-specific `onLanguageDetected` callback (only when both metadata fields are present and the callback is set; firing is independent of `languageDetection` — if the server sent the metadata, surface it).

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write the failing tests.**

Append to `tests/index.test.ts`:

```typescript
describe("AssemblyAISession — SpeechStarted and language metadata", () => {
  it("routes SpeechStarted to onSpeechStart", async () => {
    const { ws } = setupMockFetch();
    const onSpeechStart = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession({ onSpeechStart });
    await flush();

    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "SpeechStarted" })
    }));

    expect(onSpeechStart).toHaveBeenCalledTimes(1);
  });

  it("fires onLanguageDetected when a Turn carries language metadata", async () => {
    const { ws } = setupMockFetch();
    const onLanguageDetected = vi.fn();
    const provider = new AssemblyAISTT({
      apiKey: "k",
      languageDetection: true,
      onLanguageDetected
    });
    provider.createSession({});
    await flush();

    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        type: "Turn",
        transcript: "hola",
        end_of_turn: true,
        language_code: "es",
        language_confidence: 0.97
      })
    }));

    expect(onLanguageDetected).toHaveBeenCalledWith("es", 0.97);
  });

  it("does not fire onLanguageDetected when metadata is absent", async () => {
    const { ws } = setupMockFetch();
    const onLanguageDetected = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k", onLanguageDetected });
    provider.createSession({});
    await flush();

    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "Turn", transcript: "hi", end_of_turn: true })
    }));

    expect(onLanguageDetected).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests; verify the new tests fail.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```

- [ ] **Step 3: Extend `#handleMessage`** in `AssemblyAISession` to handle both. Replace its body with:

```typescript
  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    let data: Record<string, unknown> | null;
    try {
      data = typeof event.data === "string"
        ? (JSON.parse(event.data) as Record<string, unknown>)
        : null;
    } catch {
      return;
    }
    if (!data || typeof data.type !== "string") return;

    if (data.type === "Turn") {
      const transcript = typeof data.transcript === "string" ? data.transcript : "";

      // Language metadata is delivered alongside the transcript; surface it
      // independently because the pipeline callbacks are text-only.
      const code = typeof data.language_code === "string" ? data.language_code : undefined;
      const confidence = typeof data.language_confidence === "number"
        ? data.language_confidence
        : undefined;
      if (code !== undefined && confidence !== undefined) {
        this.#providerOpts.onLanguageDetected?.(code, confidence);
      }

      if (!transcript) return;
      if (data.end_of_turn === true) {
        this.#sessionOpts?.onUtterance?.(transcript);
      } else {
        this.#sessionOpts?.onInterim?.(transcript);
      }
      return;
    }

    if (data.type === "SpeechStarted") {
      this.#sessionOpts?.onSpeechStart?.();
      return;
    }
  }
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 17 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): map SpeechStarted and language metadata"
```

---

## Task 7: `feed()` — pre-connect buffering and post-connect send

Implement audio forwarding: before the WebSocket is connected, buffer chunks into `#pendingChunks`; once connected, flush and send live. After `close()`, drop chunks.

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write the failing tests.**

Append to `tests/index.test.ts`:

```typescript
describe("AssemblyAISession — feed", () => {
  it("buffers audio fed before connect, then flushes on open", async () => {
    // Block fetch so the session is unconnected when feed() is first called.
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => { resolveFetch = r; });
    const ws = new MockWebSocket();
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    const chunkA = new Uint8Array([1, 2, 3]).buffer;
    const chunkB = new Uint8Array([4, 5, 6]).buffer;
    session.feed(chunkA);
    session.feed(chunkB);

    expect(ws.send).not.toHaveBeenCalled();

    resolveFetch({ webSocket: ws });
    await flush();

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenNthCalledWith(1, chunkA);
    expect(ws.send).toHaveBeenNthCalledWith(2, chunkB);
  });

  it("sends audio immediately once connected", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    const chunk = new Uint8Array([7, 8, 9]).buffer;
    session.feed(chunk);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(chunk);
  });
});
```

- [ ] **Step 2: Run tests; verify the new tests fail** (the placeholder `feed` is a no-op).

```bash
npm test --workspace @cloudflare/voice-assemblyai
```

- [ ] **Step 3: Replace the `feed` method** on `AssemblyAISession` with:

```typescript
  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      this.#pendingChunks.push(chunk);
    }
  }
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 19 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): buffer audio before connect, flush on open"
```

---

## Task 8: `close()` — send `Terminate`, close the socket, tolerate edge cases

Implement teardown: send `{"type":"Terminate"}` over the WS, then `close()` it. Synchronous. Drop any pending chunks. Tolerate a late socket (closed before connect resolved) and a double-close.

**Files:**
- Modify: `voice-providers/assemblyai/src/index.ts`
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write the failing tests.**

Append to `tests/index.test.ts`:

```typescript
describe("AssemblyAISession — close", () => {
  it("sends Terminate then closes the WebSocket", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.close();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "Terminate" }));
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on a second close()", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.close();
    session.close();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("when called before the socket connects, the socket is accepted-and-closed once it arrives", async () => {
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => { resolveFetch = r; });
    const ws = new MockWebSocket();
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    session.close(); // before fetch resolves
    resolveFetch({ webSocket: ws });
    await flush();

    expect(ws.accept).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled(); // never sent Terminate (no live connection)
  });
});
```

- [ ] **Step 2: Run tests; verify the new tests fail.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```

- [ ] **Step 3: Replace the `close` method** on `AssemblyAISession` with:

```typescript
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];

    if (this.#ws && this.#connected) {
      try {
        this.#ws.send(JSON.stringify({ type: "Terminate" }));
      } catch {
        // ignore
      }
    }
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // ignore close errors
      }
      this.#ws = null;
    }
    this.#connected = false;
  }
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 22 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add voice-providers/assemblyai/src/index.ts voice-providers/assemblyai/tests/index.test.ts
git commit -m "feat(voice-assemblyai): graceful close with Terminate handshake"
```

---

## Task 9: Robustness — ignore malformed messages

Confirm that non-JSON or shape-wrong messages do not throw out of the WebSocket event handler (spec §8). The implementation already wraps `JSON.parse` in `try/catch`; this task locks that behavior in a test.

**Files:**
- Modify: `voice-providers/assemblyai/tests/index.test.ts`

- [ ] **Step 1: Write the test.**

Append to `tests/index.test.ts`:

```typescript
describe("AssemblyAISession — robustness", () => {
  it("ignores non-JSON messages without throwing", async () => {
    const { ws } = setupMockFetch();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession({ onUtterance });
    await flush();

    expect(() => {
      ws.dispatchEvent(new MessageEvent("message", { data: "not json {{{" }));
    }).not.toThrow();
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it("ignores binary message frames", async () => {
    const { ws } = setupMockFetch();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession({ onUtterance });
    await flush();

    expect(() => {
      ws.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(8) }));
    }).not.toThrow();
    expect(onUtterance).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests; verify they pass without changes** (Task 5 implementation already handles this).

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: 24 tests pass.

- [ ] **Step 3: Commit.**

```bash
git add voice-providers/assemblyai/tests/index.test.ts
git commit -m "test(voice-assemblyai): pin malformed-message robustness"
```

---

## Task 10: Final build + lint + format check on the package

Before writing docs, confirm the package builds cleanly and the source passes lint/format.

**Files:**
- None (verification only).

- [ ] **Step 1: Run the package build.**

```bash
npm run build --workspace @cloudflare/voice-assemblyai
```
Expected: `dist/index.js`, `dist/index.d.ts`, `dist/index.js.map` produced.

- [ ] **Step 2: Run lint (workspace-level oxlint).**

```bash
npx oxlint voice-providers/assemblyai/src voice-providers/assemblyai/tests
```
Expected: no findings. Fix any flagged issues (most likely import order / unused vars). Re-run after fixes.

- [ ] **Step 3: Run format check.**

```bash
npx oxfmt --check voice-providers/assemblyai/src voice-providers/assemblyai/tests
```
If anything is reformatted, run `npx oxfmt --write voice-providers/assemblyai/src voice-providers/assemblyai/tests` and re-check.

- [ ] **Step 4: If anything changed, commit.**

```bash
git add voice-providers/assemblyai
git commit -m "chore(voice-assemblyai): lint and format" || echo "nothing to commit"
```

---

## Task 11: README for `@cloudflare/voice-assemblyai`

Write the package README — install, full usage example, options table (in Deepgram's style for ecosystem familiarity), AI Gateway and EU host docs, and the known limitations from spec §11.

**Files:**
- Modify: `voice-providers/assemblyai/README.md`

- [ ] **Step 1: Replace `README.md`** with the following.

```markdown
# @cloudflare/voice-assemblyai

[AssemblyAI Universal-3 Pro Streaming](https://www.assemblyai.com/docs/streaming/universal-3-pro) speech-to-text provider for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline.

Universal-3 Pro is AssemblyAI's voice-agent model: sub-300 ms time-to-final, punctuation-based turn detection, barge-in signals, and a fully promptable interface. The provider opens a single WebSocket per call, streams 16 kHz mono PCM16, and routes AssemblyAI's `Turn` and `SpeechStarted` events to the pipeline's callbacks.

## Install

```bash
npm install @cloudflare/voice-assemblyai
```

## Usage

Set `transcriber` on your voice agent:

```typescript
import { Agent } from "agents";
import { withVoice, WorkersAITTS, type VoiceTurnContext } from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new AssemblyAISTT({
    apiKey: this.env.ASSEMBLYAI_API_KEY,
    domain: "medical-v1",          // optional — Medical Mode
    keyterms: ["metoprolol"]        // optional — recognition boost
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // your LLM logic — transcript is the finalized utterance (Turn end_of_turn=true)
  }
}
```

Provide the key as a Worker secret:

```bash
npx wrangler secret put ASSEMBLYAI_API_KEY
```

## Options

| Option                | Default                     | Description                                                                                       |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `apiKey`              | (required)                  | AssemblyAI API key — sent as the `Authorization` header (raw key, no prefix).                     |
| `domain`              | _none_                      | Domain specialization, e.g. `"medical-v1"`. Future values (legal, finance) just work.             |
| `keyterms`            | _none_                      | Domain vocabulary array → `keyterms_prompt` (JSON-encoded).                                       |
| `prompt`              | _none — server default used_ | Custom transcription prompt. **Omit to use AssemblyAI's optimized default (recommended).**        |
| `minTurnSilence`      | 100 ms _(server)_           | Min silence before a speculative end-of-turn check. Tune for Fast/Balanced/Patient presets.       |
| `maxTurnSilence`      | 1000 ms _(server)_          | Max silence before a turn is forced to end.                                                       |
| `interruptionDelay`   | 500 ms _(server)_           | First-partial timing (0–1000 ms). Lower = faster barge-in; higher = more confident.               |
| `vadThreshold`        | _server_                    | VAD silence-confidence (0–1). Raise in noisy environments. AssemblyAI suggests ~0.3.              |
| `continuousPartials`  | `false`                     | Emit ~3 s partials during long uninterrupted turns.                                               |
| `languageDetection`   | `false`                     | Return language metadata on Turn events. Surface via `onLanguageDetected`.                        |
| `onLanguageDetected`  | _none_                      | `(code, confidence) => void` — called when a Turn carries detected-language metadata.             |
| `baseUrl`             | `wss://streaming.assemblyai.com/v3/ws` | Full WebSocket URL override — see [AI Gateway / EU](#ai-gateway--eu-routing) below.    |

### Recommended voice-agent presets

| Profile       | `minTurnSilence` | `maxTurnSilence` | Use case                                |
| ------------- | ---------------- | ---------------- | --------------------------------------- |
| Fast          | 100              | 800              | IVR, quick confirmations, yes/no        |
| Balanced ⭐   | 100              | 1000             | General voice agents (recommended)      |
| Patient       | 200              | 2000             | Entity dictation, healthcare, long speech |

## AI Gateway / EU routing

Route the connection through Cloudflare AI Gateway by pointing `baseUrl` at your gateway endpoint:

```typescript
new AssemblyAISTT({
  apiKey: env.ASSEMBLYAI_API_KEY,
  baseUrl: `wss://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/assemblyai/v3/ws`
});
```

Use the EU host for data residency:

```typescript
new AssemblyAISTT({
  apiKey: env.ASSEMBLYAI_API_KEY,
  baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"
});
```

## Known limitations

- **No error path to the agent.** The shared `TranscriberSession` interface has no `onError` callback, so fatal failures (e.g. v3 error `1008` for auth) can only be `console.error`'d.
- **Language is set via `prompt`, not a language param.** `language_code` is silently ignored on u3-rt-pro; prepend `Transcribe Spanish.` to the prompt to guide the language. Detected-language metadata is available via `languageDetection` + `onLanguageDetected`.
- **Single model — u3-rt-pro (6 languages: en/es/de/fr/pt/it).** Use cases that need whisper-rt's broader language coverage are not served until a `model` option is added.

## How it works

1. On `start_call`, the provider opens a WebSocket to `wss://streaming.assemblyai.com/v3/ws` with the API key in the `Authorization` header.
2. The pipeline streams 16 kHz mono PCM16 in ~50 ms chunks via `feed()`; the session forwards them as binary frames.
3. AssemblyAI emits `Turn` events — `end_of_turn: false` → `onInterim`, `end_of_turn: true` → `onUtterance`. `SpeechStarted` → `onSpeechStart` for barge-in.
4. On `close()`, the session sends `{"type":"Terminate"}` and closes the socket. Billing accrues on connection-open duration, so closing promptly matters.

## Without an AssemblyAI key

If you do not have an AssemblyAI API key, use `WorkersAIFluxSTT` or `WorkersAINova3STT` from `@cloudflare/voice` — no external API key required.
```

- [ ] **Step 2: Commit.**

```bash
git add voice-providers/assemblyai/README.md
git commit -m "docs(voice-assemblyai): README"
```

---

## Task 12: Provider listing updates in the shared docs

Add the new provider to the two places existing providers are listed.

**Files:**
- Modify: `packages/voice/README.md`
- Modify: `docs/voice.md`

- [ ] **Step 1: Locate the third-party providers table in `packages/voice/README.md`.**

```bash
grep -n "Third-party providers\|voice-deepgram\|voice-elevenlabs" packages/voice/README.md
```
Expected: lines around 181–186 (`## Third-party providers` heading and a small table listing `@cloudflare/voice-deepgram` and `@cloudflare/voice-elevenlabs`).

- [ ] **Step 2: Add the AssemblyAI row.** Insert the new entry into the table directly after the `@cloudflare/voice-deepgram` row, keeping the same column shape:

```markdown
| `@cloudflare/voice-assemblyai` | Continuous STT (AssemblyAI Universal-3 Pro Streaming) |
```

- [ ] **Step 3: Locate the provider mentions in `docs/voice.md`.**

```bash
grep -n "deepgram\|elevenlabs\|voice-" docs/voice.md
```
Look for the section that mirrors `packages/voice/README.md`'s third-party providers list (or an equivalent paragraph). Add `@cloudflare/voice-assemblyai` to the same list, with a one-line description matching the table row above.

- [ ] **Step 4: Commit.**

```bash
git add packages/voice/README.md docs/voice.md
git commit -m "docs: list @cloudflare/voice-assemblyai in voice provider docs"
```

---

## Task 13: Repo-wide build + test verification, then push the branch

Run the full repo's lint, format, and the voice-package tests to confirm nothing else broke, then push the branch.

**Files:**
- None (verification + push).

- [ ] **Step 1: Run the package tests once more end-to-end.**

```bash
npm test --workspace @cloudflare/voice-assemblyai
```
Expected: all 24 tests pass.

- [ ] **Step 2: Run the build for the new package and the shared `@cloudflare/voice` package** (in case the README touched anything build-relevant).

```bash
npm run build --workspace @cloudflare/voice-assemblyai
npm run build --workspace @cloudflare/voice
```
Expected: both succeed.

- [ ] **Step 3: Run the repo's lint + format checks on the touched files.**

```bash
npx oxlint voice-providers/assemblyai packages/voice/README.md docs/voice.md
npx oxfmt --check voice-providers/assemblyai
```
Fix any findings, re-run, and `git commit -am "chore: lint/format"` if anything changed.

- [ ] **Step 4: Confirm git history is the focused series of small commits this plan produced.**

```bash
git log --oneline main..HEAD
```
Expected: ~12 commits, one per task above (give or take the lint task).

- [ ] **Step 5: Push the branch and open the PR against `cloudflare/agents:main`.**

```bash
git push -u origin assemblyai-voice-provider
gh pr create --base main --title "feat(voice): add @cloudflare/voice-assemblyai (U3 Pro Streaming STT)" --body "$(cat <<'EOF'
Adds `@cloudflare/voice-assemblyai`, a type-compliant STT provider for the
Cloudflare Agents voice pipeline. Mirrors the Deepgram/Telnyx example.

- Locked to AssemblyAI Universal-3 Pro Streaming (`u3-rt-pro`) — the voice-agent
  model (sub-300 ms time-to-final, punctuation-based turn detection, barge-in).
- Fully typed options surface; AI Gateway / EU host routing via `baseUrl`.
- Provider-specific `onLanguageDetected` callback to surface detected-language
  metadata (the shared interface's transcript callbacks are text-only).
- vitest suite covering URL/query construction, auth header, event routing,
  pre-connect buffering, graceful Terminate, and robustness.

Design spec: `docs/superpowers/specs/2026-05-27-assemblyai-voice-provider-design.md`
Implementation plan: `docs/superpowers/plans/2026-05-27-assemblyai-voice-provider.md`
EOF
)"
```

---

## Self-review against the spec

Coverage check — each spec section is implemented somewhere above:

- §1–§4 (context / goal / scope / requirements mapping) — captured in the plan header and Task 11 README.
- §5 (package shape) — Task 1.
- §6 (protocol mapping) — Tasks 4 (auth + connect), 5 (Turn), 6 (SpeechStarted + language metadata), 7 (feed), 8 (close + Terminate).
- §7 (public API and endpoint resolution) — Tasks 2 (options + URL builder) and 3 (class).
- §8 (error handling) — Task 9 (malformed messages) + the `console.error` paths added in Task 4's `#connect`. The Known Limitations note about no `onError` is documented in the README (Task 11).
- §9 (testing plan) — every bullet exercised by Tasks 2–9 (~24 tests total).
- §10 (repo integration tasks) — Tasks 11 (README) + 12 (listings) + 13 (build/lint/push). The package is `private`, so no changeset is included; if the repo's release lead decides to publish it, add a changeset in a follow-up.
- §11 (known limitations) — documented in the README (Task 11). The `language_code`-via-prompt and `onLanguageDetected` text both ship.
- §12 (open items) — by design these are not implemented; flagged for follow-up.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-assemblyai-voice-provider.md`.

Per your earlier "design doc + plan, then stop" choice, I'm not executing this in the current session. When you're ready to build, two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Say the word and pick an approach when you want to begin.
