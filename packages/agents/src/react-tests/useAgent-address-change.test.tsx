import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAgent } from "../react";
import { getTestWorkerHost } from "./test-config";

// Socket traffic legitimately lands outside act() in these tests.
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

type Observation = {
  name: string;
  exposedName: string;
  readyThenIdentified: Promise<string>;
  call: Promise<unknown>;
};

describe("useAgent when the name changes", () => {
  it("resolves ready for the new agent's identity and routes calls to it", async () => {
    const { host, protocol } = getTestWorkerHost();
    const observations: Observation[] = [];
    let setName: ((name: string) => void) | undefined;

    function TestComponent() {
      const [name, setNameState] = useState("address-rpc-a");
      useEffect(() => {
        setName = setNameState;
      }, []);
      const agent = useAgent({
        agent: "TestCallableAgent",
        host,
        name,
        protocol
      });
      const latest = useRef(agent);
      latest.current = agent;
      // Runs in the commit where the new socket has not identified yet.
      useEffect(() => {
        observations.push({
          name,
          exposedName: agent.name,
          readyThenIdentified: agent.ready.then(() =>
            latest.current.identified ? latest.current.name : "not identified"
          ),
          call: agent.call("whoAmI")
        });
        // Only name changes are observed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [name]);
      return <div>{agent.identified ? "identified" : "connecting"}</div>;
    }

    await render(
      <Suspense fallback="loading">
        <TestComponent />
      </Suspense>
    );
    await vi.waitFor(() => expect(observations).toHaveLength(1));
    await expect(observations[0].call).resolves.toBe("address-rpc-a");

    setName?.("address-rpc-b");
    await vi.waitFor(() => expect(observations).toHaveLength(2));

    const switched = observations[1];
    expect(switched.exposedName).toBe("address-rpc-b");
    await expect(switched.call).resolves.toBe("address-rpc-b");
    await expect(switched.readyThenIdentified).resolves.toBe("address-rpc-b");
  });
});
