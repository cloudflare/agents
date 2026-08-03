import { Suspense, act, useEffect, useState } from "react";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../chat/react";
import { useAgent } from "../react";
import { getTestWorkerHost } from "./test-config";

describe("useAgentChat initial-message address changes", () => {
  afterEach(() => cleanup());

  it("never loads a new agent address through the previous socket URL (#1864)", async () => {
    const { host, protocol } = getTestWorkerHost();
    const getInitialMessages = vi.fn(
      async (_options: { agent: string; name: string; url?: string }) => []
    );

    let changeAddress:
      | ((address: { name: string; token: string }) => void)
      | undefined;

    function TestComponent() {
      const [{ name, token }, setAddress] = useState({
        name: "address-race-a",
        token: "token-a"
      });
      useEffect(() => {
        changeAddress = setAddress;
      }, []);
      const agent = useAgent({
        agent: "TestStateAgent",
        host,
        name,
        protocol,
        query: { token }
      });
      useAgentChat({ agent, getInitialMessages, resume: false });
      return <div data-testid="ready">ready</div>;
    }

    render(
      <Suspense fallback="loading">
        <TestComponent />
      </Suspense>
    );

    await vi.waitFor(() => expect(getInitialMessages).toHaveBeenCalled());
    expect(getInitialMessages.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        name: "address-race-a",
        url: expect.stringContaining(
          "/agents/test-state-agent/address-race-a?token=token-a"
        )
      })
    );

    getInitialMessages.mockClear();
    await act(async () => {
      changeAddress?.({ name: "address-race-b", token: "token-b" });
    });

    await vi.waitFor(() => expect(getInitialMessages).toHaveBeenCalled());
    expect(getInitialMessages.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        name: "address-race-b",
        url: expect.stringContaining(
          "/agents/test-state-agent/address-race-b?token=token-b"
        )
      })
    );
  });
});
