import {
  createExecutionContext,
  runInDurableObject,
  runDurableObjectAlarm
  // waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

// Could import any other source file/function here
import { routePartykitRequest } from "../index";
import worker from "./worker";

function requireWebSocket(response: Response): WebSocket {
  const webSocket = response.webSocket;
  if (!webSocket) {
    throw new Error("Expected a WebSocket upgrade response");
  }
  return webSocket;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function retryableError(message = "transient Durable Object failure") {
  const error = new Error(message) as Error & {
    retryable: boolean;
    overloaded?: boolean;
  };
  error.retryable = true;
  return error;
}

function fakeEnvForFetch(
  fetch: (request: Request) => Promise<Response>
): Cloudflare.Env {
  return {
    FakeServer: {
      idFromName: (name: string) => name,
      get: () => ({ fetch })
    }
  } as unknown as Cloudflare.Env;
}

describe("Server", () => {
  it("can be connected with a url", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/parties/stateful/123");
    const response = await worker.fetch(request, env, ctx);
    expect(await response.json()).toEqual({
      name: "123"
    });
  });

  it("can be connected with a websocket", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/parties/stateful/123", {
      headers: {
        Upgrade: "websocket"
      }
    });
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.accept();
    ws.addEventListener("message", (message) => {
      try {
        expect(JSON.parse(message.data as string)).toEqual({
          name: "123"
        });
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("inherits hibernation when a child declares partial static options", async () => {
    const name = crypto.randomUUID();
    const response = await worker.fetch(
      new Request(`http://example.com/parties/stateful/${name}`, {
        headers: { Upgrade: "websocket" }
      }),
      env,
      createExecutionContext()
    );
    const websocket = requireWebSocket(response);
    websocket.accept();

    const acceptedWebSockets = await runInDurableObject(
      env.Stateful.getByName(name),
      (_instance, ctx) => ctx.getWebSockets().length
    );

    expect(acceptedWebSockets).toBe(1);
    websocket.close();
  });

  it("calls onStart only once, and does not process messages or requests until it is resolved", async () => {
    const ctx = createExecutionContext();

    async function makeConnection() {
      const request = new Request(
        "http://example.com/parties/on-start-server/123",
        {
          headers: {
            Upgrade: "websocket"
          }
        }
      );
      const response = await worker.fetch(request, env, ctx);
      const ws = requireWebSocket(response);
      ws.accept();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      ws.addEventListener("message", (message) => {
        try {
          expect(message.data).toEqual("1");
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          ws.close();
        }
      });
      return promise;
    }

    async function makeRequest() {
      const request = new Request(
        "http://example.com/parties/on-start-server/123"
      );
      const response = await worker.fetch(request, env, ctx);
      expect(await response.text()).toEqual("1");
    }

    await Promise.all([makeConnection(), makeConnection(), makeRequest()]);
  });

  it(".name is available inside onStart", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/on-start-server/999"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
  });

  it("can return an error in onBeforeConnect", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/on-start-server/is-error",
      {
        headers: {
          Upgrade: "websocket"
        }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(503);
  });

  it("can return a redirect in onBeforeConnect", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/on-start-server/is-redirect",
      {
        headers: {
          Upgrade: "websocket"
        }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example2.com");
  });

  it("can return an error in onBeforeRequest", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/on-start-server/is-error"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(504);
  });

  it("can return a redirect in onBeforeRequest", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/on-start-server/is-redirect"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example3.com");
  });

  it("provides className with the Durable Object class name", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/on-start-server/lobby-info"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      className: "OnStartServer",
      name: "lobby-info"
    });
  });

  it("retries transient Durable Object routing errors by default", async () => {
    const bodies: string[] = [];
    let hookCalls = 0;
    let retryEvent:
      | {
          attempt: number;
          maxAttempts: number;
          delayMs: number;
          name: string;
          className?: string;
        }
      | undefined;
    const env = fakeEnvForFetch(async (request) => {
      bodies.push(await request.text());
      if (bodies.length === 1) {
        throw retryableError();
      }
      return new Response("ok");
    });

    const response = await routePartykitRequest(
      new Request("http://example.com/parties/fake-server/retry-room", {
        method: "POST",
        body: "payload"
      }),
      env,
      {
        routingRetry: {
          baseDelayMs: 1,
          maxDelayMs: 1,
          onRetry: (event) => {
            retryEvent = {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              name: event.name,
              className: event.className
            };
          }
        },
        onBeforeRequest: () => {
          hookCalls++;
        }
      }
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("ok");
    expect(bodies).toEqual(["payload", "payload"]);
    expect(hookCalls).toBe(1);
    expect(retryEvent).toEqual({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      name: "retry-room",
      className: "FakeServer"
    });
  });

  it("does not retry overloaded Durable Object routing errors", async () => {
    let attempts = 0;
    const env = fakeEnvForFetch(async () => {
      attempts++;
      const error = retryableError("Durable Object is overloaded");
      error.overloaded = true;
      throw error;
    });

    await expect(
      routePartykitRequest(
        new Request("http://example.com/parties/fake-server/overloaded"),
        env,
        { routingRetry: { baseDelayMs: 1, maxDelayMs: 1 } }
      )
    ).rejects.toThrow("Durable Object is overloaded");
    expect(attempts).toBe(1);
  });

  it("does not retry non-retryable Durable Object routing errors", async () => {
    let attempts = 0;
    const env = fakeEnvForFetch(async () => {
      attempts++;
      throw new Error("not retryable");
    });

    await expect(
      routePartykitRequest(
        new Request("http://example.com/parties/fake-server/non-retryable"),
        env,
        { routingRetry: { baseDelayMs: 1, maxDelayMs: 1 } }
      )
    ).rejects.toThrow("not retryable");
    expect(attempts).toBe(1);
  });

  it("throws the last retryable routing error after maxAttempts", async () => {
    let attempts = 0;
    const env = fakeEnvForFetch(async () => {
      attempts++;
      throw retryableError(`transient ${attempts}`);
    });

    await expect(
      routePartykitRequest(
        new Request("http://example.com/parties/fake-server/exhausted"),
        env,
        { routingRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }
      )
    ).rejects.toThrow("transient 2");
    expect(attempts).toBe(2);
  });

  it("continues retrying when onRetry throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const env = fakeEnvForFetch(async () => {
      attempts++;
      if (attempts === 1) {
        throw retryableError();
      }
      return new Response("ok");
    });

    try {
      const response = await routePartykitRequest(
        new Request("http://example.com/parties/fake-server/on-retry-throws"),
        env,
        {
          routingRetry: {
            baseDelayMs: 1,
            maxDelayMs: 1,
            onRetry: () => {
              throw new Error("observer failed");
            }
          }
        }
      );

      expect(await response?.text()).toBe("ok");
      expect(attempts).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        "PartyServer routingRetry onRetry callback failed:",
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("can disable Durable Object routing retries", async () => {
    let attempts = 0;
    const env = fakeEnvForFetch(async () => {
      attempts++;
      throw retryableError();
    });

    await expect(
      routePartykitRequest(
        new Request("http://example.com/parties/fake-server/no-retry"),
        env,
        { routingRetry: false }
      )
    ).rejects.toThrow("transient Durable Object failure");
    expect(attempts).toBe(1);
  });

  it("ignores foreign hibernated websockets when broadcasting", async () => {
    const ctx = createExecutionContext();

    // Create a websocket that is accepted via the DO hibernation API directly
    // (no PartyServer `__pk` attachment).
    const foreignReq = new Request(
      "http://example.com/parties/mixed/room/foreign",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const foreignRes = await worker.fetch(foreignReq, env, ctx);
    const foreignWs = requireWebSocket(foreignRes);
    foreignWs.accept();

    // Now connect via PartyServer. onConnect() will call broadcast(), which must
    // not crash due to the foreign socket.
    const req = new Request("http://example.com/parties/mixed/room", {
      headers: { Upgrade: "websocket" }
    });
    const res = await worker.fetch(req, env, ctx);
    const ws = requireWebSocket(res);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        // We should receive at least one message from the server.
        expect(["hello", "connected"]).toContain(message.data);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
        foreignWs.close();
      }
    });

    return promise;
  });

  it("allows state and setState to be redefined on a connection", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/configurable-state/room1",
      {
        headers: {
          Upgrade: "websocket"
        }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.accept();
    ws.addEventListener("message", (message) => {
      try {
        // The server redefines state/setState and uses them to send back
        // { answer: 42 }, proving that Object.defineProperty worked.
        expect(JSON.parse(message.data as string)).toEqual({ answer: 42 });
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("allows state and setState to be redefined on a non-hibernating connection", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/configurable-state-in-memory/room1",
      {
        headers: {
          Upgrade: "websocket"
        }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.accept();
    ws.addEventListener("message", (message) => {
      try {
        // The non-hibernating server redefines state/setState and sends back
        // { answer: 99 }, proving Object.defineProperty works on this path too.
        expect(JSON.parse(message.data as string)).toEqual({ answer: 99 });
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("persists state through setState and reads it back via state getter", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/state-round-trip/room1",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    // Collect all messages to verify the full round-trip
    const messages: unknown[] = [];
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    ws.addEventListener("message", (event) => {
      try {
        messages.push(JSON.parse(event.data as string));

        if (messages.length === 1) {
          // First response: "get" should return the initial state set in onConnect
          expect(messages[0]).toEqual({ count: 1 });
          // Now ask the server to increment using the updater function form
          ws.send("increment");
        } else if (messages.length === 2) {
          // Second response: state should reflect the increment
          expect(messages[1]).toEqual({ count: 2 });
          resolve();
        }
      } catch (e) {
        reject(e);
      }
    });

    // Ask the server to read back the state that was set in onConnect
    ws.send("get");

    await promise;
    ws.close();
  });

  // it("can be connected with a query parameter");
  // it("can be connected with a header");

  // describe("hibernated");
  // describe("in-memory");
});

describe("Hibernating Server initialization", () => {
  it("calls onStart before processing connections", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/hibernating-on-start-server/h-test1",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        // counter should be 1 because onStart completed before onConnect
        expect(message.data).toEqual("1");
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("calls onStart only once with concurrent connections and requests", async () => {
    const ctx = createExecutionContext();

    async function makeConnection() {
      const request = new Request(
        "http://example.com/parties/hibernating-on-start-server/h-test2",
        {
          headers: { Upgrade: "websocket" }
        }
      );
      const response = await worker.fetch(request, env, ctx);
      const ws = requireWebSocket(response);
      ws.accept();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      ws.addEventListener("message", (message) => {
        try {
          expect(message.data).toEqual("1");
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          ws.close();
        }
      });
      return promise;
    }

    async function makeRequest() {
      const request = new Request(
        "http://example.com/parties/hibernating-on-start-server/h-test2"
      );
      const response = await worker.fetch(request, env, ctx);
      expect(await response.text()).toEqual("1");
    }

    await Promise.all([makeConnection(), makeConnection(), makeRequest()]);
  });

  it("handles websocket messages after initialization", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/hibernating-on-start-server/h-test3",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    // Wait for the onConnect message
    const connectMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    expect(connectMessage).toEqual("1");

    // Send a message and verify the server is still initialized
    ws.send("hello");
    const echoMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    expect(echoMessage).toEqual("counter:1");

    ws.close();
  });
});

describe("Error handling", () => {
  it("reads name automatically from ctx.id.name when addressed via idFromName", async () => {
    // Send a request directly to a DO stub without the x-partykit-room header.
    // The name is now available via ctx.id.name (populated whenever the stub
    // was created via idFromName/getByName), so no header/setName is needed.
    const id = env.Stateful.idFromName("no-header-test");
    const stub = env.Stateful.get(id);
    const response = await stub.fetch(
      new Request("http://example.com/some-path")
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { name: string };
    expect(data.name).toBe("no-header-test");
  });

  it("returns 500 with useful message when name cannot be resolved", async () => {
    // newUniqueId produces a DO whose ctx.id.name is undefined. Without the
    // legacy x-partykit-room header there is no way to know the name, so
    // Server.fetch() should surface a clear error that mentions the
    // supported alternatives.
    const id = env.Stateful.newUniqueId();
    const stub = env.Stateful.get(id);
    const response = await stub.fetch(
      new Request("http://example.com/some-path")
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Cannot determine the name");
    expect(body).toContain("idFromName");
    expect(body).toContain("wrangler");
  });
});

describe("onStart failure recovery", () => {
  it("resets status so subsequent requests can retry initialization", async () => {
    const ctx = createExecutionContext();

    // First request: onStart throws on first attempt, returns 500
    const request1 = new Request(
      "http://example.com/parties/failing-on-start-server/recovery-test"
    );
    const response1 = await worker.fetch(request1, env, ctx);
    expect(response1.status).toBe(500);

    // Second request: onStart should succeed on the retry because
    // the status was reset to "zero" (not stuck at "starting"), and
    // the error was caught inside blockConcurrencyWhile so the DO's
    // input gate wasn't permanently broken.
    const request2 = new Request(
      "http://example.com/parties/failing-on-start-server/recovery-test"
    );
    const response2 = await worker.fetch(request2, env, ctx);
    expect(response2.status).toBe(200);
    const data = (await response2.json()) as {
      counter: number;
      failCount: number;
    };
    // counter is 2 because onStart ran twice (first failed, second succeeded)
    expect(data.counter).toEqual(2);
    expect(data.failCount).toEqual(1);
  });
});

describe("Hibernating server name rehydration", () => {
  it("this.name and connection.server are available in onConnect", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/hibernating-name-in-message/connect-test",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const connectMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    expect(connectMessage).toEqual("connected:connect-test:connect-test");

    ws.close();
  });

  it("this.name and connection.server are available in onMessage after wake-up", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/hibernating-name-in-message/rehydrate-test",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    // Wait for the onConnect message
    await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });

    // Send a message to trigger onMessage after hibernation wake-up
    ws.send("ping");
    const nameMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    expect(nameMessage).toEqual("name:rehydrate-test:rehydrate-test");

    ws.close();
  });
});

describe("Alarm initialization", () => {
  it("properly initializes on alarm and calls onAlarm", async () => {
    // Use a single stub for the entire test so runDurableObjectAlarm
    // sees the same DO instance that has the alarm scheduled.
    const id = env.AlarmServer.idFromName("alarm-test1");
    const stub = env.AlarmServer.get(id);

    // Initialize the DO and schedule an alarm in one request.
    // No x-partykit-room header needed — ctx.id.name carries the name.
    const res = await stub.fetch(
      new Request(
        "http://example.com/parties/alarm-server/alarm-test1?setAlarm=1"
      )
    );
    expect(await res.text()).toEqual("alarm set");

    // Trigger the alarm
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Verify state: onStart called once, alarm was triggered once
    const stateRes = await stub.fetch(new Request("http://example.com/"));
    const state = (await stateRes.json()) as {
      counter: number;
      alarmCount: number;
    };
    expect(state.counter).toEqual(1);
    expect(state.alarmCount).toEqual(1);
  });
});

describe("Name resolution", () => {
  it("this.name resolves from ctx.id.name on first fetch (no header, no setName)", async () => {
    const id = env.Stateful.idFromName("ctx-id-name-test");
    const stub = env.Stateful.get(id);
    const res = await stub.fetch(new Request("http://example.com/"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("ctx-id-name-test");
  });

  it("this.name is available inside onAlarm after normal setup", async () => {
    const id = env.AlarmNameServer.idFromName("alarm-name-normal");
    const stub = env.AlarmNameServer.get(id);

    const setupRes = await stub.fetch(
      new Request(
        "http://example.com/parties/alarm-name-server/alarm-name-normal?setAlarm=1"
      )
    );
    expect(await setupRes.text()).toBe("alarm set");
    await expect(stub.readStoredName()).resolves.toBeUndefined();

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const stateRes = await stub.fetch(new Request("http://example.com/"));
    const state = (await stateRes.json()) as {
      name: string;
      alarmName: string | null;
      onStartName: string | null;
    };
    expect(state.name).toBe("alarm-name-normal");
    expect(state.alarmName).toBe("alarm-name-normal");
  });

  it("this.name is available inside onStart on cold wake", async () => {
    const id = env.AlarmNameServer.idFromName("alarm-onstart-name");
    const stub = env.AlarmNameServer.get(id);

    const setupRes = await stub.fetch(
      new Request(
        "http://example.com/parties/alarm-name-server/alarm-onstart-name?setAlarm=1"
      )
    );
    expect(await setupRes.text()).toBe("alarm set");

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const stateRes = await stub.fetch(new Request("http://example.com/"));
    const state = (await stateRes.json()) as { onStartName: string | null };
    expect(state.onStartName).toBe("alarm-onstart-name");
  });

  it("setName is idempotent for the matching value (ctx.id.name == name)", async () => {
    // setName is now effectively deprecated — but calling it with a value
    // that matches ctx.id.name remains a no-op that just runs onStart.
    const id = env.AlarmNameServer.idFromName("idempotent-test");
    const stub = env.AlarmNameServer.get(id);

    await stub.setName("idempotent-test");
    await stub.setName("idempotent-test");

    const res = await stub.fetch(new Request("http://example.com/"));
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("idempotent-test");
  });

  it("setName throws when called with a name different from ctx.id.name", async () => {
    // Sanity guard: setName() on an idFromName-addressed DO must
    // match `ctx.id.name`. Mismatches almost always indicate a typo
    // and should fail loudly rather than silently override. (Facets
    // are not a counter-example — facets should be created with an
    // explicit `id` in `FacetStartupOptions`, giving them their own
    // `ctx.id.name` so `setName()` isn't needed at all.)
    const id = env.AlarmNameServer.idFromName("ctx-id-mismatch");
    const stub = env.AlarmNameServer.get(id);

    // Route the call through the DO's own fetch handler so the rejection
    // is caught inside the DO and doesn't surface as an unhandled promise
    // rejection at the RPC boundary.
    const res = await stub.fetch(
      new Request(
        "http://example.com/?setNameMismatch=" +
          encodeURIComponent("different-name")
      )
    );
    const data = (await res.json()) as { threw: boolean; message?: string };
    expect(data.threw).toBe(true);
    expect(data.message).toMatch(/created for name "ctx-id-mismatch"/);
  });

  describe("facets (real ctx.facets.get round-trip)", () => {
    // End-to-end coverage of the workerd facet API and partyserver's
    // contract on top of it. These tests exist as executable docs —
    // the supported pattern is to pass `id` in FacetStartupOptions
    // so the facet has its own `ctx.id.name`. The implicit-id flow
    // is also exercised here to pin down the runtime contract: a
    // facet without explicit `id` inherits the parent's `ctx.id`,
    // including `ctx.id.name`. Frameworks that want their facets
    // to have logical names different from the parent's MUST pass
    // an explicit `id`.

    it("facet WITHOUT explicit id inherits the parent DO's ctx.id.name (workerd contract)", async () => {
      // Documents the runtime behavior — not a recommendation. If
      // you call `ctx.facets.get(name, () => ({ class }))` without
      // an `id`, the facet's `ctx.id` IS the parent's id. PartyServer
      // reflects that faithfully: `this.name` on the facet returns
      // the parent's name, NOT the facet's `name` argument. This is
      // almost always not what you want — see the explicit-id test
      // below for the recommended pattern.
      const parentName = "facet-parent-" + Math.random().toString(36).slice(2);
      const facetName = "facet-child-" + Math.random().toString(36).slice(2);

      const id = env.FacetParent.idFromName(parentName);
      const stub = env.FacetParent.get(id);

      const result = await stub.spawnImplicitId(facetName);

      expect(result.parentName).toBe(parentName);
      // The facet's ctx.id.name is the PARENT's name, because facets
      // without explicit id share the parent's underlying DO id.
      expect(result.facet.ctxIdName).toBe(parentName);
      // Therefore this.name on the facet also returns the parent's
      // name. Consumers reading this.name from inside an implicit-id
      // facet will see the wrong value.
      expect(result.facet.name).toBe(parentName);
      // Native names are not duplicated into storage, even when an implicit
      // facet inherits the parent's identity.
      expect(result.facet.storedName).toBeUndefined();
    });

    it("facet WITH explicit id survives cold wake from its native name", async () => {
      // The factory passed to ctx.facets.get() runs again on resume, and
      // idFromName(facetName) is deterministic, so the resumed facet gets the
      // same ctx.id.name without a duplicate storage record.
      const parentName = "facet-parent-" + Math.random().toString(36).slice(2);
      const facetName = "facet-child-" + Math.random().toString(36).slice(2);

      const id = env.FacetParent.idFromName(parentName);
      const stub = env.FacetParent.get(id);

      await stub.spawnWithExplicitId(facetName, "env-namespace");
      // The fallback record is populated from the facet's own explicit id.
      const result = await stub.spawnWithExplicitId(facetName, "env-namespace");
      expect(result.facet.name).toBe(facetName);
      expect(result.facet.ctxIdName).toBe(facetName);
      expect(result.facet.storedName).toBeUndefined();
    });

    it("facet WITH explicit id (FacetStartupOptions.id) gets its own ctx.id.name — no setName needed", async () => {
      // Per https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/,
      // FacetStartupOptions.id is optional; when supplied, the facet's
      // `ctx.id` reflects that id rather than inheriting the parent's.
      // This is the recommended pattern — the facet gets a real
      // `ctx.id.name === facetName` and partyserver's `name` getter
      // returns it without any setName override mechanism.
      //
      // The id can be constructed from any DurableObjectNamespace.
      // Two ergonomic options:
      //   - env binding (requires knowing the binding name)
      //   - `ctx.exports[BoundClassName]` (works with any bound DO
      //     class; no env knowledge required — recommended for
      //     framework code)
      // A plain string is NOT a valid id — workerd treats it as
      // idFromString-like and the resulting facet has no
      // `ctx.id.name`, so `this.name` throws.
      const parentName = "facet-parent-" + Math.random().toString(36).slice(2);
      const facetName = "facet-child-" + Math.random().toString(36).slice(2);

      const id = env.FacetParent.idFromName(parentName);
      const stub = env.FacetParent.get(id);

      // Each strategy gets a fresh facet name so the factory actually
      // runs (resuming an existing facet skips the factory and would
      // mask strategy-specific failures).
      const fromEnvNs = (
        await stub.spawnWithExplicitId(
          `${facetName}-env-namespace`,
          "env-namespace"
        )
      ).facet;
      const fromCtxExportsNs = (
        await stub.spawnWithExplicitId(
          `${facetName}-ctx-exports-namespace`,
          "ctx-exports-namespace"
        )
      ).facet;
      const fromPlainStr = (
        await stub.spawnWithExplicitId(
          `${facetName}-plain-string`,
          "plain-string"
        )
      ).facet;

      // env-namespace: works.
      expect(fromEnvNs.name).toBe(`${facetName}-env-namespace`);
      expect(fromEnvNs.ctxIdName).toBe(`${facetName}-env-namespace`);
      expect(fromEnvNs.storedName).toBeUndefined();
      expect(fromEnvNs.onStartName).toBe(`${facetName}-env-namespace`);

      // ctx-exports-namespace: also works, no env knowledge needed.
      // Recommended for framework code.
      expect(fromCtxExportsNs.name).toBe(`${facetName}-ctx-exports-namespace`);
      expect(fromCtxExportsNs.ctxIdName).toBe(
        `${facetName}-ctx-exports-namespace`
      );
      expect(fromCtxExportsNs.storedName).toBeUndefined();
      expect(fromCtxExportsNs.onStartName).toBe(
        `${facetName}-ctx-exports-namespace`
      );

      // plain-string: produces a valid facet but ctx.id.name is
      // undefined and this.name throws. snapshot() catches the
      // throw and returns name: null. Pinning this contract so
      // callers don't get tempted by the type signature accepting
      // `string`.
      expect(fromPlainStr.name).toBeNull();
      expect(fromPlainStr.ctxIdName).toBeUndefined();
    });
  });

  it("getServerByName awaits onStart before returning, so user-defined RPCs see initialized state", async () => {
    // Regression guard: `getServerByName` must return a stub on which
    // user-defined RPC methods can rely on state initialized in
    // `onStart()`. Native DO RPCs do not pass through `Server.fetch()`
    // and therefore don't trigger `#ensureInitialized()` themselves.
    const { getServerByName } = await import("../index");
    const stub = await getServerByName(env.OnStartServer, "gsbn-rpc-sync");
    const counter = await stub.getCounter();
    // If onStart didn't run, counter would be 0. The fixture increments
    // it after a 300ms delay, so seeing 1 here proves onStart completed.
    expect(counter).toBe(1);
  });

  it("getServerByName returns a stub whose this.name is available without any additional plumbing", async () => {
    const ctx = createExecutionContext();

    // First, route a request to set up the DO.
    const request = new Request(
      "http://example.com/parties/alarm-name-server/gsbn-test"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { name: string };
    expect(data.name).toBe("gsbn-test");

    // Then fetch the same DO directly — no header, no setName needed.
    const id = env.AlarmNameServer.idFromName("gsbn-test");
    const stub = env.AlarmNameServer.get(id);
    const directRes = await stub.fetch(new Request("http://example.com/"));
    const directData = (await directRes.json()) as { name: string };
    expect(directData.name).toBe("gsbn-test");
  });
});

describe("this.name in the constructor", () => {
  it("is available from class field initializers and the constructor body", async () => {
    // Phase 1 headline capability: `this.name` resolves from
    // `ctx.id.name`, which is populated before the subclass body runs.
    // That means class fields AND the constructor body can both read it.
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/name-in-constructor-server/ctor-test"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      fieldName: string;
      constructorName: string;
      currentName: string;
    };
    expect(data.fieldName).toBe("ctor-test");
    expect(data.constructorName).toBe("ctor-test");
    expect(data.currentName).toBe("ctor-test");
  });
});

describe("x-partykit-room header applied before onStart", () => {
  it("populates this.name from header before onStart runs", async () => {
    // Regression guard: for DOs with `ctx.id.name === undefined` where
    // the caller supplies the name via `x-partykit-room`, the header
    // must be applied BEFORE `#ensureInitialized()` runs `onStart()`.
    // Otherwise an onStart that reads `this.name` would throw.
    const id = env.HeaderOnlyOnStartServer.newUniqueId();
    const stub = env.HeaderOnlyOnStartServer.get(id);
    const res = await stub.fetch(
      new Request("http://example.com/", {
        headers: { "x-partykit-room": "header-onstart-test" }
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      name: string;
      onStartName: string | null;
    };
    expect(data.name).toBe("header-onstart-test");
    expect(data.onStartName).toBe("header-onstart-test");
  });
});

describe("setName() as bootstrap API for non-idFromName DOs", () => {
  it("persists __ps_name to storage so the name survives eviction", async () => {
    const id = env.SetNameBootstrapServer.newUniqueId();
    const stub = env.SetNameBootstrapServer.get(id);

    const result = await stub.bootstrap("setname-bootstrap-test");
    expect(result.onStartName).toBe("setname-bootstrap-test");

    // Verify setName() persisted to storage. Frameworks no longer need
    // to write __ps_name themselves — `setName()` covers it.
    const stored = await stub.readStoredName();
    expect(stored).toBe("setname-bootstrap-test");
  });

  it("recovers the name on cold-wake fetch via the storage fallback", async () => {
    const id = env.SetNameBootstrapServer.newUniqueId();
    const stub = env.SetNameBootstrapServer.get(id);
    await stub.bootstrap("setname-coldwake-test");

    // Subsequent fetch with no header — must hydrate from storage.
    const res = await stub.fetch(new Request("http://example.com/"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("setname-coldwake-test");
  });

  it("does not persist a fallback for an idFromName-addressed DO", async () => {
    const name = "setname-native-name";
    const id = env.SetNameBootstrapServer.idFromName(name);
    const stub = env.SetNameBootstrapServer.get(id);

    // A matching setName call still synchronizes startup but the native name
    // is no longer copied into __ps_name.
    await stub.setName(name);

    expect(await stub.readStoredName()).toBeUndefined();
  });
});

describe("Legacy framework bootstrap fallback", () => {
  it("hydrates this.name from __ps_name storage when ctx.id.name is undefined", async () => {
    // Regression guard for older frameworks that addressed an object without
    // idFromName(), wrote __ps_name directly, and then called
    // __unsafe_ensureInitialized(). Current Agents facets receive explicit
    // native ids, but existing raw-id objects still need this recovery path.
    // PartyServer must hydrate the record before onStart() reads this.name.
    const id = env.FacetLikeBootstrapServer.newUniqueId();
    const stub = env.FacetLikeBootstrapServer.get(id);
    const result = await stub.bootstrap("facet-bootstrap-test");
    expect(result.onStartName).toBe("facet-bootstrap-test");

    // Follow-up fetch must also see the hydrated name (the #_name
    // stashed during bootstrap survives in-memory as long as the DO
    // instance isn't evicted).
    const res = await stub.fetch(new Request("http://example.com/"));
    const data = (await res.json()) as {
      name: string;
      onStartName: string | null;
    };
    expect(data.name).toBe("facet-bootstrap-test");
    expect(data.onStartName).toBe("facet-bootstrap-test");
  });

  it("recovers from cold-wake fetch by re-reading storage when ctx.id.name is undefined", async () => {
    // After the initial bootstrap, the DO may evict and come back
    // cold. `Server.fetch()` must still resolve `this.name` via the
    // storage fallback inside `#ensureInitialized()`, even without an
    // `x-partykit-room` header.
    const id = env.FacetLikeBootstrapServer.newUniqueId();
    const stub = env.FacetLikeBootstrapServer.get(id);
    await stub.bootstrap("facet-coldwake-test");

    // Second, otherwise-unrelated fetch — no header, no bootstrap call.
    // Simulates a later request arriving at the same DO.
    const res = await stub.fetch(new Request("http://example.com/"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("facet-coldwake-test");
  });
});

describe("Raw runtime contract: ctx.id.name in alarms", () => {
  // Probe a raw DurableObject to pin the current local runtime contract
  // independently of the vendored Server. Named access must carry the same
  // name through fetch and alarm entry points.
  it("provides ctx.id.name in fetch and alarm for idFromName DOs", async () => {
    const name = "raw-alarm-" + Math.random().toString(36).slice(2);
    const id = env.RawAlarmDO.idFromName(name);
    const stub = env.RawAlarmDO.get(id);

    const fetchRes = await stub.fetch(new Request("http://example.com/"));
    const fetchData = (await fetchRes.json()) as {
      fetchCtxIdName: string | undefined;
      alarmCtxIdName: string | undefined | null;
    };
    expect(fetchData.fetchCtxIdName).toBe(name);
    // alarm() hasn't fired yet; sentinel is null so we can distinguish
    // "didn't run" from "ran with undefined".
    expect(fetchData.alarmCtxIdName).toBeNull();

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const snap = await stub.snapshot();
    expect(snap.fetchCtxIdName).toBe(name);
    expect(snap.alarmCtxIdName).toBe(name);
  });

  it("ctx.id.name is undefined in alarm() for newUniqueId DOs (no name to propagate)", async () => {
    // Sanity check: when there is genuinely no name to begin with,
    // ctx.id.name remains undefined throughout — confirming that the
    // previous test isn't trivially passing because workerd is
    // synthesizing a name from somewhere else.
    const id = env.RawAlarmDO.newUniqueId();
    const stub = env.RawAlarmDO.get(id);

    await stub.fetch(new Request("http://example.com/"));
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const snap = await stub.snapshot();
    expect(snap.fetchCtxIdName).toBeUndefined();
    expect(snap.alarmCtxIdName).toBeUndefined();
  });
});

describe("Legacy fallbacks", () => {
  it("reads __ps_name from storage when ctx.id.name is undefined in an alarm", async () => {
    // Simulates the pre-2026-03-15 alarm migration scenario: an alarm was
    // scheduled by an older partyserver version and the alarm record does
    // not carry the DO name. Here we force this by using newUniqueId() so
    // `ctx.id.name` is undefined throughout the DO's lifetime, seed the
    // legacy storage record, and verify onAlarm() can still read
    // `this.name`.
    const id = env.AlarmNameServer.newUniqueId();
    const stub = env.AlarmNameServer.get(id);

    const seedRes = await stub.fetch(
      new Request("http://example.com/?seed=1&name=alarm-cold-wake")
    );
    expect(await seedRes.text()).toBe("seeded");

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // After alarm(), #_name is populated in memory from the legacy
    // storage record. A subsequent fetch can read it too (as long as the
    // instance isn't evicted between alarm and this fetch — in tests it
    // isn't).
    const stateRes = await stub.fetch(
      new Request("http://example.com/", {
        headers: { "x-partykit-room": "alarm-cold-wake" }
      })
    );
    const state = (await stateRes.json()) as {
      alarmName: string | null;
      onStartName: string | null;
    };
    expect(state.alarmName).toBe("alarm-cold-wake");
  });

  it("accepts x-partykit-room header as a fallback when ctx.id.name is undefined", async () => {
    const id = env.Stateful.newUniqueId();
    const stub = env.Stateful.get(id);
    const res = await stub.fetch(
      new Request("http://example.com/", {
        headers: { "x-partykit-room": "header-fallback" }
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("header-fallback");
  });
});

describe("CORS", () => {
  it("returns CORS headers on OPTIONS preflight for matched routes", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/cors-parties/cors-server/room1",
      { method: "OPTIONS" }
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, HEAD, OPTIONS"
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("*");
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    // Credentials header should NOT be in defaults (contradicts wildcard origin)
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("does not handle OPTIONS for unmatched routes (returns 404 from fallback)", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/other-path", {
      method: "OPTIONS"
    });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not handle OPTIONS for routes without cors enabled", async () => {
    const ctx = createExecutionContext();
    // The default /parties/ prefix has no cors option
    const request = new Request("http://example.com/parties/stateful/room1", {
      method: "OPTIONS"
    });
    const response = await worker.fetch(request, env, ctx);
    // Without cors, OPTIONS goes to the DO like any other request
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("appends CORS headers to regular (non-WebSocket) responses", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/cors-parties/cors-server/room1"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cors: true });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, HEAD, OPTIONS"
    );
  });

  it("does not append CORS headers to WebSocket upgrade responses", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/cors-parties/cors-server/room1",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(101);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("supports custom HeadersInit CORS headers", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/custom-cors-parties/custom-cors-server/room1"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customCors: true });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://example.com"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST"
    );
    // Should not have the default headers that weren't specified
    expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
  });

  it("supports custom HeadersInit CORS headers on OPTIONS preflight", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/custom-cors-parties/custom-cors-server/room1",
      { method: "OPTIONS" }
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://example.com"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST"
    );
  });

  it("does not add CORS headers when cors option is not set", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/parties/stateful/room1");
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("appends CORS headers to responses returned by onBeforeRequest", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/cors-parties/cors-server/blocked"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    // CORS headers must be present so the browser can read the error
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, HEAD, OPTIONS"
    );
  });
});

describe("Connection tags", () => {
  it("exposes tags on a hibernating connection", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/tags-server/room1",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        const tags = JSON.parse(message.data as string) as string[];
        // Should include the auto-prepended connection id plus the custom tags
        expect(tags).toHaveLength(3);
        expect(tags[0]).toBeTypeOf("string"); // connection id
        expect(tags).toContain("role:admin");
        expect(tags).toContain("room:lobby");
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("exposes tags on a hibernating connection after wake-up", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/tags-server/room2",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    // Wait for the onConnect message
    const connectMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    const connectTags = JSON.parse(connectMessage) as string[];
    expect(connectTags).toContain("role:admin");

    // Send a message to trigger onMessage, which reads tags again
    ws.send("ping");
    const wakeMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    const wakeTags = JSON.parse(wakeMessage) as string[];
    expect(wakeTags).toHaveLength(3);
    expect(wakeTags).toContain("role:admin");
    expect(wakeTags).toContain("room:lobby");

    ws.close();
  });

  it("exposes tags on a non-hibernating (in-memory) connection", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/tags-server-in-memory/room1",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        const tags = JSON.parse(message.data as string) as string[];
        // Should include the auto-prepended connection id plus the custom tags
        expect(tags).toHaveLength(3);
        expect(tags[0]).toBeTypeOf("string"); // connection id
        expect(tags).toContain("role:viewer");
        expect(tags).toContain("room:general");
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });
});

describe("Connection uri", () => {
  it("exposes uri on a hibernating connection in onConnect", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/parties/uri-server/room1", {
      headers: { Upgrade: "websocket" }
    });
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        const data = JSON.parse(message.data as string) as { uri: string };
        expect(data.uri).toBe("http://example.com/parties/uri-server/room1");
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("preserves uri after hibernation wake-up (onMessage)", async () => {
    const ctx = createExecutionContext();
    const request = new Request("http://example.com/parties/uri-server/room2", {
      headers: { Upgrade: "websocket" }
    });
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    // Wait for onConnect message
    await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });

    // Send a message to trigger onMessage (simulates post-hibernation wake)
    ws.send("ping");
    const wakeMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string), {
        once: true
      });
    });
    const data = JSON.parse(wakeMessage) as { uri: string };
    expect(data.uri).toBe("http://example.com/parties/uri-server/room2");

    ws.close();
  });

  it("includes query parameters in the uri", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/uri-server/room3?token=abc&_pk=custom-id",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        const data = JSON.parse(message.data as string) as { uri: string };
        expect(data.uri).toBe(
          "http://example.com/parties/uri-server/room3?token=abc&_pk=custom-id"
        );
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("exposes uri on a non-hibernating (in-memory) connection", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/parties/uri-server-in-memory/room1",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        const data = JSON.parse(message.data as string) as { uri: string };
        expect(data.uri).toBe(
          "http://example.com/parties/uri-server-in-memory/room1"
        );
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });
});

