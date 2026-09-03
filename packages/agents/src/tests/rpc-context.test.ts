import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, nativeAgentStub } from "../index";

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("contextual RPC via getAgentByName", () => {
  it("marks a Worker-side caller as external and carries context hints", async () => {
    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      unique("callee"),
      { context: { requestId: "req-1", attempt: 2, dryRun: true } }
    );

    await expect(callee.ping("hello")).resolves.toBe("pong:hello");

    const [call] = await callee.observedCalls();
    expect(call).toMatchObject({
      method: "ping",
      agentIsSelf: true,
      caller: {
        kind: "external",
        context: { requestId: "req-1", attempt: 2, dryRun: true }
      }
    });
  });

  it("identifies an Agent caller by class, session id, and name", async () => {
    const callerName = unique("caller");
    const calleeName = unique("callee");
    const caller = await getAgentByName(
      env.TestRpcContextCallerAgent,
      callerName
    );

    await expect(caller.callPeer(calleeName, { turn: "t-9" })).resolves.toBe(
      "pong:from-agent"
    );

    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      calleeName
    );
    const [call] = await callee.observedCalls();
    expect(call?.caller).toEqual({
      kind: "agent",
      className: "TestRpcContextCallerAgent",
      sessionId:
        env.TestRpcContextCallerAgent.idFromName(callerName).toString(),
      sessionName: callerName,
      context: { turn: "t-9" }
    });
  });

  it("defaults context to an empty record when none is supplied", async () => {
    const calleeName = unique("callee");
    const caller = await getAgentByName(
      env.TestRpcContextCallerAgent,
      unique("caller")
    );
    await caller.callPeer(calleeName);

    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      calleeName
    );
    const [call] = await callee.observedCalls();
    expect(call?.caller?.kind).toBe("agent");
    expect(call?.caller?.context).toEqual({});
  });

  it("leaves caller undefined on a native stub", async () => {
    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      unique("callee"),
      { rpc: "native" }
    );
    await callee.ping("raw");

    const [call] = await callee.observedCalls();
    expect(call?.caller).toBeUndefined();
    // The Agent context itself is still established for native RPC.
    expect(call?.agentIsSelf).toBe(true);
  });

  it("surfaces callee errors as rejections", async () => {
    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      unique("callee")
    );
    await expect(callee.throwing()).rejects.toThrow("callee failed on purpose");
  });

  it("refuses JS-internal probes and non-methods like a native stub", async () => {
    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      unique("callee")
    );
    // SAFETY: deliberately reaching past the typed surface to probe dispatch.
    const loose = callee as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    await expect(loose.observed()).rejects.toThrow(/not callable/);
    await expect(loose.hasOwnProperty("x")).rejects.toThrow(/not callable/);
  });

  it("unwraps to the native stub for runtime APIs", async () => {
    const callee = await getAgentByName(
      env.TestRpcContextCalleeAgent,
      unique("callee")
    );
    const raw = nativeAgentStub(callee);
    expect(raw).not.toBe(callee);
    expect(nativeAgentStub(raw)).toBe(raw);
    await raw.ping("raw");
    const [call] = await callee.observedCalls();
    expect(call?.caller).toBeUndefined();
  });

  it("keeps native stub members intact", async () => {
    const name = unique("callee");
    const callee = await getAgentByName(env.TestRpcContextCalleeAgent, name);
    expect(callee.id.toString()).toBe(
      env.TestRpcContextCalleeAgent.idFromName(name).toString()
    );
    expect(typeof callee.fetch).toBe("function");
  });
});
