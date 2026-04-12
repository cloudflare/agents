/**
 * Unit tests for AudioConnectionManager — transcriber session lifecycle.
 */
import { describe, expect, it } from "vitest";
import { AudioConnectionManager } from "../audio-pipeline";
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "../types";

// --- Helpers ---

function makeAudio(bytes: number): ArrayBuffer {
  const buf = new ArrayBuffer(bytes);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bytes; i++) view[i] = i & 0xff;
  return buf;
}

class SpySession implements TranscriberSession {
  fed: ArrayBuffer[] = [];
  closed = false;

  feed(chunk: ArrayBuffer): void {
    this.fed.push(chunk);
  }

  close(): void {
    this.closed = true;
  }
}

class SpyTranscriber implements Transcriber {
  lastSession: SpySession | null = null;

  createSession(_options?: TranscriberSessionOptions): TranscriberSession {
    this.lastSession = new SpySession();
    return this.lastSession;
  }
}

// --- Transcriber session lifecycle ---

describe("AudioConnectionManager — transcriber sessions", () => {
  it("creates a transcriber session at start", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");

    cm.startTranscriberSession("c1", transcriber, {});

    expect(cm.hasTranscriberSession("c1")).toBe(true);
    expect(transcriber.lastSession).not.toBeNull();
  });

  it("feeds audio to the transcriber session via bufferAudio", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");
    cm.startTranscriberSession("c1", transcriber, {});

    cm.bufferAudio("c1", makeAudio(1000));
    cm.bufferAudio("c1", makeAudio(2000));

    const session = transcriber.lastSession!;
    expect(session.fed).toHaveLength(2);
    expect(session.fed[0].byteLength).toBe(1000);
    expect(session.fed[1].byteLength).toBe(2000);
  });

  it("closes the transcriber session on closeTranscriberSession", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");
    cm.startTranscriberSession("c1", transcriber, {});

    cm.closeTranscriberSession("c1");

    expect(transcriber.lastSession!.closed).toBe(true);
    expect(cm.hasTranscriberSession("c1")).toBe(false);
  });

  it("closes the transcriber session on cleanup", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");
    cm.startTranscriberSession("c1", transcriber, {});

    cm.cleanup("c1");

    expect(transcriber.lastSession!.closed).toBe(true);
    expect(cm.hasTranscriberSession("c1")).toBe(false);
  });

  it("replaces existing session when starting a new one", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");

    cm.startTranscriberSession("c1", transcriber, {});
    const first = transcriber.lastSession!;

    cm.startTranscriberSession("c1", transcriber, {});
    const second = transcriber.lastSession!;

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(first).not.toBe(second);
  });

  it("does not feed audio when no session is active", () => {
    const cm = new AudioConnectionManager("test");
    cm.initConnection("c1");

    cm.bufferAudio("c1", makeAudio(1000));
    // No crash, audio just buffered
  });

  it("session survives abortPipeline (interrupt does not close session)", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");
    cm.startTranscriberSession("c1", transcriber, {});

    cm.abortPipeline("c1");

    expect(transcriber.lastSession!.closed).toBe(false);
    expect(cm.hasTranscriberSession("c1")).toBe(true);
  });

  it("continues feeding after pipeline abort", () => {
    const cm = new AudioConnectionManager("test");
    const transcriber = new SpyTranscriber();
    cm.initConnection("c1");
    cm.startTranscriberSession("c1", transcriber, {});

    cm.bufferAudio("c1", makeAudio(1000));
    cm.abortPipeline("c1");
    cm.bufferAudio("c1", makeAudio(2000));

    const session = transcriber.lastSession!;
    expect(session.fed).toHaveLength(2);
  });
});
