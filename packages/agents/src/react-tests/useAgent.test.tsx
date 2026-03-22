/**
 * Integration tests for useAgent React hook.
 * Tests connection, state sync, RPC calls, and hook lifecycle
 * against a real miniflare worker.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { Suspense, useEffect } from "react";
import { useAgent, type UseAgentOptions } from "../react";
import { getTestWorkerHost } from "./test-config";

// Simplified type for test assertions - avoids complex generic inference issues
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- tests don't need strict agent typing
type TestAgent = ReturnType<typeof useAgent<any>>;

// Wrap render to disable act() environment after mounting — these integration
// tests have async WebSocket updates that legitimately happen outside act().
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

// Clean up after each test
afterEach(() => {
  cleanup();
});

// Helper component that uses useAgent and exposes the result
function TestAgentComponent<State = unknown>({
  options,
  onAgent
}: {
  options: UseAgentOptions<State>;
  onAgent: (agent: ReturnType<typeof useAgent<State>>) => void;
}) {
  const agent = useAgent<State>(options);

  useEffect(() => {
    onAgent(agent);
  }, [agent, agent.identified, onAgent]);

  return (
    <div data-testid="agent-status">
      {agent.identified ? "connected" : "connecting"}
    </div>
  );
}

// Helper component that renders agent.state into the DOM for observability
function StateTrackingComponent<State = unknown>({
  options,
  onAgent
}: {
  options: UseAgentOptions<State>;
  onAgent: (agent: ReturnType<typeof useAgent<State>>) => void;
}) {
  const agent = useAgent<State>(options);

  useEffect(() => {
    onAgent(agent);
  }, [agent, agent.identified, agent.state, onAgent]);

  return (
    <div>
      <div data-testid="agent-status">
        {agent.identified ? "connected" : "connecting"}
      </div>
      <div data-testid="agent-state">
        {agent.state === undefined ? "undefined" : JSON.stringify(agent.state)}
      </div>
    </div>
  );
}

// Wrapper with Suspense for async query tests
function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div data-testid="loading">Loading...</div>}>
      {children}
    </Suspense>
  );
}

describe("useAgent hook", () => {
  describe("connection lifecycle", () => {
    it("should connect and receive identity", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      const onAgent = vi.fn((agent: TestAgent) => {
        capturedAgent = agent;
      });

      const { container } = await render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-identity",
              host,
              protocol
            }}
            onAgent={onAgent}
          />
        </SuspenseWrapper>
      );

      // Wait for connection
      await vi.waitFor(
        () => {
          const status = container.querySelector(
            '[data-testid="agent-status"]'
          );
          expect(status?.textContent).toBe("connected");
        },
        { timeout: 10000 }
      );

      expect(capturedAgent).not.toBeNull();
      expect(capturedAgent!.identified).toBe(true);
      expect(capturedAgent!.name).toBe("hook-test-identity");
      expect(capturedAgent!.agent).toBe("test-state-agent");
    });

    it("should call onIdentity callback", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onIdentity = vi.fn();

      const { container } = await render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-on-identity",
              host,
              protocol,
              onIdentity
            }}
            onAgent={() => {}}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          const status = container.querySelector(
            '[data-testid="agent-status"]'
          );
          expect(status?.textContent).toBe("connected");
          expect(onIdentity).toHaveBeenCalledWith(
            "hook-test-on-identity",
            "test-state-agent"
          );
        },
        { timeout: 10000 }
      );
    });

    it("should provide ready promise that resolves on identity", async () => {
      const { host, protocol } = getTestWorkerHost();
      let readyResolved = false;
      let capturedAgent: TestAgent | null = null;

      const onAgent = vi.fn((agent: TestAgent) => {
        capturedAgent = agent;
        // Check ready promise
        if (!readyResolved && agent.ready) {
          agent.ready.then(() => {
            readyResolved = true;
          });
        }
      });

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-ready",
              host,
              protocol
            }}
            onAgent={onAgent}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(readyResolved).toBe(true);
        },
        { timeout: 10000 }
      );

      expect(capturedAgent!.identified).toBe(true);
    });
  });

  describe("state synchronization", () => {
    it("should call onStateUpdate when client sends state", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onStateUpdate = vi.fn();
      let capturedAgent: TestAgent | null = null;

      const onAgent = vi.fn((agent: TestAgent) => {
        capturedAgent = agent;
      });

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-client",
              host,
              protocol,
              onStateUpdate
            }}
            onAgent={onAgent}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Send state update from client
      const newState = {
        count: 123,
        items: ["hook-test"],
        lastUpdated: Date.now()
      };
      capturedAgent!.setState(newState);

      expect(onStateUpdate).toHaveBeenCalledWith(newState, "client");
    });

    it("should receive state broadcasts from server", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onStateUpdate = vi.fn();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-server",
              host,
              protocol,
              onStateUpdate
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Send state - server will broadcast it back
      const newState = {
        count: 456,
        items: ["broadcast"],
        lastUpdated: Date.now()
      };
      capturedAgent!.setState(newState);

      // Wait for server broadcast
      await vi.waitFor(
        () => {
          const serverCall = onStateUpdate.mock.calls.find(
            ([, source]) => source === "server"
          );
          expect(serverCall).toBeDefined();
        },
        { timeout: 5000 }
      );
    });

    it("should receive initial state from server on connect", async () => {
      const { host, protocol } = getTestWorkerHost();

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-initial",
              host,
              protocol
            }}
            onAgent={() => {}}
          />
        </SuspenseWrapper>
      );

      // TestStateAgent has initialState, so server sends it on connect
      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          expect(stateEl?.textContent).not.toBe("undefined");
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(0);
          expect(rendered.items).toEqual([]);
        },
        { timeout: 10000 }
      );
    });

    it("should update state property on client setState", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-prop-client",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      const newState = { count: 42, items: ["test"], lastUpdated: 1000 };
      capturedAgent!.setState(newState);

      // state should be rendered in the DOM after re-render
      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          expect(stateEl?.textContent).not.toBe("undefined");
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(42);
          expect(rendered.items).toEqual(["test"]);
        },
        { timeout: 5000 }
      );
    });

    it("should update state property on server broadcast", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-prop-server",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Send state — server will broadcast back, which updates agent.state
      const newState = {
        count: 999,
        items: ["server-state"],
        lastUpdated: 2000
      };
      capturedAgent!.setState(newState);

      // Wait for the server broadcast to update state (second render)
      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(999);
        },
        { timeout: 5000 }
      );
    });

    it("should track multiple sequential state updates", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-sequential",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // First update
      capturedAgent!.setState({ count: 1, items: ["first"], lastUpdated: 1 });

      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(1);
        },
        { timeout: 5000 }
      );

      // Second update
      capturedAgent!.setState({ count: 2, items: ["second"], lastUpdated: 2 });

      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(2);
          expect(rendered.items).toEqual(["second"]);
        },
        { timeout: 5000 }
      );
    });

    it("should allow spreading agent.state for partial updates", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-spread",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Set initial state
      capturedAgent!.setState({
        count: 10,
        items: ["a", "b"],
        lastUpdated: 100
      });

      // Wait for the specific state value to render (not just "not undefined",
      // since the server also sends initial state on connect)
      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(10);
          expect(rendered.items).toEqual(["a", "b"]);
        },
        { timeout: 5000 }
      );

      // Spread existing state and update one field — the key use case from the issue
      capturedAgent!.setState({
        ...capturedAgent!.state,
        count: 20
      });

      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(20);
          // items should be preserved from the spread
          expect(rendered.items).toEqual(["a", "b"]);
          expect(rendered.lastUpdated).toBe(100);
        },
        { timeout: 5000 }
      );
    });

    it("should update agent.state on next render after setState", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-render",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      const newState = { count: 50, items: ["render"], lastUpdated: 50 };
      capturedAgent!.setState(newState);

      // agent.state updates on re-render (React semantics), not synchronously
      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(50);
          expect(rendered.items).toEqual(["render"]);
        },
        { timeout: 5000 }
      );
    });

    it("should call onStateUpdate AND update state property", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onStateUpdate = vi.fn();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <StateTrackingComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-state-both",
              host,
              protocol,
              onStateUpdate
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      const newState = { count: 77, items: ["both"], lastUpdated: 7 };
      capturedAgent!.setState(newState);

      // onStateUpdate callback should still be called
      expect(onStateUpdate).toHaveBeenCalledWith(newState, "client");

      // state property should also be updated
      await vi.waitFor(
        () => {
          const stateEl = container.querySelector(
            '[data-testid="agent-state"]'
          );
          const rendered = JSON.parse(stateEl!.textContent!);
          expect(rendered.count).toBe(77);
        },
        { timeout: 5000 }
      );
    });
  });

  describe("RPC calls", () => {
    it("should call methods via call()", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestCallableAgent",
              name: "hook-test-rpc-call",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Call method via call()
      const result = await capturedAgent!.call("add", [10, 20]);
      expect(result).toBe(30);
    });

    it("should call methods via stub proxy", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestCallableAgent",
              name: "hook-test-rpc-stub",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Call method via stub proxy
      const result = await (
        capturedAgent!.stub as {
          add: (a: number, b: number) => Promise<number>;
        }
      ).add(5, 7);
      expect(result).toBe(12);
    });

    it("should handle RPC errors", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestCallableAgent",
              name: "hook-test-rpc-error",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Call method that throws
      await expect(
        capturedAgent!.call("throwError", ["test error"])
      ).rejects.toThrow();
    });

    it("should support streaming RPC", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;
      const chunks: unknown[] = [];
      const onChunk = vi.fn((chunk) => chunks.push(chunk));
      const onDone = vi.fn();

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestCallableAgent",
              name: "hook-test-rpc-stream",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Call streaming method
      const result = await capturedAgent!.call("streamNumbers", [5], {
        onChunk,
        onDone
      });

      expect(onChunk.mock.calls.length).toBeGreaterThan(0);
      expect(onDone).toHaveBeenCalled();
      expect(result).toBe(5); // streamNumbers ends with count
    });
  });

  describe("query parameters", () => {
    it("should pass static query params", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-query",
              host,
              protocol,
              query: { foo: "bar", baz: "qux" }
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Connection should succeed with query params
      expect(capturedAgent!.identified).toBe(true);
    });

    // TODO: This test has a React Suspense/act timing issue in vitest-browser-react
    // The async query triggers suspense but the act scope isn't properly awaited
    it.skip("should support async query function", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;
      const queryFn = vi.fn(async () => {
        return { token: "test-token" };
      });

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "hook-test-async-query",
              host,
              protocol,
              query: queryFn
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      expect(queryFn).toHaveBeenCalled();
      expect(capturedAgent!.identified).toBe(true);
    });
  });

  describe("basePath routing", () => {
    it("should connect and receive identity via basePath", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onIdentity = vi.fn();
      let capturedAgent: TestAgent | null = null;

      const instanceName = `basepath-hook-${Date.now()}`;

      const { container } = await render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: instanceName,
              host,
              protocol,
              basePath: `custom-state/${instanceName}`,
              onIdentity
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          const status = container.querySelector(
            '[data-testid="agent-status"]'
          );
          expect(status?.textContent).toBe("connected");
        },
        { timeout: 10000 }
      );

      expect(capturedAgent).not.toBeNull();
      expect(capturedAgent!.identified).toBe(true);
      // Server should send back the correct identity
      expect(onIdentity).toHaveBeenCalledWith(instanceName, "test-state-agent");
    });

    it("should connect via server-determined basePath routing", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onIdentity = vi.fn();
      let capturedAgent: TestAgent | null = null;

      const { container } = await render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              host,
              protocol,
              basePath: "user",
              onIdentity
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          const status = container.querySelector(
            '[data-testid="agent-status"]'
          );
          expect(status?.textContent).toBe("connected");
        },
        { timeout: 10000 }
      );

      expect(capturedAgent).not.toBeNull();
      expect(capturedAgent!.identified).toBe(true);
      // Server routes /user to "auth-user" instance
      expect(onIdentity).toHaveBeenCalledWith("auth-user", "test-state-agent");
    });
  });

  describe("stub proxy behavior", () => {
    it("should not trigger RPC for internal methods like toJSON", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestCallableAgent",
              name: "hook-test-stub-internal",
              host,
              protocol
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // These should not throw or make RPC calls
      expect(capturedAgent!.stub.toJSON).toBeUndefined();
      expect(capturedAgent!.stub.then).toBeUndefined();
      expect(capturedAgent!.stub.valueOf).toBeUndefined();

      // JSON.stringify should work without RPC
      const stringified = JSON.stringify({ stub: capturedAgent!.stub });
      expect(stringified).toBe('{"stub":{}}');
    });
  });
});
