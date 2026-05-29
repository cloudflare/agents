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

  it("mid-flight POST disconnect: resumed GET receives the final tool result", async () => {
    // The actual failure mode #1583 was opened to address: a client
    // starts a tool call over POST, the SSE pipe drops while the tool
    // is still running, and the client reconnects with Last-Event-ID
    // to receive the eventual result. The `deferredGreet` test tool
    // emits a progress notification immediately, then sleeps before
    // returning — giving us a real event id on the POST stream that
    // we can cancel from and then resume.
    const ctx = createExecutionContext();
    const sessionId = await initializeStreamableHTTPServer(ctx, baseUrl);

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
          id: 77,
          method: "tools/call",
          params: {
            name: "deferredGreet",
            arguments: { name: "midflight", delayMs: 600 }
          }
        })
      }),
      env,
      ctx
    );
    expect(callResponse.status).toBe(200);

    // Read the POST stream just until the progress notification
    // arrives — that gives us an event id while the tool is still
    // running. Crucially, we do NOT wait for the final result.
    const reader = callResponse.body!.getReader();
    const decoder = new TextDecoder();
    let postBuf = "";
    for (let i = 0; i < 20; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      postBuf += decoder.decode(value, { stream: true });
      if (postBuf.includes("notifications/progress")) break;
    }
    expect(postBuf).toContain("notifications/progress");
    const progressEventId = extractEventId(postBuf);
    expect(
      progressEventId,
      `expected an SSE id on the progress notification, got:\n${postBuf}`
    ).toBeTruthy();

    // Guard against a timing regression: if the test runner ran slow
    // enough that the tool already completed, the resumed GET would
    // have nothing to deliver live and the test would be a false pass.
    // We want this to fail loudly instead.
    expect(
      postBuf,
      "tool completed before mid-flight cancel — raise delayMs"
    ).not.toContain('"result"');

    // Simulate the client losing the POST SSE stream.
    await reader.cancel();

    // Reconnect with GET + Last-Event-ID set to the progress event.
    // The server must (a) treat this as a POST resume rather than a
    // fresh standalone, and (b) deliver the final tool result on this
    // new connection once the tool handler returns.
    const resumeResponse = await worker.fetch(
      new Request(baseUrl, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
          "Last-Event-ID": progressEventId!
        }
      }),
      env,
      ctx
    );
    expect(resumeResponse.status).toBe(200);

    const resumeReader = resumeResponse.body!.getReader();
    let resumeBuf = "";
    // Bound the loop so the test can't hang. The tool sleeps for
    // 600ms and then writes one result frame.
    for (let i = 0; i < 40; i++) {
      const { value, done } = await resumeReader.read();
      if (done) break;
      resumeBuf += decoder.decode(value, { stream: true });
      if (resumeBuf.includes('"result"')) break;
    }
    await resumeReader.cancel();

    expect(
      resumeBuf,
      `expected the resumed GET to receive the tool result, got:\n${resumeBuf}`
    ).toContain('"result"');
    expect(resumeBuf).toContain("Hello, midflight!");
    // The Last-Event-ID was the progress notification itself, so
    // `replayEventsAfter` must skip it — the client already saw it on
    // the original POST stream and re-delivering it would be a bug.
    expect(resumeBuf).not.toContain("notifications/progress");
  });
});
