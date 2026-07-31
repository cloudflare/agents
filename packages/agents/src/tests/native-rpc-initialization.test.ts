import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function uniqueName(): string {
  return `native-rpc-${crypto.randomUUID()}`;
}

describe("native Durable Object RPC initialization", () => {
  it("does not start the Agent from derived construction", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.idFromName(uniqueName()));

    const result = await stub.applicationRpc();

    expect(result).toMatchObject({
      ready: true,
      startCount: 1,
      fieldInitializerObservation: "field:constructing",
      constructorObservation: "constructor:constructing"
    });
  });

  it("initializes exactly once before inherited and application RPC methods", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.idFromName(uniqueName()));

    const inheritedRpcStub = stub as unknown as {
      getMcpServers(): Promise<{ servers: Record<string, unknown> }>;
    };
    expect((await inheritedRpcStub.getMcpServers()).servers).toEqual({});
    expect(await stub.applicationRpc()).toMatchObject({
      ready: true,
      startCount: 1
    });
  });

  it("keeps the nearest non-method descriptor authoritative", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.idFromName(uniqueName()));

    expect(await stub.applicationRpc()).toMatchObject({
      shadowedValue: "nearest getter"
    });
  });

  it("recovers a setName fallback before application RPC after eviction", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.newUniqueId());
    const name = uniqueName();

    await stub.setName(name);
    expect(await stub.applicationRpc()).toMatchObject({
      name,
      ready: true,
      startCount: 1
    });

    await evictDurableObject(stub);

    expect(await stub.applicationRpc()).toMatchObject({
      name,
      ready: true,
      startCount: 2
    });
  });

  it("rejects a truly unnamed PartyServer application RPC clearly", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.newUniqueId());

    // Agent startup requires PartyServer's resolvable instance name. Raw IDs
    // are unsupported until setName() bootstraps that name; failing clearly is
    // safer than preserving the old bug where RPC ran against uninitialized state.
    // Invoke in-process because vitest-pool-workers reports an expected remote
    // stub rejection as an unhandled rejection even when the promise is caught.
    await expect(
      runInDurableObject(stub, (instance) => instance.applicationRpc())
    ).rejects.toThrow(/ctx\.id\.name is not set.*setName\(\)/);
  });
});