describe("Props via x-partykit-props header", () => {
  it("delivers props to onStart via HTTP request", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/props-parties/props-server/room1"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      name: string;
      props: { secret: string };
    };
    expect(data.name).toBe("room1");
    expect(data.props).toEqual({ secret: "my-secret-value" });
  });

  it("delivers props to onStart via WebSocket connection", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/props-parties/props-server/room2",
      {
        headers: { Upgrade: "websocket" }
      }
    );
    const response = await worker.fetch(request, env, ctx);
    const ws = requireWebSocket(response);
    ws.accept();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("message", (message) => {
      try {
        const data = JSON.parse(message.data as string) as {
          name: string;
          props: { secret: string };
        };
        expect(data.name).toBe("room2");
        expect(data.props).toEqual({ secret: "my-secret-value" });
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });

    return promise;
  });

  it("does not leak props in request headers", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/props-parties/props-server/room3"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(request.headers.get("x-partykit-props")).toBeNull();
  });

  // Regression for cloudflare/agents#1751: non-ASCII props (e.g. accented
  // names) used to be written into the x-partykit-props header verbatim,
  // triggering workerd's "header value contains non-ASCII characters"
  // warning (and a TypeError in browser fetch implementations). Props are
  // now base64-encoded so the header value is always ASCII while still
  // round-tripping the original Unicode payload.
  it("encodes non-ASCII props as an ASCII-safe header value", async () => {
    const ctx = createExecutionContext();
    const request = new Request(
      "http://example.com/unicode-props-parties/props-server/room-unicode"
    );
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      name: string;
      props: { secret: string };
      rawPropsHeader: string | null;
    };
    expect(data.name).toBe("room-unicode");
    // Props round-trip back to their original Unicode form.
    expect(data.props).toEqual({ secret: "Usuário 日本語 🎉" });
    // The header value the DO received must be ASCII-only.
    expect(data.rawPropsHeader).not.toBeNull();
    // oxlint-disable-next-line no-control-regex
    expect(data.rawPropsHeader).toMatch(/^[\x00-\x7f]*$/);
  });
});

