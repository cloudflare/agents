import { describe, expect, it } from "vitest";
import { CloudflareAIError } from "../../../models/core/errors";
import { resumableBody } from "../../../models/core/resume";
import { createTransport } from "../../../models/core/transport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One SSE event, as `/run` sends it. */
const event = (data: string) => `data: ${data}\n\n`;

const EVENTS = ["one", "two", "three", "four", "five"].map((word) =>
  event(JSON.stringify({ word }))
);

/**
 * A body that hands out `chunks` one read at a time, then fails as a dropped
 * connection does. Pull-based, because erroring a stream discards whatever is
 * still queued in it.
 */
function droppingBody(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.error(new TypeError("Network connection lost."));
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    }
  });
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

describe("resumableBody", () => {
  it("resumes from the last complete event after a drop, with no byte lost or repeated", async () => {
    const froms: number[] = [];
    const stream = resumableBody({
      // Two whole events and half of the third, then the connection drops.
      initial: droppingBody([
        EVENTS[0] ?? "",
        EVENTS[1] ?? "",
        (EVENTS[2] ?? "").slice(0, 7)
      ]),
      model: "anthropic/claude-haiku-4.5",
      async resume(from) {
        froms.push(from);
        return new Response(bodyOf(EVENTS.slice(from).join("")), {
          status: 200
        });
      },
      url: "test"
    });

    expect(await readAll(stream)).toBe(EVENTS.join(""));
    expect(froms).toEqual([2]);
  });

  it("resumes more than once, counting from the start of the run each time", async () => {
    const froms: number[] = [];
    const stream = resumableBody({
      initial: droppingBody([EVENTS[0] ?? ""]),
      model: "m",
      async resume(from) {
        froms.push(from);
        // The first replay drops again after one more event.
        return from === 1
          ? new Response(droppingBody([EVENTS[1] ?? ""]))
          : new Response(bodyOf(EVENTS.slice(from).join("")));
      },
      url: "test"
    });

    expect(await readAll(stream)).toBe(EVENTS.join(""));
    expect(froms).toEqual([1, 2]);
  });

  it("errors with CloudflareAIError once the gateway no longer holds the run", async () => {
    const stream = resumableBody({
      initial: droppingBody([EVENTS[0] ?? ""]),
      model: "m",
      resume: async () =>
        new Response(JSON.stringify({ error: "Request not found" }), {
          status: 404
        }),
      url: "test"
    });

    const caught = await readAll(stream).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(caught).toBeInstanceOf(CloudflareAIError);
    expect((caught as CloudflareAIError).status).toBe(404);
    expect((caught as CloudflareAIError).message).toMatch(
      /no longer holds the run/
    );
  });

  it("gives up after maxReconnects drops", async () => {
    let calls = 0;
    const stream = resumableBody({
      initial: droppingBody([]),
      maxReconnects: 2,
      model: "m",
      async resume() {
        calls++;
        return new Response(droppingBody([]));
      },
      url: "test"
    });

    await expect(readAll(stream)).rejects.toThrow(/giving up/);
    expect(calls).toBe(2);
  });

  it("never reconnects after the caller aborts, and passes the abort on", async () => {
    const controller = new AbortController();
    let calls = 0;
    let pulls = 0;
    const initial = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) {
          stream.enqueue(encoder.encode(EVENTS[0] ?? ""));
          return;
        }
        controller.abort();
        stream.error(
          new DOMException("The operation was aborted.", "AbortError")
        );
      }
    });
    const stream = resumableBody({
      initial,
      model: "m",
      async resume() {
        calls++;
        return new Response(bodyOf(""));
      },
      signal: controller.signal,
      url: "test"
    });

    await expect(readAll(stream)).rejects.toThrow(/aborted/);
    expect(calls).toBe(0);
  });
});

describe("transport: resumable run-path streams", () => {
  /** A binding whose stream drops, and whose `fetch` serves the resume route. */
  function droppingBinding(headers: Record<string, string>) {
    const fetched: string[] = [];
    const binding = {
      aiGatewayLogId: null,
      async fetch(url: string) {
        fetched.push(url);
        const from = Number(new URL(url).searchParams.get("from"));
        return new Response(bodyOf(EVENTS.slice(from).join("")));
      },
      async run() {
        return new Response(droppingBody([EVENTS[0] ?? "", EVENTS[1] ?? ""]), {
          headers: { "content-type": "text/event-stream", ...headers }
        });
      }
    };
    return { binding: binding as unknown as Ai, fetched };
  }

  it("resumes a stream that names its run, through the binding's resume route", async () => {
    const { binding, fetched } = droppingBinding({
      "cf-aig-run-id": "run-123"
    });
    const response = await createTransport({ binding }).run({
      gateway: { id: "prod" },
      headers: {},
      input: { stream: true },
      model: "anthropic/claude-haiku-4.5"
    });

    expect(response.headers.get("cf-aig-run-id")).toBe("run-123");
    expect(await readAll(response.body as ReadableStream<Uint8Array>)).toBe(
      EVENTS.join("")
    );
    expect(fetched).toEqual([
      "https://workers-binding.ai/ai-gateway/gateways/prod/run/run-123/resume?from=2"
    ]);
  });

  it("leaves a stream with no run id as it is", async () => {
    const { binding, fetched } = droppingBinding({});
    const response = await createTransport({ binding }).run({
      gateway: { id: "prod" },
      headers: {},
      input: { stream: true },
      model: "@cf/zai-org/glm-4.7-flash"
    });

    await expect(
      readAll(response.body as ReadableStream<Uint8Array>)
    ).rejects.toThrow(/Network connection lost/);
    expect(fetched).toHaveLength(0);
  });
});
