import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { renewingStub } from "../stub-renewal";

type Settings = Promise<{ enabled: boolean }> & { enabled: Promise<boolean> };

async function settle(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: String(error) };
  }
}

describe("renewingStub", () => {
  it("reads remote properties as the stub does", async () => {
    const stub = await getAgentByName(
      env.TestWorkflowAgent,
      `renew-props-${crypto.randomUUID()}`
    );
    const native = stub as unknown as { settingsForTest: Settings };
    const renewing = renewingStub(stub, () => stub) as unknown as {
      settingsForTest: Settings;
    };

    const getter = await settle(() => renewing.settingsForTest);
    expect(getter).toEqual({ value: { enabled: true } });
    expect(getter).toEqual(await settle(() => native.settingsForTest));
    // A nested read of a plain value is not pipelined by the runtime; the
    // renewing stub fails the same way.
    expect(await settle(() => renewing.settingsForTest.enabled)).toEqual(
      await settle(() => native.settingsForTest.enabled)
    );
  });

  it("prepares a renewed stub only when a call comes, once per call", async () => {
    let prepares = 0;
    const broken = {
      ping: () => Promise.reject(new Error("reset"))
    };
    const renewing = renewingStub<{ ping(): Promise<string> }>(
      broken,
      () => ({ ping: () => Promise.resolve("pong") }),
      () => {
        prepares += 1;
        return Promise.reject(new Error("onStart failed"));
      }
    );

    await expect(renewing.ping()).rejects.toThrow("reset");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prepares).toBe(0);

    await expect(renewing.ping()).rejects.toThrow("onStart failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prepares).toBe(1);
  });
});
