import { describe, expect, it } from "vitest";
import { Tasks } from "../../tasks";
import type { TaskStep } from "../../tasks";
import { withCapabilityHarness } from "../shared/capability-harness";
import { describeInstanceConformance } from "../shared/instance-conformance";
import { forgetSchemaVersion } from "../../lifecycle/durable-object-lifecycle";

/** Each instance's step idempotency keys, by tag. */
const stepKeys: string[] = [];

/** A Tasks whose one definition tags its output with the instance's tag. */
function tasks(tag: string, name?: string) {
  return new Tasks({
    name,
    definitions: {
      echo: async (input: { x: string }, step: TaskStep) => {
        stepKeys.push(`${tag} ${step.idempotencyKey("tag")}`);
        return step.do("tag", async () => `${tag}:${input.x}`);
      }
    }
  });
}

const count = (storage: DurableObjectStorage, table: string) =>
  storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;

/** One run to the end and one left queued (so the instance holds a job). */
async function smoke(instance: ReturnType<typeof tasks>) {
  await instance.run(
    "echo",
    { x: "1" },
    {
      runId: "invoice-1",
      lane: "chat:x",
      idempotencyKey: "k",
      retain: true
    }
  );
  await instance.wait("invoice-1", { timeoutMs: 5_000 });
  await instance.run("echo", { x: "2" }, { runId: "later", start: "alarm" });
}

