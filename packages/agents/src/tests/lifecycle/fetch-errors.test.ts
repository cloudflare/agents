import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleCapability } from "../../lifecycle";
import { FETCH_ERROR_SECRET } from "../capabilities/lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

const SECRET = FETCH_ERROR_SECRET;

/** Fails startup with an error whose message must not reach the caller. */
class FailingStart extends LifecycleCapability {
  constructor() {
    super("failing-start");
  }
  override onStart(): void {
    throw new Error(SECRET);
  }
}

/** Starts cleanly, then fails every HTTP request. */
class FailingRequest extends LifecycleCapability {
  constructor() {
    super("failing-request");
  }
  onRequest(): Response {
    throw new Error(SECRET);
  }
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/** Accepts the client end of a 101 response and collects what it receives. */
async function drainSocket(response: Response) {
  const ws = response.webSocket;
  if (!ws) throw new Error("expected a WebSocket on the response");
  const frames: unknown[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason })
    )
  );
  ws.addEventListener("message", (event) => frames.push(event.data));
  ws.accept();
  return { ...(await closed), frames };
}

describe("Lifecycle.fetch failure responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a generic 500 when startup fails, and logs the error", async () => {
    const errors = silenceErrors();
    const result = await withCapabilityHarness(async ({ install }) => {
      const { lifecycle } = install(new FailingStart());
      const response = await lifecycle.fetch(
        new Request("https://example.com")
      );
      return { status: response.status, body: await response.text() };
    });

    expect(result).toEqual({ status: 500, body: "Internal Server Error" });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("fetch:"),
      expect.objectContaining({ message: SECRET })
    );
  });

  it("sends a generic 500 when a request hook throws", async () => {
    silenceErrors();
    const result = await withCapabilityHarness(async ({ install }) => {
      const { lifecycle } = install(new FailingRequest());
      const response = await lifecycle.fetch(
        new Request("https://example.com")
      );
      return { status: response.status, body: await response.text() };
    });

    expect(result).toEqual({ status: 500, body: "Internal Server Error" });
  });

  // RFC 9110 §7.8: upgrade protocol names are case-insensitive.
  for (const upgrade of ["websocket", "WebSocket", "WEBSOCKET"]) {
    it(`closes a failed "${upgrade}" upgrade with 1011 and no error frame`, async () => {
      silenceErrors();
      const result = await withCapabilityHarness(async ({ install }) => {
        const { lifecycle } = install(new FailingStart());
        const response = await lifecycle.fetch(
          new Request("https://example.com", { headers: { Upgrade: upgrade } })
        );
        expect(response.status).toBe(101);
        return drainSocket(response);
      });

      expect(result).toEqual({
        code: 1011,
        reason: "Uncaught exception during session setup",
        frames: []
      });
    });
  }
});

describe("onFetchError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fetchErrorObject() {
    return env.FetchErrorObject.getByName(crypto.randomUUID());
  }

  it("sends the hook's response, and still logs the error", async () => {
    const errors = silenceErrors();
    const stub = fetchErrorObject();
    const url = "https://example.com/?fail=host&hook=respond";
    const response = await stub.fetch(url);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: FETCH_ERROR_SECRET });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("fetch:"),
      expect.objectContaining({ message: FETCH_ERROR_SECRET })
    );
    expect(await stub.getHookCalls()).toEqual([
      { error: FETCH_ERROR_SECRET, requestUrl: url, inHostContext: true }
    ]);
  });

  it("is called for a failed capability request hook", async () => {
    silenceErrors();
    const response = await fetchErrorObject().fetch(
      "https://example.com/?fail=capability&hook=respond"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: FETCH_ERROR_SECRET });
  });

  it("is called for a failed startup", async () => {
    silenceErrors();
    const stub = fetchErrorObject();
    await stub.failStartup();
    const response = await stub.fetch("https://example.com/?hook=respond");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "intentional startup failure"
    });
  });

  it("receives a thrown value that is not an Error", async () => {
    silenceErrors();
    const response = await fetchErrorObject().fetch(
      "https://example.com/?fail=non-error&hook=respond"
    );

    expect(await response.json()).toEqual({ error: FETCH_ERROR_SECRET });
  });

  it("sends the default when the hook declines", async () => {
    silenceErrors();
    const stub = fetchErrorObject();
    const response = await stub.fetch("https://example.com/?fail=host");

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(await stub.getHookCalls()).toHaveLength(1);
  });

  it("rethrows a thrown value that is not an Error when the hook declines", async () => {
    silenceErrors();
    await expect(
      fetchErrorObject().fetch("https://example.com/?fail=non-error")
    ).rejects.toThrow(FETCH_ERROR_SECRET);
  });

  it("sends the default, and logs the hook's error, when the hook throws", async () => {
    const errors = silenceErrors();
    const response = await fetchErrorObject().fetch(
      "https://example.com/?fail=host&hook=throw"
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("onFetchError:"),
      expect.objectContaining({ message: "onFetchError failed" })
    );
  });

  it("can answer a failed upgrade with its own socket", async () => {
    silenceErrors();
    const stub = fetchErrorObject();
    await stub.failStartup();
    const response = await stub.fetch("https://example.com/?hook=socket", {
      headers: { Upgrade: "websocket" }
    });

    expect(response.status).toBe(101);
    expect(await drainSocket(response)).toEqual({
      code: 4000,
      reason: "startup failed",
      frames: [JSON.stringify({ error: "intentional startup failure" })]
    });
  });

  it("closes a failed upgrade with 1011 when the hook declines", async () => {
    silenceErrors();
    const stub = fetchErrorObject();
    await stub.failStartup();
    const response = await stub.fetch("https://example.com/", {
      headers: { Upgrade: "websocket" }
    });

    expect(response.status).toBe(101);
    expect(await drainSocket(response)).toEqual({
      code: 1011,
      reason: "Uncaught exception during session setup",
      frames: []
    });
  });
});

