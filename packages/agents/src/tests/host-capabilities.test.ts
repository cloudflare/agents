import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "..";

describe("host capabilities", () => {
  describe("registerMigrations", () => {
    it("applies namespaced migrations exactly once", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "migrations-once"
      );

      await agent.applyTestMigrations();
      let state = await agent.getMigrationState();
      expect(state.ledgerRows).toBe(2);
      expect(state.seedRows).toBe(1);

      // Re-registering must not re-run the (deliberately non-idempotent)
      // seed migration.
      await agent.applyTestMigrations();
      state = await agent.getMigrationState();
      expect(state.ledgerRows).toBe(2);
      expect(state.seedRows).toBe(1);
    });
  });

  describe("kv", () => {
    it("round-trips values and lists by prefix", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "kv-roundtrip"
      );

      const result = await agent.kvRoundtrip();
      expect(result.value).toEqual({ n: 1 });
      expect(result.listed).toEqual([
        ["test-kv:a", { n: 1 }],
        ["test-kv:b", "two"]
      ]);
      expect(result.afterDelete).toBeUndefined();
    });
  });

  describe("named durable timers", () => {
    it("fires a due timer with its payload and deletes the row", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-basic"
      );

      await agent.armTimer("test:hello", 0, { n: 42 });
      // The due alarm may auto-fire before the manual trigger; either way
      // the timer must fire exactly once.
      await runDurableObjectAlarm(agent);

      await vi.waitFor(async () => {
        expect(await agent.getTimerFires()).toEqual([
          { key: "generic|test:hello", payload: { n: 42 } }
        ]);
      });
      expect(await agent.getTimerRows()).toEqual([]);
    });

    it("routes to the handler with the longest matching prefix", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-longest-prefix"
      );

      await agent.armTimer("test:specific:x", 0);
      await runDurableObjectAlarm(agent);

      await vi.waitFor(async () => {
        expect(await agent.getTimerFires()).toEqual([
          { key: "specific|test:specific:x", payload: undefined }
        ]);
      });
    });

    it("drops a due timer with no matching handler", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-unhandled"
      );

      await agent.armTimer("nobody:x", 0);
      await runDurableObjectAlarm(agent);

      await vi.waitFor(async () => {
        expect(await agent.getTimerRows()).toEqual([]);
      });
      expect(await agent.getTimerFires()).toEqual([]);
    });

    it("cancelTimer removes the pending row", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-cancel"
      );

      await agent.armTimer("test:later", 60_000);
      expect((await agent.getTimerRows()).length).toBe(1);

      await agent.disarmTimer("test:later");
      expect(await agent.getTimerRows()).toEqual([]);
    });

    it("arms the physical alarm at (or before) the timer's fire time", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-arbitration"
      );

      const before = Date.now();
      await agent.armTimer("test:future", 60_000);
      const alarm = await agent.getStoredAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm as number).toBeGreaterThan(before);
      expect(alarm as number).toBeLessThanOrEqual(before + 61_000);
    });

    it("a handler re-arming its own key survives the guarded delete", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-rearm"
      );

      await agent.armTimer("test:rearm", 0);
      await runDurableObjectAlarm(agent);

      await vi.waitFor(async () => {
        expect((await agent.getTimerFires()).length).toBe(1);
      });
      const rows = await agent.getTimerRows();
      expect(rows.length).toBe(1);
      expect(rows[0].key).toBe("test:rearm");
      expect(rows[0].fire_at).toBeGreaterThan(Date.now());
    });

    it("a throwing handler does not retry and does not break the alarm", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "timer-throws"
      );

      await agent.armTimer("test:throws:x", 0);
      await runDurableObjectAlarm(agent);
      await vi.waitFor(async () => {
        expect(await agent.getTimerRows()).toEqual([]);
      });
      expect(await agent.getTimerFires()).toEqual([]);
    });
  });

  describe("fiber recovery registry", () => {
    it("routes an interrupted fiber to its namespace handler", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "recovery-registered"
      );

      await agent.insertInterruptedFiber("f1", "test-ns:job");
      await agent.triggerFiberRecovery();

      expect(await agent.getRecoveredBy()).toBe("generic:test-ns:job");
      expect(await agent.getOrphanRowCount()).toBe(0);
    });

    it("prefers the longest matching namespace", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "recovery-longest-prefix"
      );

      await agent.insertInterruptedFiber("f2", "test-ns:special:job");
      await agent.triggerFiberRecovery();

      expect(await agent.getRecoveredBy()).toBe("special:test-ns:special:job");
    });

    it("falls back to onFiberRecovered for unclaimed names", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "recovery-fallback"
      );

      await agent.insertInterruptedFiber("f3", "other:job");
      await agent.triggerFiberRecovery();

      expect(await agent.getRecoveredBy()).toBe("fallback:other:job");
      expect(await agent.getOrphanRowCount()).toBe(0);
    });
  });

  describe("diagnostics", () => {
    it("aggregates host views and registered inspectors", async () => {
      const agent = await getAgentByName(
        env.TestHostCapabilitiesAgent,
        "diagnostics-basic"
      );

      await agent.armTimer("test:diag", 60_000, { secret: true });
      const bundle = await agent.getDiagnostics();

      expect(bundle.generatedAt).toBeGreaterThan(0);
      expect(bundle.views["test:view"]).toEqual({ hello: "world" });
      expect(bundle.views["test:throws"]).toEqual({
        error: "inspector failure"
      });
      expect(bundle.views["host:fibers"]).toEqual([]);

      const timers = bundle.views["host:timers"] as Array<
        Record<string, unknown>
      >;
      expect(timers.length).toBe(1);
      expect(timers[0].key).toBe("test:diag");
      // Scrubbed by default: no payload.
      expect("payload" in timers[0]).toBe(false);

      const unscrubbed = await agent.getDiagnostics(false);
      const rawTimers = unscrubbed.views["host:timers"] as Array<
        Record<string, unknown>
      >;
      expect(rawTimers[0].payload).toBe(JSON.stringify({ secret: true }));
    });
  });
});