describe("Tasks instances", () => {
  describeInstanceConformance({
    kind: "tasks",
    make: (name) => tasks(name ?? "default", name),
    smoke
  });

  it("keeps the default instance on the released table and index names", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle, capability } = install(tasks("default"));
      await lifecycle.start();
      await capability.run("echo", { x: "1" }, { runId: "r", start: "alarm" });
      const names = storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name LIKE 'cf_agents_task%' ORDER BY name`
        )
        .toArray()
        .map((row) => row.name);
      expect(names).toEqual([
        "cf_agents_task_parts",
        "cf_agents_task_runs",
        "cf_agents_task_runs_definition",
        "cf_agents_task_runs_idempotency_key",
        "cf_agents_task_runs_lane",
        "cf_agents_task_steps"
      ]);
      expect(
        storage.kv.get<Record<string, number>>("cf_agents:schema_versions")
          ?.tasks
      ).toBe(4);
    });
  });

  it("moves each instance's own schema key into its entry of the one record, keeping its runs", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const first = install(tasks("default"));
      const firstProbe = tasks("probe", "probe");
      first.lifecycle.use(firstProbe);
      await first.lifecycle.start();
      await first.capability.run(
        "echo",
        { x: "1" },
        { runId: "r", start: "alarm" }
      );
      await firstProbe.run("echo", { x: "2" }, { runId: "r", start: "alarm" });
      // As a released version left them: each instance's own key at 4, no
      // entry in the record.
      forgetSchemaVersion(first.lifecycle, "tasks");
      forgetSchemaVersion(first.lifecycle, "tasks/probe");
      storage.kv.put("cf_agents:tasks_schema_version", 4);
      storage.kv.put("cf_agents:tasks/probe:tasks_schema_version", 4);

      const plain = tasks("default");
      const probe = tasks("probe", "probe");
      const again = install(plain);
      again.lifecycle.use(probe);
      await again.lifecycle.start();
      const record = storage.kv.get<Record<string, number>>(
        "cf_agents:schema_versions"
      );
      expect(record?.tasks).toBe(4);
      expect(record?.["tasks/probe"]).toBe(4);
      expect(storage.kv.get("cf_agents:tasks_schema_version")).toBeUndefined();
      expect(
        storage.kv.get("cf_agents:tasks/probe:tasks_schema_version")
      ).toBeUndefined();
      await plain.runDue("echo");
      await probe.runDue("echo");
      expect(await plain.get("r")).toMatchObject({ result: "default:1" });
      expect(await probe.get("r")).toMatchObject({ result: "probe:2" });
    });
  });

  it("keeps the same run id, lane and idempotency key apart in two instances", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const plain = tasks("default");
      const probe = tasks("probe", "probe");
      const { lifecycle } = install(plain);
      lifecycle.use(probe);
      await lifecycle.start();

      const options = {
        runId: "invoice-1",
        lane: "chat:x",
        idempotencyKey: "k",
        retain: true
      };
      stepKeys.length = 0;
      await plain.run("echo", { x: "a" }, options);
      await probe.run("echo", { x: "b" }, options);
      const [a, b] = await Promise.all([
        plain.wait("invoice-1", { timeoutMs: 5_000 }),
        probe.wait("invoice-1", { timeoutMs: 5_000 })
      ]);
      expect(a).toMatchObject({ status: "completed", result: "default:a" });
      expect(b).toMatchObject({ status: "completed", result: "probe:b" });
      expect(await plain.getByIdempotencyKey("k")).toMatchObject({
        result: "default:a"
      });
      expect(await probe.getByIdempotencyKey("k")).toMatchObject({
        result: "probe:b"
      });

      // The same run id and step name never give two instances the same
      // step key; the default's is as it was.
      expect([...new Set(stepKeys)].sort()).toEqual([
        "default invoice-1:tag",
        "probe tasks/probe:invoice-1:tag"
      ]);

      // A queued run in each in the same lane, and one more each to cancel:
      // clearing the lane or cancelling in one instance leaves the other's.
      const queued = { lane: "chat:x", start: "alarm" } as const;
      await plain.run("echo", { x: "c" }, { runId: "q", ...queued });
      await probe.run("echo", { x: "d" }, { runId: "q", ...queued });
      await plain.run("echo", { x: "e" }, { runId: "c", start: "alarm" });
      await probe.run("echo", { x: "f" }, { runId: "c", start: "alarm" });
      expect(await plain.cancel("c")).toBe(true);
      expect((await probe.get("c"))?.status).toBe("pending");
      await plain.clear("chat:x");
      expect((await plain.get("q"))?.status).toBe("skipped");
      expect((await probe.get("q"))?.status).toBe("pending");
      expect((await probe.list()).map((run) => run.runId).sort()).toEqual([
        "c",
        "invoice-1",
        "q"
      ]);
      await plain.delete({});
      expect(await plain.list()).toEqual([]);
      expect(await probe.list()).toHaveLength(3);
    });
  });

  it("recovers each instance's runs with its own definitions after a restart", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const first = install(tasks("default"));
      const firstProbe = tasks("probe", "probe");
      first.lifecycle.use(firstProbe);
      await first.lifecycle.start();
      await first.capability.run(
        "echo",
        { x: "1" },
        { runId: "r", start: "alarm" }
      );
      await firstProbe.run("echo", { x: "2" }, { runId: "r", start: "alarm" });

      // A restart: new instances over the same storage.
      const plain = tasks("default");
      const probe = tasks("probe", "probe");
      const again = install(plain);
      again.lifecycle.use(probe);
      await again.lifecycle.start();
      await plain.runDue("echo");
      await probe.runDue("echo");
      expect(await plain.get("r")).toMatchObject({ result: "default:1" });
      expect(await probe.get("r")).toMatchObject({ result: "probe:2" });
    });
  });

  it("keeps a named instance's runs while it is not installed, and runs them when it is again", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const before = install(tasks("default"));
      const probe = tasks("probe", "probe");
      before.lifecycle.use(probe);
      await before.lifecycle.start();
      await probe.run("echo", { x: "1" }, { runId: "kept", start: "alarm" });

      // A deploy without it: its rows stay.
      const without = install(tasks("default"));
      await without.lifecycle.start();
      expect(count(storage, "cf_agents_task_runs__n_probe")).toBe(1);
      expect(await without.capability.get("kept")).toBeNull();
      // Its due wake is driven while it is missing, and kept for it.
      await without.lifecycle.alarm();
      const probeJobs = () =>
        storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM cf_agents_jobs WHERE capability = 'tasks/probe'"
          )
          .toArray()
          .map((row) => row.id);
      expect(probeJobs()).toEqual(["tasks/probe:task:kept"]);

      const back = tasks("probe", "probe");
      const after = install(tasks("default"));
      after.lifecycle.use(back);
      await after.lifecycle.start();
      // Its wake is still queued and reaches it through the alarm.
      await after.lifecycle.alarm();
      await back.wait("kept", { timeoutMs: 5_000 });
      expect(await back.get("kept")).toMatchObject({
        status: "completed",
        result: "probe:1"
      });
    });
  });
});