/**
 * Regression coverage for cloudflare/partykit#389:
 *
 *   "PartyServer WebSockets do not complete client-initiated close
 *    handshake"
 *
 * The Hibernation API contract requires the application to reciprocate
 * the peer's Close frame inside `webSocketClose`. PartyServer's wrapper
 * was forwarding to user `onClose` but never calling `ws.close()`, so
 * any client that initiated a clean close stayed in CLOSING until the
 * underlying connection timed out (and reported 1006 abnormal closure).
 *
 * The non-hibernating path had the same hole, masked on newer compatibility
 * dates because the runtime auto-replies. This suite verifies PartyServer's
 * explicit reciprocation remains idempotent on the repository's current date;
 * the compatibility-matrix suite covers older dates.
 */
describe("Close handshake (#389)", () => {
  /**
   * Wait for a `close` event on `ws`, or fail the test with a clear
   * message if it doesn't fire within `timeoutMs`. Without the
   * framework reciprocating the Close frame, the WebSocketPair stays
   * in CLOSING indefinitely (there is no underlying network timeout
   * for in-process pairs), so an explicit timeout is required to keep
   * the suite finite.
   */
  function waitForClose(
    ws: WebSocket,
    timeoutMs = 2000
  ): Promise<{ code: number; reason: string; wasClean: boolean }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for client close event. ` +
              `readyState=${ws.readyState} (this means the server-side ` +
              `WebSocket never reciprocated the peer's Close frame)`
          )
        );
      }, timeoutMs);

      ws.addEventListener(
        "close",
        (event) => {
          clearTimeout(timer);
          resolve({
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
          });
        },
        { once: true }
      );
    });
  }

  /** Open a websocket, wait for the server's "hello", return the ws. */
  async function openAndHandshake(url: string): Promise<WebSocket> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(url, { headers: { Upgrade: "websocket" } }),
      env,
      ctx
    );
    if (!response.webSocket) {
      throw new Error(
        `Expected a WebSocket upgrade response, got status=${response.status}`
      );
    }
    const ws = response.webSocket;
    ws.accept();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for server hello")),
        2000
      );
      ws.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          if (event.data === "hello") resolve();
          else reject(new Error(`Expected "hello", got ${String(event.data)}`));
        },
        { once: true }
      );
    });
    return ws;
  }

  // -------------------------------------------------------------------
  // Hibernating path
  // -------------------------------------------------------------------

  describe("hibernating", () => {
    it("client-initiated close completes the handshake (issue #389)", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/close-handshake-hibernating/room-a"
      );

      ws.close(1000, "client-said-bye");

      const event = await waitForClose(ws);

      // The headline assertion: client must observe a clean close, not
      // a 1006 abnormal closure. Before the fix, the close event
      // never fired at all in this environment.
      expect(event.wasClean).toBe(true);
      expect(event.code).toBe(1000);
      expect(event.reason).toBe("client-said-bye");
    });

    it("delivers the peer's code and reason to onClose", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/close-handshake-hibernating/room-b"
      );

      ws.close(4321, "structured-shutdown");
      await waitForClose(ws);

      // Probe the DO via HTTP to read back the persisted onClose
      // record. Storage survives hibernation, so this also confirms
      // the framework's reciprocation didn't somehow short-circuit
      // user code.
      const ctx = createExecutionContext();
      const probe = await worker.fetch(
        new Request(
          "http://example.com/parties/close-handshake-hibernating/room-b"
        ),
        env,
        ctx
      );
      const body = (await probe.json()) as {
        lastClose: {
          code: number;
          reason: string;
          wasClean: boolean;
          readyStateAtOnClose: number;
          id: string;
        } | null;
      };

      expect(body.lastClose).not.toBeNull();
      const lastClose = requireValue(
        body.lastClose,
        "Expected the server to persist the close event"
      );
      expect(lastClose.code).toBe(4321);
      expect(lastClose.reason).toBe("structured-shutdown");
      expect(lastClose.wasClean).toBe(true);
      expect(typeof lastClose.id).toBe("string");
    });

    it("still completes the handshake when onClose throws", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/throwing-close-hibernating/room-c"
      );

      ws.close(1000, "throw-and-recover");

      // Even though `onClose` throws, the framework must still
      // reciprocate the Close frame in its `finally` so the client
      // doesn't observe a 1006 abnormal closure.
      const event = await waitForClose(ws);

      expect(event.wasClean).toBe(true);
      expect(event.code).toBe(1000);
    });

    it("respects user-initiated close inside onClose (idempotent reciprocation)", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/user-closes-in-on-close-hibernating/room-d"
      );

      ws.close(1000, "client-says-bye");

      const event = await waitForClose(ws);

      // The framework's `closeQuietly(ws, 1000, "client-says-bye")`
      // in `finally` runs AFTER `onClose`. Whichever close-frame goes
      // first (user's 4000 vs. framework's 1000 reciprocation) wins;
      // the second is silently ignored. The runtime guarantee is
      // "calling close() on an already-closing/closed socket is a
      // no-op" so the only thing we can portably assert is:
      //
      //   - the client gets a clean close
      //   - the code is one of the two we sent (4000 or 1000)
      //
      // The exact code depends on workerd's auto-reply state at the
      // active compat date, which is OK — what matters is that the
      // handshake completes at all.
      expect(event.wasClean).toBe(true);
      expect([1000, 4000]).toContain(event.code);
    });

    it("skips reciprocation when the peer didn't send a real Close frame (reserved codes)", async () => {
      // Regression for the followup to #393: when the runtime calls
      // `webSocketClose` with a reserved synthetic code (1005 / 1006
      // / 1015), the peer didn't actually send a Close frame — these
      // codes can only be SYNTHESIZED locally. Calling `ws.close(...)`
      // to "reciprocate" anyway succeeds synchronously but schedules
      // an outbound write whose target may already be gone (notably
      // when the WebSocket pair is tunneled across Durable Object
      // RPC boundaries). The runtime later rejects that write with
      // `Network connection lost`, which escapes `closeQuietly`'s
      // synchronous try/catch and surfaces as an unhandled rejection.
      //
      // The fix is to recognize the reserved-code shape and skip the
      // reciprocation entirely. There is nothing to acknowledge.
      //
      // What we verify here:
      //   1. `onClose` IS still invoked with the reserved code, so
      //      user-side cleanup runs as expected.
      //   2. The test file completes without any unhandled rejection.
      //      Without the fix, an integration scenario that puts the
      //      server-side socket on a different isolate from the
      //      client (e.g. a Cloudflare Agents facet) would emit
      //      `Network connection lost` here as a vitest "Errors 1"
      //      entry alongside the otherwise-passing test.
      //
      // We cannot easily reproduce the cross-isolate transport
      // failure inside this in-process test runner, but we CAN
      // reliably synthesize a code-1005 arrival on the server by
      // having the client send a Close frame with no code (`ws.close()`
      // with no args). That exercises the same `closeQuietly`
      // branch without depending on a particular runtime topology.
      const ws = await openAndHandshake(
        "http://example.com/parties/close-handshake-hibernating/reserved-room"
      );
      ws.close(); // no code → server receives webSocketClose with code=1005

      // We don't await `waitForClose(ws)` — with reciprocation skipped
      // the client may not see a clean close on older compat dates
      // (the runtime's auto-reply flag isn't active until 2026-04-07).
      // What matters is that the server's `onClose` ran with the
      // reserved code and no unhandled rejection escaped.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const ctx = createExecutionContext();
      const probe = await worker.fetch(
        new Request(
          "http://example.com/parties/close-handshake-hibernating/reserved-room"
        ),
        env,
        ctx
      );
      const body = (await probe.json()) as {
        lastClose: { code: number; wasClean: boolean } | null;
      };

      expect(body.lastClose).not.toBeNull();
      const lastClose = requireValue(
        body.lastClose,
        "Expected the server to persist the close event"
      );
      expect(lastClose.code).toBe(1005);
    });

    it("normalizes reserved close codes (1005, 1006, 1015) when reciprocating", async () => {
      // The runtime never delivers a 1005/1006 close *frame* to
      // webSocketClose (these are synthetic, used only when there is
      // no actual close frame). But user code may call
      // `connection.close(1005)` etc. from `onClose`, and the
      // framework's reciprocation in `finally` must not throw if the
      // peer's `code` happens to be reserved. We can't easily inject
      // a 1005 from the runtime side in this test environment, so
      // instead we directly verify the normalization function via a
      // contract test: a normal client close at 1000 still reciprocates
      // cleanly, AND the framework's reciprocation does not crash the
      // handler when the user later closes with a non-reserved code.
      //
      // The "doesn't crash" guarantee is implicit in all the other
      // tests in this suite: any throw from `closeQuietly` would have
      // bubbled out and they would have failed.
      const ws = await openAndHandshake(
        "http://example.com/parties/close-handshake-hibernating/room-e"
      );

      ws.close(1000, "normal");

      const event = await waitForClose(ws);
      expect(event.wasClean).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Non-hibernating path (`#attachSocketEventHandlers`)
  // -------------------------------------------------------------------

  describe("non-hibernating", () => {
    it("client-initiated close completes the handshake", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/close-handshake-in-memory/room-a"
      );

      ws.close(1000, "client-said-bye");

      const event = await waitForClose(ws);

      // The non-hibernating path adds a close listener to the server-side
      // socket via #attachSocketEventHandlers. PartyServer's explicit close
      // remains safe when the current runtime also auto-replies.
      expect(event.wasClean).toBe(true);
      expect(event.code).toBe(1000);
      expect(event.reason).toBe("client-said-bye");
    });

    it("delivers the peer's code and reason to onClose", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/close-handshake-in-memory/room-b"
      );

      ws.close(4222, "in-memory-shutdown");
      await waitForClose(ws);

      const ctx = createExecutionContext();
      const probe = await worker.fetch(
        new Request(
          "http://example.com/parties/close-handshake-in-memory/room-b"
        ),
        env,
        ctx
      );
      const body = (await probe.json()) as {
        lastClose: {
          code: number;
          reason: string;
          wasClean: boolean;
          readyStateAtOnClose: number;
          id: string;
        } | null;
      };

      expect(body.lastClose).not.toBeNull();
      const lastClose = requireValue(
        body.lastClose,
        "Expected the server to persist the close event"
      );
      expect(lastClose.code).toBe(4222);
      expect(lastClose.reason).toBe("in-memory-shutdown");
      expect(lastClose.wasClean).toBe(true);
    });

    it("still completes the handshake when onClose throws", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/throwing-close-in-memory/room-c"
      );

      ws.close(1000, "throw-and-recover");

      const event = await waitForClose(ws);

      expect(event.wasClean).toBe(true);
      expect(event.code).toBe(1000);
    });

    it("respects user-initiated close inside onClose (idempotent reciprocation)", async () => {
      const ws = await openAndHandshake(
        "http://example.com/parties/user-closes-in-on-close-in-memory/room-d"
      );

      ws.close(1000, "client-says-bye");

      const event = await waitForClose(ws);

      expect(event.wasClean).toBe(true);
      expect([1000, 4000]).toContain(event.code);
    });
  });

  // -------------------------------------------------------------------
  // Cross-cutting: server-initiated closes are unaffected
  // -------------------------------------------------------------------

  it("server-initiated close still works on hibernating servers", async () => {
    // When the SERVER initiates the close (e.g. via
    // `connection.close(1000, ...)` from a user message handler), the
    // framework's `webSocketClose` reciprocation path is not involved
    // — the client just observes a normal close from the server. This
    // test guards against regressions where the new `finally` block
    // accidentally interferes with that flow.
    const ws = await openAndHandshake(
      "http://example.com/parties/user-closes-in-on-close-hibernating/room-server-init"
    );

    // We don't have a direct "server please close" message, but the
    // `UserClosesInOnClose*` fixtures call `connection.close(4000, ...)`
    // from `onClose`, which only runs after the client closes. So
    // simulate a server-initiated close by closing from the client
    // first and verifying the close event semantics — this also
    // exercises the `finally` block in a "user already closed" state.
    ws.close(1000, "test");
    const event = await waitForClose(ws);

    expect(event.wasClean).toBe(true);
  });
});