describe("Agent onFetchError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function agent(prefix = "") {
    return env.TestFetchErrorAgent.getByName(prefix + crypto.randomUUID());
  }

  it("receives a failed onRequest's error after onError, in Agent context", async () => {
    silenceErrors();
    const response = await agent().fetch("https://example.com/?fail&hook");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      name: expect.any(String),
      error: "agent request failed",
      hookOrder: ["onError", "onFetchError"],
      inAgentContext: true
    });
  });

  it("receives the original error when onError returns instead of rethrowing", async () => {
    silenceErrors();
    const response = await agent("log-only-").fetch(
      "https://example.com/?fail&hook"
    );

    expect(await response.json()).toMatchObject({
      error: "agent request failed",
      hookOrder: ["onError", "onFetchError"]
    });
  });

  it("sends the default when onError returns and the override declines", async () => {
    silenceErrors();
    const response = await agent("log-only-").fetch(
      "https://example.com/?fail"
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("receives a failed onStart's error", async () => {
    silenceErrors();
    const response = await agent("fail-start-").fetch(
      "https://example.com/?hook"
    );

    expect(await response.json()).toMatchObject({
      error: "agent startup failed",
      hookOrder: ["onError", "onFetchError"]
    });
  });

  it("receives a failed onConnect's error for an upgrade", async () => {
    silenceErrors();
    const response = await agent().fetch("https://example.com/?fail&hook", {
      headers: { Upgrade: "websocket" }
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "agent connect failed",
      hookOrder: ["onError", "onFetchError"]
    });
  });

  it("closes a failed upgrade with 1011 when the override declines", async () => {
    silenceErrors();
    const response = await agent().fetch("https://example.com/?fail", {
      headers: { Upgrade: "websocket" }
    });

    expect(response.status).toBe(101);
    expect(await drainSocket(response)).toEqual({
      code: 1011,
      reason: "Uncaught exception during session setup",
      frames: []
    });
  });

  describe("for a sub-agent", () => {
    function subAgentUrl(parent: string, child: string, query: string) {
      return `https://example.com/agents/test-fetch-error-agent/${parent}/sub/test-fetch-error-agent/${child}?${query}`;
    }

    it("lets the child answer a failed request", async () => {
      silenceErrors();
      const parent = crypto.randomUUID();
      const child = crypto.randomUUID();
      const response = await env.TestFetchErrorAgent.getByName(parent).fetch(
        subAgentUrl(parent, child, "fail&hook")
      );

      expect(await response.json()).toMatchObject({
        name: child,
        error: "agent request failed"
      });
    });

    it("lets the parent answer a failed upgrade, even when the child's onConnect threw", async () => {
      silenceErrors();
      const parent = crypto.randomUUID();
      const child = crypto.randomUUID();
      const response = await env.TestFetchErrorAgent.getByName(parent).fetch(
        subAgentUrl(parent, child, "fail&hook"),
        { headers: { Upgrade: "websocket" } }
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        name: parent,
        error: "agent connect failed",
        // The parent forwards the connection without running its own
        // onConnect, so its onError never ran: the error is the child's.
        hookOrder: ["onFetchError"]
      });
    });
  });
});
