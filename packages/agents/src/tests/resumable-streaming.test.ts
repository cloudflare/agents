import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker, { type Env } from "./worker";
import { nanoid } from "nanoid";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function makeRequest(
  agentId: string,
  method: string,
  path: string,
  body?: unknown
) {
  const ctx = createExecutionContext();
  const url = `http://example.com/agents/resumable-stream-agent/${agentId}${path}`;
  const requestInit: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : {}
  };

  if (body && method !== "GET") {
    requestInit.body = JSON.stringify(body);
  }

  const request = new Request(url, requestInit);
  return await worker.fetch(request, env, ctx);
}

async function readPartialStreamChunks(
  response: Response,
  maxChunks = 3
): Promise<{
  chunks: string[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  let count = 0;
  while (count < maxChunks) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    chunks.push(chunk);
    count++;
  }

  return { chunks, reader };
}

async function readRemainingChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string[]> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

// Helper function to read all chunks from a stream
async function readStreamChunks(response: Response): Promise<string[]> {
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  return await readRemainingChunks(reader);
}

function extractTextFromSSE(chunks: string[]): string {
  let fullText = "";
  let buffer = "";

  for (const raw of chunks) {
    buffer += raw;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep last partial line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload);
        if (data.type === "text-delta" && typeof data.delta === "string") {
          fullText += data.delta;
        }
      } catch {
        // ignore bad frames
      }
    }
  }
  return fullText;
}

describe("Resumable Streaming - Stream Resumption", () => {
  let agentId: string;

  beforeEach(async () => {
    agentId = `test-${nanoid()}`;
  });

  it("should resume a stream from interruption point", async () => {
    const customStreamId = `resume-test-${nanoid()}`;

    // Start a stream with long content
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    expect(response1.status).toBe(200);
    expect(response1.headers.get("X-Stream-Id")).toBe(customStreamId);

    // Assert SSE headers
    expect(response1.headers.get("Content-Type")).toContain(
      "text/event-stream"
    );
    expect(response1.headers.get("Cache-Control")).toContain("no-cache");

    // Read only part of the stream to simulate interruption
    const { chunks: firstChunks, reader } = await readPartialStreamChunks(
      response1,
      2
    );
    expect(firstChunks.length).toBeGreaterThan(0);
    await reader.cancel(); // Important: cancel to simulate dropped client

    // Resume the stream
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    expect(response2.status).toBe(200);
    expect(response2.headers.get("X-Stream-Id")).toBe(customStreamId);
    expect(response2.headers.get("Content-Type")).toContain(
      "text/event-stream"
    );

    // Read the resumed stream
    const secondChunks: string[] = [];
    if (response2.body) {
      const reader2 = response2.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          secondChunks.push(chunk);
        }
      } finally {
        reader2.releaseLock();
      }
    }

    const firstPartialText = extractTextFromSSE(firstChunks);
    const resumedCompleteText = extractTextFromSSE(secondChunks);

    const fullExpectedText =
      "This is a much longer response that will be streamed in multiple chunks. It contains enough text to demonstrate the chunking behavior of the resumable streaming system. The response continues with more content to ensure we have sufficient data for testing resumption scenarios.";

    expect(resumedCompleteText).toBe(fullExpectedText);

    // the resumed stream should start from the beginning, not where we left off
    expect(resumedCompleteText.startsWith(firstPartialText)).toBe(true);
    expect(fullExpectedText.startsWith(firstPartialText)).toBe(true);
  });

  it("should maintain exact chunk sequence and prevent duplicates", async () => {
    const customStreamId = `sequence-test-${nanoid()}`;

    // Start a stream
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    // Read first few chunks and track exact content
    const { chunks: firstRawChunks, reader } = await readPartialStreamChunks(
      response1,
      4
    );
    await reader.cancel();

    // Resume and read complete stream
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    const secondRawChunks = await readStreamChunks(response2);

    // Verify the first chunks appear at the start of the resumed stream
    const firstChunksText = firstRawChunks.join("");
    const secondChunksText = secondRawChunks.join("");

    // the complete stream must start with exactly what we saw before
    expect(secondChunksText.startsWith(firstChunksText)).toBe(true);

    const firstText = extractTextFromSSE(firstRawChunks);
    const completeText = extractTextFromSSE(secondRawChunks);

    expect(completeText.startsWith(firstText)).toBe(true);
    expect(completeText).toBe(
      "This is a much longer response that will be streamed in multiple chunks. It contains enough text to demonstrate the chunking behavior of the resumable streaming system. The response continues with more content to ensure we have sufficient data for testing resumption scenarios."
    );
  });

  it("should handle resumption of completed stream", async () => {
    const customStreamId = `completed-test-${nanoid()}`;

    // Start and complete a stream
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "test" }] }
      ],
      streamId: customStreamId
    });

    // Read the entire stream to completion
    if (response1.body) {
      const reader = response1.body.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    }

    // Try to resume the completed stream
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    expect(response2.status).toBe(200);

    // Should get the full content again
    const chunks: string[] = [];
    if (response2.body) {
      const reader = response2.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
    }

    const text = extractTextFromSSE(chunks);
    expect(text).toContain("This is a test response");
  });
});

