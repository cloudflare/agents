/**
 * Terminal state: every turn must end up on exactly one terminal status,
 * and the first terminal write must win.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestAgent } from "./worker";

function fresh(): DurableObjectStub<TestAgent> {
  return env.TINY_TEST.getByName(crypto.randomUUID());
}

describe("turn settlement", () => {
  it("settles a turn whose model round keeps failing", async () => {
    const stub = fresh();
    // Every round errors, so the step's retries are spent and the run throws.
    stub.configure({
      maxRounds: 2,
      rounds: [
        { kind: "error", message: "provider exploded" },
        { kind: "error", message: "provider exploded" },
        { kind: "error", message: "provider exploded" },
        { kind: "error", message: "provider exploded" },
        { kind: "error", message: "provider exploded" },
        { kind: "error", message: "provider exploded" }
      ]
    });

    const turn = await stub.runToSettled("this will fail", {
      timeoutMs: 25_000
    });

    // The point: not `queued`. A turn that cannot proceed must say so.
    expect(turn.status).toBe("failed");
    expect(turn.completedAt).toBeTypeOf("number");
  });

  it("keeps a completed turn's text when cancel arrives late", async () => {
    const stub = fresh();
    stub.configure({ rounds: [{ kind: "text", text: "already done" }] });

    const turn = await stub.runToSettled("finish fast");
    expect(turn.status).toBe("completed");

    // Cancelling a settled turn is a no-op, not a downgrade.
    await stub.cancel(turn.turnId);
    const after = await stub.turn(turn.turnId);

    expect(after?.status).toBe("completed");
    expect(after?.text).toBe("already done");
  });
});
