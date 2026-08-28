/**
 * Integration tests for useAgent's Cap'n Web transport
 * (`transport: "capnweb"`) against a real miniflare worker.
 *
 * The transport must be behaviorally identical to the default
 * hibernating transport: identity, state sync, and RPC calls all run
 * over the single Cap'n Web socket.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { Suspense, useEffect } from "react";
import { useAgent, type UseAgentOptions } from "../react";
import { getTestWorkerHost } from "./test-config";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- tests don't need strict agent typing
type TestAgent = ReturnType<typeof useAgent<any>>;

const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div>loading</div>}>{children}</Suspense>;
}

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
  }, [agent, agent.identified, agent.state, onAgent]);

  return (
    <div data-testid="agent-status">
      {agent.identified ? "connected" : "connecting"}
    </div>
  );
}

async function waitForConnected(container: Element) {
  await vi.waitFor(
    () => {
      const status = container.querySelector('[data-testid="agent-status"]');
      expect(status?.textContent).toBe("connected");
    },
    { timeout: 10000 }
  );
}

describe("useAgent with transport: capnweb", () => {
  it("connects and receives identity", async () => {
    const { host, protocol } = getTestWorkerHost();
    let capturedAgent: TestAgent | null = null;

    const { container } = await render(
      <SuspenseWrapper>
        <TestAgentComponent
          options={{
            agent: "TestStateAgent",
            name: "capnweb-hook-identity",
            host,
            protocol,
            transport: "capnweb"
          }}
          onAgent={(agent: TestAgent) => {
            capturedAgent = agent;
          }}
        />
      </SuspenseWrapper>
    );

    await waitForConnected(container);
    expect(capturedAgent!.identified).toBe(true);
    expect(capturedAgent!.name).toBe("capnweb-hook-identity");
    expect(capturedAgent!.agent).toBe("test-state-agent");
  });

  it("receives initial state and round-trips setState", async () => {
    const { host, protocol } = getTestWorkerHost();
    const onStateUpdate = vi.fn();
    let capturedAgent: TestAgent | null = null;

    const { container } = await render(
      <SuspenseWrapper>
        <TestAgentComponent
          options={{
            agent: "TestStateAgent",
            name: `capnweb-hook-state-${crypto.randomUUID()}`,
            host,
            protocol,
            transport: "capnweb",
            onStateUpdate
          }}
          onAgent={(agent: TestAgent) => {
            capturedAgent = agent;
          }}
        />
      </SuspenseWrapper>
    );

    await waitForConnected(container);

    // Initial state arrives from the server over the Cap'n Web pipe.
    await vi.waitFor(() => {
      expect(onStateUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ count: 0 }),
        "server"
      );
    });

    // setState travels client → server over the same pipe.
    capturedAgent!.setState({ count: 5, items: ["a"], lastUpdated: null });
    await vi.waitFor(() => {
      expect(onStateUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ count: 5 }),
        "client"
      );
    });
  });

  it("performs RPC calls through call() and stub", async () => {
    const { host, protocol } = getTestWorkerHost();
    let capturedAgent: TestAgent | null = null;

    const { container } = await render(
      <SuspenseWrapper>
        <TestAgentComponent
          options={{
            agent: "TestCallableAgent",
            name: "capnweb-hook-rpc",
            host,
            protocol,
            transport: "capnweb"
          }}
          onAgent={(agent: TestAgent) => {
            capturedAgent = agent;
          }}
        />
      </SuspenseWrapper>
    );

    await waitForConnected(container);

    await expect(capturedAgent!.call("add", [2, 3])).resolves.toBe(5);
    await expect(capturedAgent!.stub.add(4, 5)).resolves.toBe(9);
    await expect(capturedAgent!.call("throwError", ["boom"])).rejects.toThrow(
      "boom"
    );
  });
});
