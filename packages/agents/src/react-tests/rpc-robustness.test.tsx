/**
 * Integration tests for useAgent RPC robustness during connection churn.
 *
 * `usePartySocket` replaces the underlying socket object whenever
 * connection options change (query refresh, enabled toggle, path change).
 * Before these fixes, RPC calls could be silently stranded forever:
 * - calls issued against a stale `agent` reference were buffered inside
 *   a permanently-closed socket and never transmitted
 * - calls transmitted on a socket that was then replaced never got their
 *   response, and never got rejected either
 *
 * Related to: https://github.com/cloudflare/agents/issues/1738
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { useEffect, useRef, useState } from "react";
import { useAgent, type UseAgentOptions } from "../react";
import { getTestWorkerHost } from "./test-config";

// Wrap render to disable act() environment after mounting — these integration
// tests have async WebSocket updates that legitimately happen outside act().
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- tests don't need strict agent typing
type TestAgent = ReturnType<typeof useAgent<any>>;

afterEach(() => {
  cleanup();
});

/**
 * Harness whose useAgent options can be changed from the test, so we can
 * force `usePartySocket` to replace the socket object (e.g. by changing
 * `query`) and observe how in-flight / queued RPC calls behave.
 */
function ControlledAgentComponent({
  initialOptions,
  onAgent,
  exposeSetOptions
}: {
  initialOptions: UseAgentOptions<unknown>;
  onAgent: (agent: TestAgent) => void;
  exposeSetOptions: (
    setOptions: (options: UseAgentOptions<unknown>) => void
  ) => void;
}) {
  const [options, setOptions] = useState(initialOptions);
  useEffect(() => {
    exposeSetOptions(setOptions);
  }, [exposeSetOptions]);

  const agent = useAgent(options);
  useEffect(() => {
    onAgent(agent);
  }, [agent, agent.identified, onAgent]);

  return (
    <div data-testid="agent-status">
      {agent.identified ? "connected" : "connecting"}
    </div>
  );
}

/**
 * Harness that issues an RPC call from a mount-time effect — i.e. before
 * the WebSocket has opened. This is the exact pattern from issue #1738.
 */
function MountCallComponent({
  options,
  method,
  args,
  onResult,
  onError
}: {
  options: UseAgentOptions<unknown>;
  method: string;
  args: unknown[];
  onResult: (result: unknown) => void;
  onError: (error: Error) => void;
}) {
  const agent = useAgent(options);
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;
    agent.call(method, args).then(onResult, onError);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- fire exactly once on mount
  }, [agent]);

  return (
    <div data-testid="agent-status">
      {agent.identified ? "connected" : "connecting"}
    </div>
  );
}

