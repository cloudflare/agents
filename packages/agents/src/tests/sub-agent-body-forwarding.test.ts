/**
 * Request-body forwarding across a parent↔facet boundary (issue #2015).
 *
 * `Agent._cf_forwardToFacet` and `routeSubAgentRequest` both used to
 * do `forwardInit.body = await req.arrayBuffer()` before dispatching to
 * the child. That read is unbounded and runs in the *parent* Durable
 * Object, in front of any application-level intake limit — an app that
 * carefully bounds bodies in `onRequest` still had an unbounded read
 * ahead of it. Nesting compounds it: every `/sub/` hop re-materialised
 * the same bytes.
 *
 * The tests below pin the observable consequence rather than the
 * implementation: whether the child can act on a request before the
 * client has finished uploading it.
 *
 *   - `respondsBeforeUploadCompletes` — the child replies while the
 *     request body is still open. Buffering makes this deadlock.
 *   - `first-chunk` — the child reads a prefix of a still-open body.
 *     This is the decisive one: it distinguishes real incremental
 *     streaming from "the runtime buffered internally but dispatched
 *     early".
 *   - integrity — a multi-megabyte body still arrives byte-exact, over
 *     one hop and over two nested hops.
 *
 * A canonical (non-facet) control runs first. If the test harness
 * itself can't stream a request body, every facet assertion below
 * would hang for reasons unrelated to the forwarder, so the control
 * tells us how to read a failure.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

function uniqueName() {
  return `body-fwd-${Math.random().toString(36).slice(2)}`;
}

/**
 * A request body that delivers `firstChunk` immediately and then stays
 * open until `release()` is called.
 *
 * `controller.enqueue` queues the chunk synchronously, so a reader can
 * consume it while `start` is still pending — that's what lets a probe
 * observe a prefix of an unfinished upload.
 */
function pendingBody(firstChunk: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
      await gate;
      controller.close();
    }
  });

  return {
    release: () => {
      released = true;
      release();
    },
    get released() {
      return released;
    },
    stream
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type RaceOutcome =
  | { kind: "settled"; res: Response }
  | { kind: "error"; err: unknown }
  | { kind: "pending" };

/**
 * Resolve as soon as the request settles, or report `pending` after
 * `ms`. Rejections are captured rather than thrown so a runtime that
 * refuses stream bodies outright produces a readable message instead of
 * an anonymous timeout.
 */
async function raceSettle(
  promise: Promise<Response>,
  ms: number
): Promise<RaceOutcome> {
  return Promise.race<RaceOutcome>([
    promise.then(
      (res) => ({ kind: "settled" as const, res }),
      (err) => ({ err, kind: "error" as const })
    ),
    sleep(ms).then(() => ({ kind: "pending" as const }))
  ]);
}

function describeOutcome(outcome: RaceOutcome): string {
  if (outcome.kind === "error") {
    const err = outcome.err;
    return `request rejected: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (outcome.kind === "pending") {
    return "request never settled while the body was still open (the parent is buffering the whole body before dispatching)";
  }
  return `settled with ${outcome.res.status}`;
}

/**
 * Send a still-open body at `url` and assert the response comes back
 * before the upload finishes. Returns the parsed JSON so callers can
 * make further assertions.
 */
async function expectResponseBeforeUploadCompletes(
  url: string,
  { chunk = "prefix-payload", timeoutMs = 2500 } = {}
): Promise<Record<string, unknown>> {
  const body = pendingBody(chunk);
  const inFlight = exports.default.fetch(
    new Request(url, { body: body.stream, method: "POST" })
  );

  try {
    const outcome = await raceSettle(inFlight, timeoutMs);
    expect(outcome.kind, describeOutcome(outcome)).toBe("settled");
    // Narrowed by the assertion above.
    const res = (outcome as { res: Response }).res;
    expect(res.status).toBe(200);
    // The upload is still open at this point — that's the whole point.
    expect(body.released).toBe(false);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    // Always unblock, otherwise a failing assertion leaves the stream
    // (and the worker request) hanging into teardown.
    body.release();
    await inFlight.catch(() => {});
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic, non-uniform payload so truncation or reordering shows up. */
function payload(bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes));
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

// ── Control: does the harness stream at all? ─────────────────────────

describe("body forwarding — canonical control path", () => {
  it("streams a request body to a root Agent (no facet involved)", async () => {
    // If this fails, the test harness — not the forwarder — is
    // buffering, and the facet assertions below can't be interpreted.
    const name = uniqueName();
    const json = await expectResponseBeforeUploadCompletes(
      `http://x/agents/body-probe-root-agent/${name}/probe/ignore`
    );
    expect(json.probe).toBe("ignore");
    expect(json.agentName).toBe(name);
  });

  it("delivers a prefix of an unfinished body to a root Agent", async () => {
    const name = uniqueName();
    const json = await expectResponseBeforeUploadCompletes(
      `http://x/agents/body-probe-root-agent/${name}/probe/first-chunk`,
      { chunk: "control-prefix" }
    );
    expect(json.chunk).toBe("control-prefix");
    expect(json.done).toBe(false);
  });
});

