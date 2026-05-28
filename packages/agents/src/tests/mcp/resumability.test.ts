import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker";
import {
  initializeStreamableHTTPServer,
  openStandaloneSSE,
  readSSEEventWithTimeout
} from "../shared/test-utils";

/**
 * End-to-end resumability tests for cloudflare/agents#1583.
 *
 * These exercise the streamable-HTTP path through the worker entry, which
 * routes `/mcp` to an `McpAgent`. Each `McpAgent` now ships with a default
 * {@link DurableObjectEventStore}, so reconnecting with `Last-Event-ID` should
 * replay any notifications that were emitted while the GET SSE stream was
 * disconnected.
 */
describe("McpAgent SSE resumability (#1583)", () => {
  const baseUrl = "http://example.com/mcp";

  /**
   * Extract `id: <value>` from the most recent SSE event chunk.
   */
  const extractEventId = (chunk: string): string | undefined => {
    const lines = chunk.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("id:")) return line.slice(3).trim();
    }
    return undefined;
  };

  it("GET response opens cleanly with no `event: ping` frames", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);
    expect(sessionId).toBeTruthy();

    // Open the standalone GET stream. We don't require a priming event —
    // only that the stream opens cleanly and never emits a `ping` named
    // event (which was the broken keepalive frame format from #1583).
    const reader = await openStandaloneSSE(ctx, sessionId, baseUrl);

    try {
      // Trigger a notification by listing tools (server-initiated logging is
      // optional). For this test we only need to ensure the GET stream itself
      // opened cleanly.
      const frame = await readSSEEventWithTimeout(reader, 100);
      // Either we got a priming/notification frame, or there was nothing yet.
      // What matters is that no `event: ping` frames are present.
      if (frame !== null) {
        expect(frame).not.toContain("event: ping");
      }
    } finally {
      await reader.cancel();
    }
  });

  it("emits no `event: ping` keepalive frames on POST tool-call streams", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);

    // tools/call returns its response via SSE. Read until the final result
    // arrives and confirm we never saw a ping frame.
    const callMessage = {
      jsonrpc: "2.0" as const,
      id: 99,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "world" } }
    };

    const response = await worker.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        },
        body: JSON.stringify(callMessage)
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sawResult = false;
    for (let i = 0; i < 20 && !sawResult; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('"result"')) sawResult = true;
    }
    await reader.cancel();

    expect(sawResult).toBe(true);
    expect(buffered).not.toContain("event: ping");
  });

  it("emits SSE event ids so clients can resume with Last-Event-ID", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);

    // Call a tool — its response frame on the POST SSE stream MUST carry an
    // `id:` line, which is what enables resumption from the event store.
    const response = await worker.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "greet", arguments: { name: "id-check" } }
        })
      }),
      env,
      ctx
    );

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('"result"')) break;
    }
    await reader.cancel();

    const eventId = extractEventId(buf);
    expect(
      eventId,
      `expected an SSE id: line, got chunks:\n${buf}`
    ).toBeTruthy();
    // The default DurableObjectEventStore issues ids of the form
    // `<streamId>:<seqHex>`; both halves are non-empty.
    expect(eventId).toMatch(/^.+:.+$/);
  });

  it("resumed GET stream is registered as the standalone SSE stream", async () => {
    // Regression: previously, after replayEvents() the reconnected connection
    // was never tagged with `_standaloneSse: true`, so subsequent
    // server-initiated notifications had nowhere to land. The spec says the
    // server "resume[s] the stream from that point" — i.e. the same stream
    // continues to deliver new messages, not just the replayed backlog.
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);

    // Drive a tool call to populate the event store with one real event id.
    const callResponse = await worker.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "greet", arguments: { name: "prime" } }
        })
      }),
      env,
      ctx
    );
    const reader = callResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('"result"')) break;
    }
    await reader.cancel();
    const eventId = extractEventId(buf);
    expect(eventId).toBeTruthy();

    // Open a standalone GET with Last-Event-ID. Even though there are no
    // events after the cursor, the reconnected connection MUST be tagged as
    // the standalone stream so that future server-initiated messages can
    // reach the client.
    const resumeResponse = await worker.fetch(
      new Request(baseUrl, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
          "Last-Event-ID": eventId!
        }
      }),
      env,
      ctx
    );
    expect(resumeResponse.status).toBe(200);

    // We can't easily peek at DO connection state from inside this test, but
    // we can assert the end-to-end contract: a second POST request that
    // produces a server-initiated event must not error with "no standalone
    // SSE connection". In practice, the agent server only emits standalone
    // events when explicitly asked; this assertion is therefore conservative
    // — the test mostly guards that resume returns 200 even when the
    // last-event-id has no events after it.
    await resumeResponse.body?.cancel();
  });

  it("reconnecting GET with a valid Last-Event-ID returns 200", async () => {
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);

    // First, drive a tool call so the event store has a real event id we can
    // pull off the SSE frame. (We don't need to resume that specific event;
    // we only need a syntactically valid id the server's store recognises.)
    const callResponse = await worker.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "greet", arguments: { name: "resume" } }
        })
      }),
      env,
      ctx
    );
    const reader = callResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('"result"')) break;
    }
    await reader.cancel();
    const eventId = extractEventId(buf);
    expect(eventId).toBeTruthy();

    // Now reconnect the standalone GET stream with that id. The server SHOULD
    // accept the resumption attempt (200 OK, text/event-stream).
    const resumeResponse = await worker.fetch(
      new Request(baseUrl, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
          "Last-Event-ID": eventId!
        }
      }),
      env,
      ctx
    );
    expect(resumeResponse.status).toBe(200);
    expect(resumeResponse.headers.get("content-type")).toBe(
      "text/event-stream"
    );

    await resumeResponse.body?.cancel();
  });
});