describe("Resumable Streaming - Multiple Clients", () => {
  let agentId: string;

  beforeEach(async () => {
    agentId = `test-${nanoid()}`;
  });

  it("should support multiple clients connecting to same stream", async () => {
    const customStreamId = `multi-client-${nanoid()}`;

    // Client 1 starts the stream
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    expect(response1.status).toBe(200);

    // Client 2 connects to the same stream while it's active
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    expect(response2.status).toBe(200);

    // Both should receive content
    const readBoth = async () => {
      const promises = [response1, response2].map(async (response, index) => {
        const chunks: string[] = [];
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          try {
            // Read a few chunks to verify both are receiving data
            for (let i = 0; i < 3; i++) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value);
              chunks.push(chunk);
            }
          } finally {
            reader.releaseLock();
          }
        }
        return { client: index + 1, chunks };
      });

      return Promise.all(promises);
    };

    const results = await readBoth();

    // Both clients should receive data
    expect(results[0].chunks.length).toBeGreaterThan(0);
    expect(results[1].chunks.length).toBeGreaterThan(0);

    // Extract text from both clients
    const text1 = extractTextFromSSE(results[0].chunks);
    const text2 = extractTextFromSSE(results[1].chunks);

    expect(text1.length).toBeGreaterThan(0);
    expect(text2.length).toBeGreaterThan(0);
  });

  it("should ensure all chunks persist in correct sequence across multiple interruptions", async () => {
    const customStreamId = `chunk-persistence-${nanoid()}`;

    // Start a stream that will be interrupted multiple times
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    // Interrupt after reading some chunks
    const { chunks: chunk1, reader: reader1 } = await readPartialStreamChunks(
      response1,
      2
    );
    const text1 = extractTextFromSSE(chunk1);
    await reader1.cancel();

    // Wait a bit to let the stream complete in background
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Resume and read from completed stream (should have all chunks now)
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    const chunk2 = await readStreamChunks(response2);
    const text2 = extractTextFromSSE(chunk2);

    // Final resume; should get complete stream
    const response3 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    const chunk3 = await readStreamChunks(response3);
    const text3 = extractTextFromSSE(chunk3);

    const expectedComplete =
      "This is a much longer response that will be streamed in multiple chunks. It contains enough text to demonstrate the chunking behavior of the resumable streaming system. The response continues with more content to ensure we have sufficient data for testing resumption scenarios.";

    // every resume should contain the complete response from the beginning
    expect(text3).toBe(expectedComplete);
    expect(text2).toBe(expectedComplete); // Second resume was also complete

    // earlier partial reads should be proper prefixes
    expect(expectedComplete.startsWith(text1)).toBe(true);
    expect(text1.length).toBeGreaterThan(0);
    expect(text1.length).toBeLessThan(expectedComplete.length);
  });
});