// ── The regression: parent → facet ──────────────────────────────────

describe("body forwarding — parent to facet (_cf_forwardToFacet)", () => {
  it("dispatches to the child before the upload completes", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const json = await expectResponseBeforeUploadCompletes(
      `http://x/agents/test-sub-agent-parent/${parent}/sub/body-probe-sub-agent/${child}/probe/ignore`
    );

    expect(json.probe).toBe("ignore");
    expect(json.agentName).toBe(child);
  });

  it("delivers a prefix of an unfinished body to the child", async () => {
    const parent = uniqueName();
    const child = uniqueName();

    const json = await expectResponseBeforeUploadCompletes(
      `http://x/agents/test-sub-agent-parent/${parent}/sub/body-probe-sub-agent/${child}/probe/first-chunk`,
      { chunk: "facet-prefix" }
    );

    expect(json.chunk).toBe("facet-prefix");
    expect(json.done).toBe(false);
    expect(json.agentName).toBe(child);
  });

  it("forwards a 2 MB body byte-exact through one hop", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const bytes = payload(2 * 1024 * 1024);
    const expected = await sha256Hex(bytes);

    const res = await exports.default.fetch(
      `http://x/agents/test-sub-agent-parent/${parent}/sub/body-probe-sub-agent/${child}/probe/drain`,
      { body: bytes, method: "POST" }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.bytes).toBe(bytes.byteLength);
    expect(json.sha256).toBe(expected);
  });

  it("forwards a 2 MB body byte-exact through two nested hops", async () => {
    // The amplification the issue measured is per-hop, so the nested
    // chain is where buffering hurt most.
    const parent = uniqueName();
    const outer = uniqueName();
    const child = uniqueName();
    const bytes = payload(2 * 1024 * 1024);
    const expected = await sha256Hex(bytes);

    const res = await exports.default.fetch(
      `http://x/agents/test-sub-agent-parent/${parent}/sub/outer-sub-agent/${outer}/sub/body-probe-sub-agent/${child}/probe/drain`,
      { body: bytes, method: "POST" }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.bytes).toBe(bytes.byteLength);
    expect(json.sha256).toBe(expected);
    expect(json.agentName).toBe(child);
  });

  it("preserves an empty body and GET semantics", async () => {
    // The forwarder skips body handling for GET/HEAD; make sure the
    // streaming path didn't disturb that.
    const parent = uniqueName();
    const child = uniqueName();

    const res = await exports.default.fetch(
      `http://x/agents/test-sub-agent-parent/${parent}/sub/body-probe-sub-agent/${child}/probe/ignore`
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentName: string }).agentName).toBe(child);
  });
});

// ── The second call site: routeSubAgentRequest ───────────────────────

describe("body forwarding — routeSubAgentRequest", () => {
  it("streams through the custom route handler to the child", async () => {
    // `/custom-sub/...` crosses *two* boundaries: an ordinary DO stub
    // (routeSubAgentRequest → parent) and then a facet stub (parent →
    // child). Both call sites buffered, so this covers each in turn.
    const parent = uniqueName();
    const child = uniqueName();

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");

    const json = await expectResponseBeforeUploadCompletes(
      `http://x/custom-sub/${parent}/sub/body-probe-sub-agent/${child}/probe/first-chunk`,
      { chunk: "custom-route-prefix" }
    );

    expect(json.chunk).toBe("custom-route-prefix");
    expect(json.done).toBe(false);
    expect(json.agentName).toBe(child);
  });

  it("forwards a 2 MB body byte-exact through the custom route", async () => {
    const parent = uniqueName();
    const child = uniqueName();
    const bytes = payload(2 * 1024 * 1024);
    const expected = await sha256Hex(bytes);

    const parentStub = await getAgentByName(env.HookingSubAgentParent, parent);
    await parentStub.setHookMode("allow");

    const res = await exports.default.fetch(
      `http://x/custom-sub/${parent}/sub/body-probe-sub-agent/${child}/probe/drain`,
      { body: bytes, method: "POST" }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.bytes).toBe(bytes.byteLength);
    expect(json.sha256).toBe(expected);
  });
});
