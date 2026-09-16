import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LiveDaemonTestObject } from "./worker";

/**
 * Runs only when a real `harnessd` (echo engine) listens at `HARNESSD_URL`:
 *   cd container && npm run build && CF_HARNESS_ENGINE=echo \
 *     CF_HARNESS_SECRET=live-secret CF_HARNESS_SESSION_ID=main \
 *     CF_HARNESS_PORT=18790 node dist/main.mjs
 */
const alive = await fetch(`${env.HARNESSD_URL}/healthz`, { method: "HEAD" })
  .then((response) => response.ok)
  .catch(() => false);

function fresh(): DurableObjectStub<LiveDaemonTestObject> {
  return env.LIVE_DAEMON_TEST.getByName(crypto.randomUUID());
}

describe.skipIf(!alive)(
  "ContainerHarnessRuntime against a live harnessd",
  () => {
    it("completes a turn over the real wire and projects the transcript", async () => {
      const stub = fresh();
      const result = await stub.run("hello from workerd");
      expect(result.status).toBe("completed");
      expect(result.stopReason).toBe("end_turn");
      expect(result.raw).toContain("echo: hello from workerd");
      expect(result.messages).toEqual([
        "hello from workerd",
        "echo: hello from workerd"
      ]);
      const types = await stub.eventTypes();
      expect(types).toContain("operation_started");
      expect(types).toContain("message_end@wire");
      expect(types).toContain("operation_settled");
      const info = await stub.info();
      expect(info.runtimeId).not.toBeNull();
      expect(info.inactivityTimeoutMs).toBeGreaterThan(0);
    });

    it("parks a permission request in the daemon and resumes on reply()", async () => {
      const stub = fresh();
      const outcome = await stub.ask("ask before running", "allow");
      expect(outcome.requestType).toBe("permission");
      expect(outcome.blocked).toBe("blocked");
      expect(outcome.accepted).toBe(true);
      expect(outcome.status).toBe("completed");
      expect(await stub.eventTypes()).toContain("extension:echo_permission");
    });

    it("resumes a turn the daemon kept running across an eviction", async () => {
      const stub = fresh();
      const operationId = await stub.startSlow();
      await evictDurableObject(stub);
      const outcome = await stub.waitFor(operationId);
      expect(outcome.status).toBe("completed");
      expect(outcome.stopReason).toBe("end_turn");
      expect(outcome.messages).toEqual([
        "slow and steady",
        "echo: slow and steady"
      ]);
      const types = await stub.eventTypes();
      expect(types.filter((type) => type === "operation_settled")).toHaveLength(
        1
      );
      expect(types.filter((type) => type === "message_end@wire")).toHaveLength(
        1
      );
    });

    it("delivers an interrupt to the daemon mid-turn", async () => {
      const stub = fresh();
      const outcome = await stub.interruptSlow();
      expect(outcome.target).toBe(outcome.operationId);
      expect(outcome.status).toBe("aborted");
      expect(outcome.stopReason).toBe("interrupted");
    });
  }
);
