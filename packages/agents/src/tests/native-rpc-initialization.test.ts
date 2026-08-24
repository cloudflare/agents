import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
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

  it("keeps synchronous connection policy hooks synchronous before startup", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.idFromName(uniqueName()));

    const result = await runInDurableObject(stub, (instance) => {
      const readonly = instance.shouldConnectionBeReadonly(
        undefined as never,
        undefined as never
      );
      const sendsProtocol = instance.shouldSendProtocolMessages(
        undefined as never,
        undefined as never
      );

      return {
        readonly,
        readonlyIsBoolean: typeof readonly === "boolean",
        sendsProtocol,
        sendsProtocolIsBoolean: typeof sendsProtocol === "boolean"
      };
    });

    expect(result).toEqual({
      readonly: false,
      readonlyIsBoolean: true,
      sendsProtocol: true,
      sendsProtocolIsBoolean: true
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

  it("initializes before a cold framework-internal RPC executes", async () => {
    const namespace = env.TestNativeRpcAgent;
    const name = uniqueName();
    const stub = namespace.get(namespace.idFromName(name));

    await (
      stub as unknown as {
        _cf_checkRunFibersForFacet(
          ownerPath: ReadonlyArray<{ className: string; name: string }>
        ): Promise<number>;
      }
    )._cf_checkRunFibersForFacet([{ className: "TestNativeRpcAgent", name }]);

    const startCount = await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.get<number>("test_start_count")
    );
    expect(startCount).toBe(1);
  });

  it("destroys a condemned cold Agent without running startup", async () => {
    const namespace = env.TestNativeRpcAgent;
    const id = namespace.idFromName(uniqueName());
    const stub = namespace.get(id);

    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.put("fail_if_started", true);
      await ctx.storage.put("cf_agents_destroy_pending", true);
      await ctx.storage.setAlarm(Date.now() + 86_400_000);
    });
    await evictDurableObject(stub);

    await runDurableObjectAlarm(stub).catch((error) => {
      if (!String(error).includes("destroyed")) throw error;
    });

    // Reaching destroy() proves startup did not intercept the alarm preamble;
    // deferred-destroy.test.ts separately verifies that teardown erases storage.
  });

  it("hydrates a migrated legacy name before application RPC", async () => {
    const namespace = env.TestNativeRpcAgent;
    // An object created by an older PartyServer release has no native
    // ctx.id.name, only the persisted __ps_name the lifecycle migrates from.
    const stub = namespace.get(namespace.newUniqueId());
    const name = uniqueName();

    // Arrange: persist the legacy name without starting the Agent.
    await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.put("__ps_name", name)
    );
    await evictDurableObject(stub);

    // Act: the first call into the cold instance is a native RPC.
    const result = await stub.applicationRpc();

    // Assert: startup resolved the legacy identity and ran before the method.
    expect(result).toMatchObject({ name, ready: true, startCount: 1 });
  });

  it("rejects a truly unnamed application RPC clearly", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(namespace.newUniqueId());

    // Agent startup requires a resolvable Durable Object name, and neither a
    // native nor a migrated legacy name exists here. Failing with the
    // lifecycle's addressing guidance is safer than preserving the old bug
    // where RPC ran against uninitialized state.
    // Invoke in-process because vitest-pool-workers reports an expected remote
    // stub rejection as an unhandled rejection even when the promise is caught.
    await expect(
      runInDurableObject(stub, (instance) => instance.applicationRpc())
    ).rejects.toThrow(/could not determine its Durable Object name/);
  });
});
