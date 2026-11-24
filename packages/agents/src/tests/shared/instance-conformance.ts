import { expect, it } from "vitest";
import { LifecycleCapability } from "../../lifecycle";
import { withCapabilityHarness } from "./capability-harness";

/**
 * One capability's line in the instance conformance test: how to build an
 * instance (default or named) and a smoke run of its own operations.
 */
export type InstanceConformanceSubject<C extends LifecycleCapability> = {
  /** The capability's kind, as it passes it to the base class. */
  readonly kind: string;
  readonly make: (name?: string) => C;
  /** Exercise tables, keys and jobs; run once per instance. */
  readonly smoke: (capability: C) => Promise<void>;
};

/** A capability with nothing of its own: what a Lifecycle stores alone. */
class NothingInstalled extends LifecycleCapability {
  constructor() {
    super("conformance-nothing");
  }
}

type Snapshot = {
  tables: string[];
  indexes: string[];
  keys: string[];
  jobs: string[];
  /** `<table> <row count>` for every table but the job queue. */
  rows: string[];
};

const FIELDS = ["tables", "indexes", "keys", "jobs", "rows"] as const;

function snapshot(storage: DurableObjectStorage): Snapshot {
  const names = (type: string) =>
    storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        type
      )
      .toArray()
      .map((row) => row.name);
  const tables = names("table");
  const jobs = tables.includes("cf_agents_jobs")
    ? storage.sql
        .exec<{ id: string; capability: string }>(
          "SELECT id, capability FROM cf_agents_jobs ORDER BY id"
        )
        .toArray()
        .map((row) => `${row.capability} ${row.id}`)
    : [];
  return {
    tables,
    indexes: names("index"),
    keys: [...storage.kv.list()].map(([key]) => key).sort(),
    jobs,
    rows: tables
      .filter((table) => table !== "cf_agents_jobs")
      .map((table) => {
        const { n } = storage.sql
          .exec<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`)
          .one();
        return `${table} ${n}`;
      })
  };
}

/**
 * Check that a named instance keeps to its own names. Install nothing but
 * the Lifecycle's own; then the default alone; then the default and
 * `probe` side by side, running each one's smoke; and compare what is
 * stored. Fails on anything the probe stored outside its names, anything
 * of the default's that changed, and any table, index or key the default
 * has that the probe has no copy of.
 */
export async function checkInstanceConformance<C extends LifecycleCapability>(
  subject: InstanceConformanceSubject<C>
): Promise<void> {
  const empty = await withCapabilityHarness(async ({ install, storage }) => {
    const { lifecycle } = install(new NothingInstalled());
    await lifecycle.start();
    return snapshot(storage);
  });
  const alone = await withCapabilityHarness(async ({ install, storage }) => {
    const capability = subject.make();
    const { lifecycle } = install(capability);
    await lifecycle.start();
    await subject.smoke(capability);
    return snapshot(storage);
  });
  const both = await withCapabilityHarness(async ({ install, storage }) => {
    const capability = subject.make();
    const probe = subject.make("probe");
    const { lifecycle } = install(capability);
    lifecycle.use(probe);
    await lifecycle.start();
    await subject.smoke(capability);
    await subject.smoke(probe);
    return snapshot(storage);
  });

  const id = `${subject.kind}/probe`;
  const added = (field: (typeof FIELDS)[number]) =>
    both[field].filter((value) => !alone[field].includes(value));
  const misplaced = [
    ...added("tables").filter((name) => !name.endsWith("__n_probe")),
    ...added("indexes").filter((name) => !name.endsWith("__n_probe")),
    ...added("keys").filter((key) => !key.startsWith(`cf_agents:${id}:`)),
    ...added("jobs").filter((job) => !job.startsWith(`${id} ${id}:`)),
    ...added("rows").filter((row) => !row.split(" ")[0]!.endsWith("__n_probe"))
  ];
  expect(misplaced, "stored by the probe instance outside its names").toEqual(
    []
  );
  for (const field of FIELDS) {
    const own = added(field);
    expect(
      both[field].filter((value) => !own.includes(value)),
      `the default instance's ${field}, next to the probe`
    ).toEqual(alone[field]);
  }
  // The Lifecycle's own (the job queue, its bookkeeping keys) belongs to
  // no instance.
  const lifecycleOwn = (field: "tables" | "indexes" | "keys", name: string) =>
    name.startsWith("cf_agents_jobs") || empty[field].includes(name);
  for (const field of ["tables", "indexes"] as const) {
    for (const name of alone[field]) {
      if (lifecycleOwn(field, name)) continue;
      expect(both[field], `the probe instance's copy of ${name}`).toContain(
        `${name}__n_probe`
      );
    }
  }
  for (const key of alone.keys) {
    if (lifecycleOwn("keys", key) || !key.startsWith("cf_agents:")) continue;
    expect(both.keys, `the probe instance's copy of ${key}`).toContain(
      `cf_agents:${id}:${key.slice("cf_agents:".length)}`
    );
  }
}

/** Register one capability's conformance test. */
export function describeInstanceConformance<C extends LifecycleCapability>(
  subject: InstanceConformanceSubject<C>
): void {
  it(`keeps a named ${subject.kind} instance apart from the default`, () =>
    checkInstanceConformance(subject));
}