describe("Resumable Streaming - Persistence and Cleanup", () => {
  let agentId: string;

  beforeEach(async () => {
    agentId = `test-${nanoid()}`;
  });

  it("should persist stream data across agent hibernation and restarts", async () => {
    const customStreamId = `persist-test-${nanoid()}`;
    const originalAgentId = `persist-test-agent-${nanoid()}`;

    // Start a stream and read partial content
    const response1 = await makeRequest(originalAgentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "test" }] }
      ],
      streamId: customStreamId
    });

    expect(response1.status).toBe(200);

    // Read partial content and track what we received
    const { chunks: firstChunks, reader } = await readPartialStreamChunks(
      response1,
      2
    );
    const firstText = extractTextFromSSE(firstChunks);
    await reader.cancel(); // Simulate client disconnect

    expect(firstText.length).toBeGreaterThan(0);

    const hibernatedResponse = await makeRequest(
      originalAgentId,
      "GET",
      `/stream/${customStreamId}`
    );
    expect(hibernatedResponse.status).toBe(200);

    // the hibernated agent should replay the stream from the beginning
    const hibernatedChunks = await readStreamChunks(hibernatedResponse);
    const hibernatedText = extractTextFromSSE(hibernatedChunks);

    // stream should contain the content we saw before AND be complete
    expect(hibernatedText).toContain(firstText);
    expect(hibernatedText).toBe(
      "This is a test response for resumable streaming."
    );

    expect(hibernatedText.startsWith(firstText)).toBe(true);
  });

  it("should clean up old streams", async () => {
    const streamId1 = `cleanup-test-1-${nanoid()}`;
    const streamId2 = `cleanup-test-2-${nanoid()}`;

    // Create multiple streams
    await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "test" }] }
      ],
      streamId: streamId1
    });

    await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg2", role: "user", parts: [{ type: "text", text: "test" }] }
      ],
      streamId: streamId2
    });

    // Clear all streams
    const clearResponse = await makeRequest(agentId, "DELETE", "/messages");
    expect(clearResponse.status).toBe(200);

    // should return 404 since clearStreams() deletes all stream records
    const status1 = await makeRequest(
      agentId,
      "GET",
      `/stream/${streamId1}/status`
    );
    const status2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${streamId2}/status`
    );

    expect(status1.status).toBe(404);
    expect(status2.status).toBe(404);

    const status1Body = await status1.json();
    const status2Body = await status2.json();
    expect(status1Body).toEqual({ error: "Stream not found" });
    expect(status2Body).toEqual({ error: "Stream not found" });
  });
});

describe("Resumable Streaming - Data Integrity", () => {
  let agentId: string;

  beforeEach(async () => {
    agentId = `test-${nanoid()}`;
  });

  it("should maintain data integrity across resumptions", async () => {
    const customStreamId = `integrity-test-${nanoid()}`;

    // Start a stream with known content
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    // Read partial content
    const { chunks: partialChunks, reader } = await readPartialStreamChunks(
      response1,
      2
    );
    reader.releaseLock();

    // Resume and read the rest
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    const fullChunks: string[] = [];

    if (response2.body) {
      const reader2 = response2.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;

          const chunk = decoder.decode(value);
          fullChunks.push(chunk);
        }
      } finally {
        reader2.releaseLock();
      }
    }

    // Start a fresh stream to get the complete content
    const response3 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg2", role: "user", parts: [{ type: "text", text: "long" }] }
      ]
    });

    const completeChunks: string[] = [];
    if (response3.body) {
      const reader3 = response3.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader3.read();
          if (done) break;

          const chunk = decoder.decode(value);
          completeChunks.push(chunk);
        }
      } finally {
        reader3.releaseLock();
      }
    }

    // Extract text from all scenarios
    const partialText = extractTextFromSSE(partialChunks);
    const resumedFullText = extractTextFromSSE(fullChunks);
    const completeText = extractTextFromSSE(completeChunks);

    // The resumed stream should contain the original content
    expect(resumedFullText).toContain("This is a much longer response");
    expect(completeText).toContain("This is a much longer response");

    expect(partialText.length).toBeGreaterThan(0);
    expect(resumedFullText.length).toBeGreaterThan(0);
  });

  it("should handle concurrent stream access safely", async () => {
    const customStreamId = `concurrent-test-${nanoid()}`;

    // Start multiple concurrent requests to the same stream
    const promises = Array.from({ length: 3 }, (_, index) =>
      makeRequest(agentId, "POST", "/chat", {
        messages: [
          {
            id: `msg${index}`,
            role: "user",
            parts: [{ type: "text", text: "test" }]
          }
        ],
        streamId: customStreamId
      })
    );

    const responses = await Promise.all(promises);

    // All should succeed
    responses.forEach((response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Stream-Id")).toBe(customStreamId);
    });

    // Read content from all responses
    const contentPromises = responses.map(async (response) => {
      const chunks: string[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
      }
      return extractTextFromSSE(chunks);
    });

    const contents = await Promise.all(contentPromises);

    // All should receive content
    contents.forEach((content) => {
      expect(content.length).toBeGreaterThan(0);
    });
  });
});

describe("Resumable Streaming - Cancellation", () => {
  let agentId: string;

  beforeEach(async () => {
    agentId = `test-${nanoid()}`;
  });

  it("should cancel an active stream, mark it completed, and stop further output", async () => {
    const customStreamId = `cancel-test-${nanoid()}`;

    // Start a long stream
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    expect(response1.status).toBe(200);
    expect(response1.headers.get("X-Stream-Id")).toBe(customStreamId);

    // Read a few chunks to accumulate partial text
    const { chunks: partialChunks, reader } = await readPartialStreamChunks(
      response1,
      2
    );
    const partialText = extractTextFromSSE(partialChunks);
    expect(partialText.length).toBeGreaterThan(0);

    // Cancel the stream
    const cancelResp = await makeRequest(
      agentId,
      "POST",
      `/stream/${customStreamId}/cancel`
    );
    expect(cancelResp.status).toBe(200);

    // Ensure original reader is canceled/closed
    try {
      await reader.cancel();
    } catch {}

    // Status should show completed
    const statusResp = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}/status`
    );
    expect(statusResp.status).toBe(200);
    const status = (await statusResp.json()) as { completed: boolean };
    expect(status.completed).toBe(true);

    // Resuming should immediately complete and return only persisted partial deltas
    const resumeResp = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    expect(resumeResp.status).toBe(200);
    expect(resumeResp.headers.get("X-Stream-Complete")).toBe("true");

    const resumedChunks = await readStreamChunks(resumeResp);
    const resumedText = extractTextFromSSE(resumedChunks);
    // After cancellation, no more output should be streamed; however,
    // persisted deltas might slightly exceed what this client read before cancel.
    // Ensure at least the previously seen partial text is included and no streaming continues beyond persisted data.
    expect(resumedText.startsWith(partialText)).toBe(true);
  });
});

