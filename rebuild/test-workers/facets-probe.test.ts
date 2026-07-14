import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FacetProbeRoot } from "./worker.js";

let probeCounter = 0;

function freshRoot(): DurableObjectStub<FacetProbeRoot> {
  const id = env.FACET_PROBE_ROOT.idFromName(`facet-probe-${probeCounter++}`);
  return env.FACET_PROBE_ROOT.get(id) as DurableObjectStub<FacetProbeRoot>;
}

describe("workerd facets platform probe", () => {
  it("ctx.facets.get returns a callable RPC stub, with or without startup id", async () => {
    const root = freshRoot();

    await expect(root.pingChild("no-id")).resolves.toBe("facet-pong");
    await expect(root.pingChild("with-id", true)).resolves.toBe("facet-pong");
  });

  it("function RPC arguments are callable inside the facet", async () => {
    const root = freshRoot();

    await expect(root.callFunctionArg("function-arg")).resolves.toBe(
      "root-saw:from-child"
    );
  });

  it("facet storage is isolated from root storage", async () => {
    const root = freshRoot();

    await expect(root.probeStorageIsolation("storage")).resolves.toEqual({
      childReadsRoot: null,
      rootReadsChild: null,
      childOwn: "child-value",
      rootOwn: "root-value"
    });
  });

  it("facet storage alarm writes reject in this runtime, so delivery must go through the root mux", async () => {
    const root = freshRoot();
    const at = Date.now() + 60_000;

    const result = await root.probeChildAlarm("alarm", at);
    expect(result.resolved).toBe(false);
    expect(result.readBack).toBeNull();
    expect(result.error).toContain("setAlarm is unsafe");
  });
});