describe("useAgent RPC robustness", () => {
  describe("calls issued before the socket is open", () => {
    it("resolves a call issued from a mount-time effect", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onResult = vi.fn();
      const onError = vi.fn();

      render(
        <MountCallComponent
          options={{
            agent: "TestCallableAgent",
            name: `mount-call-${crypto.randomUUID()}`,
            host,
            protocol
          }}
          method="add"
          args={[1, 2]}
          onResult={onResult}
          onError={onError}
        />
      );

      await vi.waitFor(
        () => {
          expect(onResult).toHaveBeenCalledWith(3);
        },
        { timeout: 10000 }
      );
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("socket replacement (connection options change)", () => {
    it("resolves calls made through a stale agent reference after the socket was replaced", async () => {
      const { host, protocol } = getTestWorkerHost();
      const seenAgents: TestAgent[] = [];
      let latestAgent: TestAgent | null = null;
      let setOptions: ((options: UseAgentOptions<unknown>) => void) | null =
        null;
      const name = `stale-ref-${crypto.randomUUID()}`;

      const baseOptions: UseAgentOptions<unknown> = {
        agent: "TestCallableAgent",
        name,
        host,
        protocol,
        query: { generation: "1" }
      };

      render(
        <ControlledAgentComponent
          initialOptions={baseOptions}
          onAgent={(agent) => {
            latestAgent = agent;
            if (!seenAgents.includes(agent)) seenAgents.push(agent);
          }}
          exposeSetOptions={(fn) => {
            setOptions = fn;
          }}
        />
      );

      // Wait for the first socket to connect
      await vi.waitFor(
        () => {
          expect(latestAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );
      const staleAgent = latestAgent!;

      // Changing `query` forces usePartySocket to create a brand-new
      // socket object; the old one is closed permanently.
      setOptions!({ ...baseOptions, query: { generation: "2" } });

      await vi.waitFor(
        () => {
          // A distinct socket object must have taken over and identified
          expect(seenAgents.length).toBeGreaterThanOrEqual(2);
          expect(latestAgent).not.toBe(staleAgent);
          expect(latestAgent!.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // The old reference's call() must route to the live socket instead
      // of buffering into the dead one (which hangs forever).
      const result = await staleAgent.call("add", [3, 4]);
      expect(result).toBe(7);
    });

    it("flushes calls queued while disconnected onto a replacement socket", async () => {
      const { host, protocol } = getTestWorkerHost();
      let latestAgent: TestAgent | null = null;
      let setOptions: ((options: UseAgentOptions<unknown>) => void) | null =
        null;
      const name = `queued-flush-${crypto.randomUUID()}`;

      const baseOptions: UseAgentOptions<unknown> = {
        agent: "TestCallableAgent",
        name,
        host,
        protocol,
        enabled: false,
        query: { generation: "1" }
      };

      render(
        <ControlledAgentComponent
          initialOptions={baseOptions}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={(fn) => {
            setOptions = fn;
          }}
        />
      );

      await vi.waitFor(() => {
        expect(latestAgent).not.toBeNull();
      });

      // Issue a call while the socket is disabled (never opened). The
      // request must be queued by the hook, NOT handed to this socket:
      // changing options below discards it, losing its internal buffer.
      const callPromise = latestAgent!.call("add", [2, 3]);

      // Re-enable with different options → a brand-new socket replaces
      // the disabled one.
      setOptions!({
        ...baseOptions,
        enabled: true,
        query: { generation: "2" }
      });

      // The queued call must flush on the replacement socket and resolve.
      await expect(callPromise).resolves.toBe(5);
    });

    it("rejects (rather than strands) calls already transmitted on a replaced socket", async () => {
      const { host, protocol } = getTestWorkerHost();
      let latestAgent: TestAgent | null = null;
      let setOptions: ((options: UseAgentOptions<unknown>) => void) | null =
        null;
      const name = `replaced-inflight-${crypto.randomUUID()}`;

      const baseOptions: UseAgentOptions<unknown> = {
        agent: "TestCallableAgent",
        name,
        host,
        protocol,
        query: { generation: "1" }
      };

      render(
        <ControlledAgentComponent
          initialOptions={baseOptions}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={(fn) => {
            setOptions = fn;
          }}
        />
      );

      await vi.waitFor(
        () => {
          expect(latestAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Transmit a slow call on the current socket, then replace the
      // socket before the response can arrive. The response is lost by
      // design (responses are connection-bound), so the call must reject
      // promptly instead of hanging.
      const slowCall = latestAgent!.call("asyncMethod", [10000]);
      setOptions!({ ...baseOptions, query: { generation: "2" } });

      await expect(slowCall).rejects.toThrow("Connection closed");
    });

    it("rejects queued calls when the agent address changes (destination guard)", async () => {
      const { host, protocol } = getTestWorkerHost();
      let latestAgent: TestAgent | null = null;
      let setOptions: ((options: UseAgentOptions<unknown>) => void) | null =
        null;

      const baseOptions: UseAgentOptions<unknown> = {
        agent: "TestCallableAgent",
        name: `address-guard-a-${crypto.randomUUID()}`,
        host,
        protocol,
        enabled: false
      };

      render(
        <ControlledAgentComponent
          initialOptions={baseOptions}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={(fn) => {
            setOptions = fn;
          }}
        />
      );

      await vi.waitFor(() => {
        expect(latestAgent).not.toBeNull();
      });

      // Queued while disconnected, composed for instance "address-guard-a".
      const callPromise = latestAgent!.call("add", [1, 1]);

      // Re-point the hook at a *different* agent instance. The queued
      // call must NOT execute there — flushing it would run an RPC
      // composed for one instance against another.
      setOptions!({
        ...baseOptions,
        enabled: true,
        name: `address-guard-b-${crypto.randomUUID()}`
      });

      await expect(callPromise).rejects.toThrow(/agent address changed/);
    });
  });

  describe("default call timeout", () => {
    it("rejects calls that never get a response after defaultCallTimeout", async () => {
      const { host, protocol } = getTestWorkerHost();
      let latestAgent: TestAgent | null = null;

      render(
        <ControlledAgentComponent
          initialOptions={{
            agent: "TestCallableAgent",
            name: `default-timeout-${crypto.randomUUID()}`,
            host,
            protocol,
            // Never connects — the call sits queued until the backstop fires
            enabled: false,
            defaultCallTimeout: 400
          }}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={() => {}}
        />
      );

      await vi.waitFor(() => {
        expect(latestAgent).not.toBeNull();
      });

      await expect(latestAgent!.call("add", [1, 2])).rejects.toThrow(
        /timed out after 400ms/
      );
    });

    it("lets an explicit timeout of 0 disable the default timeout", async () => {
      const { host, protocol } = getTestWorkerHost();
      let latestAgent: TestAgent | null = null;

      render(
        <ControlledAgentComponent
          initialOptions={{
            agent: "TestCallableAgent",
            name: `timeout-zero-${crypto.randomUUID()}`,
            host,
            protocol,
            defaultCallTimeout: 100
          }}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={() => {}}
        />
      );

      await vi.waitFor(
        () => {
          expect(latestAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Takes 400ms server-side — longer than defaultCallTimeout, but
      // timeout: 0 opts this call out of the backstop entirely.
      await expect(
        latestAgent!.call("asyncMethod", [400], { timeout: 0 })
      ).resolves.toBe("done");
    });

    it("does not apply the default timeout to streaming calls", async () => {
      const { host, protocol } = getTestWorkerHost();
      let latestAgent: TestAgent | null = null;
      const chunks: unknown[] = [];

      render(
        <ControlledAgentComponent
          initialOptions={{
            agent: "TestCallableAgent",
            name: `stream-no-default-${crypto.randomUUID()}`,
            host,
            protocol,
            defaultCallTimeout: 150
          }}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={() => {}}
        />
      );

      await vi.waitFor(
        () => {
          expect(latestAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // 3 chunks × 100ms = ~300ms total, well past defaultCallTimeout.
      // Streaming calls are exempt from the backstop.
      const result = await latestAgent!.call(
        "streamWithDelay",
        [["a", "b", "c"], 100],
        { stream: { onChunk: (chunk) => chunks.push(chunk) } }
      );

      expect(result).toBe("complete");
      expect(chunks).toEqual(["a", "b", "c"]);
    });
  });

  describe("dropped RPC responses", () => {
    it("warns when a response arrives for a call that already timed out", async () => {
      const { host, protocol } = getTestWorkerHost();
      const warnSpy = vi.spyOn(console, "warn");
      let latestAgent: TestAgent | null = null;

      render(
        <ControlledAgentComponent
          initialOptions={{
            agent: "TestCallableAgent",
            name: `dropped-response-${crypto.randomUUID()}`,
            host,
            protocol
          }}
          onAgent={(agent) => {
            latestAgent = agent;
          }}
          exposeSetOptions={() => {}}
        />
      );

      await vi.waitFor(
        () => {
          expect(latestAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // The call times out client-side after 50ms, but the server still
      // sends its response ~300ms later — with no matching pending call.
      await expect(
        latestAgent!.call("asyncMethod", [300], { timeout: 50 })
      ).rejects.toThrow(/timed out/);

      await vi.waitFor(
        () => {
          const warned = warnSpy.mock.calls.some((call) =>
            String(call[0]).includes("Discarded an RPC response")
          );
          expect(warned).toBe(true);
        },
        { timeout: 5000 }
      );

      warnSpy.mockRestore();
    });
  });
});
