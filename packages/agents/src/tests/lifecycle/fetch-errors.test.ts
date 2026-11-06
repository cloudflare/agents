import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleCapability } from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

const SECRET = "DATABASE_URL could not be resolved";

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
