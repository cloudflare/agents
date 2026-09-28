import { Suspense, act, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../chat/react";
import { useAgent } from "../react";
import { getTestWorkerHost } from "./test-config";

type Address = { name: string; token: string; host?: string };
type LoaderOptions = { agent: string; name: string; url?: string };

async function mountChat({
  initial,
  getInitialMessages,
  onIdentityChange
}: {
  initial: Address;
  getInitialMessages?: (options: LoaderOptions) => Promise<UIMessage[]>;
  onIdentityChange?: () => void;
}) {
  const { host, protocol } = getTestWorkerHost();
  const controls: {
    setAddress?: (address: Address) => void;
    agentName?: string;
    identified?: boolean;
    renders: { name: string; messageIds: string[] }[];
  } = { renders: [] };

  function TestComponent() {
    const [address, setAddress] = useState(initial);
    const { name, token } = address;
    useEffect(() => {
      controls.setAddress = setAddress;
    }, []);
    const agent = useAgent({
      agent: "TestStateAgent",
      host: address.host ?? host,
      name,
      protocol,
      query: { token },
      onIdentityChange
    });
    controls.agentName = agent.name;
    controls.identified = agent.identified;
    const { messages } = useAgentChat({
      agent,
      getInitialMessages,
      resume: false
    });
    controls.renders.push({
      name: agent.name,
      messageIds: messages.map((message) => message.id)
    });
    return <div data-testid="ready">ready</div>;
  }

  await render(
    <Suspense fallback="loading">
      <TestComponent />
    </Suspense>
  );
  // The first load suspends the component; it can only change address once
  // it has committed.
  await vi.waitFor(() => expect(controls.setAddress).toBeDefined());
  return controls;
}

function historyFor(name: string): UIMessage[] {
  return [
    {
      id: `${name}-message`,
      role: "user",
      parts: [{ type: "text", text: `hello ${name}` }]
    }
  ];
}

describe("useAgentChat when the agent address changes", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads the new agent's history through the new socket URL (#1864, #1874)", async () => {
    const getInitialMessages = vi.fn(async (options: LoaderOptions) =>
      historyFor(options.name)
    );
    const controls = await mountChat({
      initial: { name: "address-change-a", token: "token-a" },
      getInitialMessages
    });

    await vi.waitFor(() => expect(getInitialMessages).toHaveBeenCalled());
    expect(getInitialMessages.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        name: "address-change-a",
        url: expect.stringContaining(
          "/agents/test-state-agent/address-change-a?token=token-a"
        )
      })
    );

    await vi.waitFor(() =>
      expect(controls.renders.at(-1)?.messageIds).toEqual([
        "address-change-a-message"
      ])
    );

    getInitialMessages.mockClear();
    await act(async () => {
      controls.setAddress?.({ name: "address-change-b", token: "token-b" });
    });

    await vi.waitFor(() => expect(getInitialMessages).toHaveBeenCalled());
    // Every load names one agent and fetches that same agent, with its own
    // token.
    for (const [options] of getInitialMessages.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          name: "address-change-b",
          url: expect.stringContaining(
            "/agents/test-state-agent/address-change-b?token=token-b"
          )
        })
      );
    }

    await vi.waitFor(() =>
      expect(controls.renders.at(-1)?.messageIds).toEqual([
        "address-change-b-message"
      ])
    );
    // Once the new history is shown, the previous one never comes back.
    const firstB = controls.renders.findIndex(({ messageIds }) =>
      messageIds.includes("address-change-b-message")
    );
    for (const { messageIds } of controls.renders.slice(firstB)) {
      expect(messageIds).toEqual(["address-change-b-message"]);
    }
  });

  it("never sends the previous token to the new agent from the default loader", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controls = await mountChat({
      initial: { name: "address-fetch-a", token: "token-a" }
    });
    const getMessagesUrls = () =>
      fetchSpy.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/get-messages"));

    await vi.waitFor(() =>
      expect(
        getMessagesUrls().some((url) => url.includes("address-fetch-a"))
      ).toBe(true)
    );

    fetchSpy.mockClear();
    await act(async () => {
      controls.setAddress?.({ name: "address-fetch-b", token: "token-b" });
    });

    await vi.waitFor(() => expect(getMessagesUrls().length).toBeGreaterThan(0));
    for (const url of getMessagesUrls()) {
      expect(url).toContain("/agents/test-state-agent/address-fetch-b/");
      expect(url).toContain("token=token-b");
    }
  });

  it("does not report a name change as an identity change on reconnect", async () => {
    const warn = vi.spyOn(console, "warn");
    const onIdentityChange = vi.fn();
    const controls = await mountChat({
      initial: { name: "identity-a", token: "token-a" },
      getInitialMessages: async () => [],
      onIdentityChange
    });
    await vi.waitFor(() => expect(controls.identified).toBe(true));

    await act(async () => {
      controls.setAddress?.({ name: "identity-b", token: "token-a" });
    });
    // The new name is exposed before the new socket identifies.
    expect(controls.agentName).toBe("identity-b");
    await vi.waitFor(() => expect(controls.identified).toBe(true));

    expect(controls.agentName).toBe("identity-b");
    expect(onIdentityChange).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("Identity changed on reconnect")
      )
    ).toBe(false);
  });

  it("loads the new host's history when only the host changes", async () => {
    const { host } = getTestWorkerHost();
    const [hostname, port] = host.split(":");
    const otherHost = `${hostname === "localhost" ? "127.0.0.1" : "localhost"}:${port}`;
    const getInitialMessages = vi.fn(async (options: LoaderOptions) =>
      historyFor(new URL(options.url ?? "http://unknown").hostname)
    );
    const controls = await mountChat({
      initial: { name: "host-change", token: "token-a", host },
      getInitialMessages
    });
    await vi.waitFor(() =>
      expect(controls.renders.at(-1)?.messageIds).toEqual([
        `${hostname}-message`
      ])
    );

    await act(async () => {
      controls.setAddress?.({
        name: "host-change",
        token: "token-a",
        host: otherHost
      });
    });
    await vi.waitFor(() =>
      expect(controls.renders.at(-1)?.messageIds).toEqual([
        `${otherHost.split(":")[0]}-message`
      ])
    );
  });

  it("does not reload history when only the token changes (#1223)", async () => {
    const getInitialMessages = vi.fn(async (_options: LoaderOptions) => []);
    const controls = await mountChat({
      initial: { name: "token-refresh", token: "token-a" },
      getInitialMessages
    });
    await vi.waitFor(() => expect(getInitialMessages).toHaveBeenCalled());
    await vi.waitFor(() => expect(controls.identified).toBe(true));

    getInitialMessages.mockClear();
    await act(async () => {
      controls.setAddress?.({ name: "token-refresh", token: "token-b" });
    });
    await vi.waitFor(() => expect(controls.identified).toBe(true));

    expect(getInitialMessages).not.toHaveBeenCalled();
  });
});
