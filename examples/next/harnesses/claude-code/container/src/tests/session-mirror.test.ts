/**
 * The transcript mirror on its own: no SDK, no socket, no subprocess.
 *
 * The assertions are the two halves of the contract the container depends
 * on. Forward: a batch reaches the wire whole, in order, in frames small
 * enough to travel. Backward: what the Durable Object replays, plus what
 * this process has appended since, is what the SDK gets back on resume.
 */
import { describe, expect, it } from "vitest";
import {
  InMemorySessionStore,
  type SessionStore
} from "@anthropic-ai/claude-agent-sdk";
import {
  HarnessSessionStore,
  MAX_ENGINE_LOG_BYTES,
  type EngineLogFrame,
  type MirrorEntry
} from "../engines/session-mirror.ts";

const PROJECT = "-workspace";
const SESSION = "sess-1";

/** A store plus the frames it emitted, in emission order. */
function store(activeOperationId: string | null = null): {
  readonly mirror: HarnessSessionStore;
  readonly frames: {
    readonly operationId: string | null;
    readonly frame: EngineLogFrame;
  }[];
} {
  const frames: {
    readonly operationId: string | null;
    readonly frame: EngineLogFrame;
  }[] = [];
  const mirror = new HarnessSessionStore({
    emit: (operationId, frame) => frames.push({ operationId, frame }),
    activeOperationId: () => activeOperationId
  });
  return { mirror, frames };
}

function entry(uuid: string, text = "x"): MirrorEntry {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-09-14T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] }
  };
}

describe("HarnessSessionStore", () => {
  it("is a SessionStore as the SDK declares it", () => {
    // Type-level: the query options take this object verbatim.
    const mirror: SessionStore = store().mirror;
    expect(typeof mirror.append).toBe("function");
    expect(typeof mirror.load).toBe("function");
  });

  it("splits a large batch into frames that fit the wire", async () => {
    const { mirror, frames } = store("op-1");
    // ~300 KiB in ~1 KiB entries, which is several frames' worth.
    const entries = Array.from({ length: 300 }, (_, index) =>
      entry(`uuid-${index}`, "y".repeat(1000))
    );
    await mirror.append({ projectKey: PROJECT, sessionId: SESSION }, entries);

    expect(frames.length).toBeGreaterThan(3);
    for (const { operationId, frame } of frames) {
      expect(operationId).toBe("op-1");
      expect(frame.engineSessionId).toBe(SESSION);
      expect(frame.subpath).toBeNull();
      expect(frame.entries.length).toBeGreaterThan(0);
      const bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
      expect(bytes).toBeLessThan(MAX_ENGINE_LOG_BYTES);
    }
    // Every entry travels exactly once, in order.
    expect(frames.flatMap(({ frame }) => [...frame.entries])).toEqual(entries);
  });

  it("keeps an oversized entry whole in a frame of its own", async () => {
    const { mirror, frames } = store();
    const huge = entry("uuid-huge", "z".repeat(MAX_ENGINE_LOG_BYTES * 2));
    await mirror.append({ projectKey: PROJECT, sessionId: SESSION }, [
      entry("uuid-small"),
      huge
    ]);
    expect(frames.length).toBe(2);
    expect(frames[1]?.frame.entries).toEqual([huge]);
  });

  it("returns the restored transcript, then what it appended", async () => {
    const { mirror } = store();
    const key = { projectKey: PROJECT, sessionId: SESSION };
    const restored = [entry("a"), entry("b")];
    mirror.restore({
      engineSessionId: SESSION,
      subpath: null,
      entries: restored,
      chunk: 0,
      chunks: 1
    });
    const appended = [entry("c")];
    await mirror.append(key, appended);
    expect(await mirror.load(key)).toEqual([...restored, ...appended]);
  });

  it("reassembles restore chunks by index, out of order", async () => {
    const { mirror } = store();
    const key = { projectKey: PROJECT, sessionId: SESSION };
    const first = [entry("a")];
    const second = [entry("b")];
    mirror.restore({
      engineSessionId: SESSION,
      subpath: null,
      entries: second,
      chunk: 1,
      chunks: 2
    });
    expect(mirror.isComplete(SESSION)).toBe(false);
    mirror.restore({
      engineSessionId: SESSION,
      subpath: null,
      entries: first,
      chunk: 0,
      chunks: 2
    });
    expect(mirror.isComplete(SESSION)).toBe(true);
    expect(await mirror.load(key)).toEqual([...first, ...second]);
  });

  it("ignores a chunk it already holds", async () => {
    const { mirror } = store();
    const key = { projectKey: PROJECT, sessionId: SESSION };
    const chunk = {
      engineSessionId: SESSION,
      subpath: null,
      entries: [entry("a"), entry("b")],
      chunk: 0,
      chunks: 1
    } as const;
    mirror.restore(chunk);
    mirror.restore(chunk);
    expect(await mirror.load(key)).toEqual([...chunk.entries]);
  });

  it("dedupes by uuid and keeps entries without one", async () => {
    const { mirror } = store();
    const key = { projectKey: PROJECT, sessionId: SESSION };
    const summary: MirrorEntry = { type: "summary", summary: "so far" };
    mirror.restore({
      engineSessionId: SESSION,
      subpath: null,
      entries: [entry("a"), summary],
      chunk: 0,
      chunks: 1
    });
    // The SDK retried a batch that had already landed.
    await mirror.append(key, [entry("a"), summary, entry("b")]);
    expect(await mirror.load(key)).toEqual([
      entry("a"),
      summary,
      summary,
      entry("b")
    ]);
  });

  it("knows nothing about a key it was never given", async () => {
    const { mirror } = store();
    expect(
      await mirror.load({ projectKey: PROJECT, sessionId: "other" })
    ).toBeNull();
  });

  it("lists the subagent transcripts of one session", async () => {
    const { mirror } = store();
    await mirror.append(
      { projectKey: PROJECT, sessionId: SESSION, subpath: "subagents/agent-1" },
      [entry("a")]
    );
    mirror.restore({
      engineSessionId: SESSION,
      subpath: "subagents/agent-2",
      entries: [entry("b")],
      chunk: 0,
      chunks: 1
    });
    await mirror.append({ projectKey: PROJECT, sessionId: SESSION }, [
      entry("c")
    ]);
    await mirror.append({ projectKey: PROJECT, sessionId: "other" }, [
      entry("d")
    ]);
    const subkeys = await mirror.listSubkeys({
      projectKey: PROJECT,
      sessionId: SESSION
    });
    expect([...subkeys].sort()).toEqual([
      "subagents/agent-1",
      "subagents/agent-2"
    ]);
  });

  it("round-trips a batch the way the SDK's own store does", async () => {
    const key = { projectKey: PROJECT, sessionId: SESSION };
    const entries = [entry("a"), entry("b"), { type: "title", title: "hi" }];
    const reference = new InMemorySessionStore();
    await reference.append(key, [...entries]);
    const { mirror } = store();
    await mirror.append(key, entries);
    expect(await mirror.load(key)).toEqual(await reference.load(key));
  });
});