describe("Resumable Streaming - Error Handling and Edge Cases", () => {
  let agentId: string;

  beforeEach(async () => {
    agentId = `test-${nanoid()}`;
  });

  it("should return 404 for unknown stream ids", async () => {
    const response = await makeRequest(
      agentId,
      "GET",
      `/stream/nonexistent-${nanoid()}`
    );
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  it("should handle request timeout with AbortController", async () => {
    const customStreamId = `timeout-test-${nanoid()}`;
    const controller = new AbortController();

    const ctx = createExecutionContext();
    const url = `http://example.com/agents/resumable-stream-agent/${agentId}/chat`;
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
        ],
        streamId: customStreamId
      }),
      signal: controller.signal
    });

    const p = worker.fetch(request, env, ctx);
    setTimeout(() => controller.abort(), 10);

    await expect(p).resolves.toBeDefined();
  });

  it("should validate exact text ordering in deterministic streams", async () => {
    const customStreamId = `ordering-test-${nanoid()}`;

    const response = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "test" }] }
      ],
      streamId: customStreamId
    });

    const chunks: string[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
    }

    const fullText = extractTextFromSSE(chunks);
    expect(fullText).toBe("This is a test response for resumable streaming.");
  });

  it("should provide consistent content when resuming interrupted streams", async () => {
    const customStreamId = `dedup-test-${nanoid()}`;

    // Start stream and read partial content
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    const { chunks: firstChunks, reader } = await readPartialStreamChunks(
      response1,
      3
    );
    const firstText = extractTextFromSSE(firstChunks);
    await reader.cancel();

    // Resume the stream
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );

    const secondChunks: string[] = [];
    if (response2.body) {
      const reader2 = response2.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          secondChunks.push(chunk);
        }
      } finally {
        reader2.releaseLock();
      }
    }

    const secondText = extractTextFromSSE(secondChunks);

    // Verify both streams provide content and the resumed stream contains the expected response
    expect(firstText.length).toBeGreaterThan(0);
    expect(secondText.length).toBeGreaterThan(0);
    expect(secondText).toContain("This is a much longer response");
  });

  it("should handle partial SSE frames and reconstruct JSON correctly", async () => {
    const customStreamId = `partial-sse-${nanoid()}`;

    // Start a stream
    const response1 = await makeRequest(agentId, "POST", "/chat", {
      messages: [
        { id: "msg1", role: "user", parts: [{ type: "text", text: "long" }] }
      ],
      streamId: customStreamId
    });

    expect(response1.status).toBe(200);

    // Read raw chunks until we find one that ends with a partial JSON line
    const rawChunks: string[] = [];
    let foundPartialJSON = false;

    if (response1.body) {
      const reader = response1.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (!foundPartialJSON) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          rawChunks.push(chunk);
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: {") && !line.includes("}")) {
              foundPartialJSON = true;
              break;
            }
          }

          if (rawChunks.length > 10) break;
        }
        await reader.cancel();
      } catch (_error) {
        // Expected when canceling
      }
    }

    // Extract what we got from the interrupted stream
    const partialText = extractTextFromSSE(rawChunks);
    expect(partialText.length).toBeGreaterThan(0);

    // Resume the stream - this should handle the partial JSON correctly
    const response2 = await makeRequest(
      agentId,
      "GET",
      `/stream/${customStreamId}`
    );
    expect(response2.status).toBe(200);

    // Read the complete resumed stream
    const resumedChunks = await readStreamChunks(response2);
    const completeText = extractTextFromSSE(resumedChunks);

    const expectedCompleteText =
      "This is a much longer response that will be streamed in multiple chunks. It contains enough text to demonstrate the chunking behavior of the resumable streaming system. The response continues with more content to ensure we have sufficient data for testing resumption scenarios.";

    expect(completeText).toBe(expectedCompleteText);

    expect(expectedCompleteText.startsWith(partialText)).toBe(true);

    expect(completeText.length).toBeGreaterThan(partialText.length);
  });

  it("should handle concurrent POST requests to same streamId", async () => {
    const customStreamId = `concurrent-post-${nanoid()}`;

    // Start multiple concurrent POST requests to the same stream ID
    const promises = Array.from({ length: 3 }, (_, index) =>
      makeRequest(agentId, "POST", "/chat", {
        messages: [
          {
            id: `msg${index}`,
            role: "user",
            parts: [{ type: "text", text: "test" }]
          }
        ],
        streamId: customStreamId
      })
    );

    const responses = await Promise.all(promises);
    const successCount = responses.filter((r) => r.status === 200).length;
    expect(successCount).toBeGreaterThan(0);

    // All responses should have the same stream ID
    responses.forEach((response) => {
      if (response.status === 200) {
        expect(response.headers.get("X-Stream-Id")).toBe(customStreamId);
      }
    });
  });
});
