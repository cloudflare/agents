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
  /** Virtual tables (an FTS5 index), whose shadow tables follow their name. */
  virtual: string[];
  indexes: string[];
  keys: string[];
  jobs: string[];
  /** `<table> <rows as JSON>` for every table but the job queue. */
  rows: string[];
};

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
  const virtual = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
    )
    .toArray()
    .map((row) => row.name);
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
    virtual,
    indexes: names("index"),
    // Keys and rows with their values, so an overwrite in place shows.
    keys: [...storage.kv.list()]
      .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
      .sort(),
    jobs,
    rows: tables
      .filter((table) => table !== "cf_agents_jobs")
      .map(
        (table) =>
          `${table} ${JSON.stringify(
            storage.sql.exec(`SELECT * FROM "${table}" ORDER BY 1`).toArray()
          )}`
      )
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
  // Values are compared within one run: a smoke may write times and random
  // ids, which differ from run to run. `before` is after the default's
  // smoke and before the probe's.
  const { before, both } = await withCapabilityHarness(
    async ({ install, storage }) => {
      const capability = subject.make();
      const probe = subject.make("probe");
      const { lifecycle } = install(capability);
      lifecycle.use(probe);
      await lifecycle.start();
      await subject.smoke(capability);
      const before = snapshot(storage);
      await subject.smoke(probe);
      return { before, both: snapshot(storage) };
    }
  );

  const id = `${subject.kind}/probe`;
  // FTS5 names its shadow tables by appending `_data`, `_content`, ... to
  // the virtual table's name. A capability may also name its probe index
  // other than `<name>__n_probe` (Sessions ends it in `_search` so no shadow
  // name can meet another instance's index): its copy is the probe table
  // that starts with `<name>__n_probe`, and the shadows follow that.
  const shadow = /^(.*)_(data|idx|content|docsize|config)$/;
  const isProbeName = (name: string) => /__n_probe(_|$)/.test(name);
  const probeCopy = (name: string): string => {
    const match = shadow.exec(name);
    if (match && alone.virtual.includes(match[1]!)) {
      return `${probeCopy(match[1]!)}_${match[2]}`;
    }
    if (alone.virtual.includes(name)) {
      return (
        both.virtual.find((table) => table.startsWith(`${name}__n_probe`)) ??
        `${name}__n_probe`
      );
    }
    return `${name}__n_probe`;
  };
  const keyName = (entry: string) => entry.slice(0, entry.indexOf(" "));
  const rowTable = (entry: string) => entry.slice(0, entry.indexOf(" "));
  // Names against the default alone (names do not vary by run): anything
  // the probe created, on install or in its smoke, outside its names.
  const addedNames = {
    tables: both.tables.filter((name) => !alone.tables.includes(name)),
    indexes: both.indexes.filter((name) => !alone.indexes.includes(name)),
    keys: both.keys
      .map(keyName)
      .filter((key) => !alone.keys.map(keyName).includes(key))
  };
  // Values within the run: what the probe's smoke wrote or changed.
  const changedRows = both.rows.filter((row) => !before.rows.includes(row));
  const changedKeys = both.keys.filter((key) => !before.keys.includes(key));
  const misplaced = [
    ...addedNames.tables.filter((name) => !isProbeName(name)),
    ...addedNames.indexes.filter((name) => !isProbeName(name)),
    ...addedNames.keys.filter((key) => !key.startsWith(`cf_agents:${id}:`)),
    ...changedRows.filter((row) => !isProbeName(rowTable(row))),
    ...changedKeys.filter(
      (entry) => !keyName(entry).startsWith(`cf_agents:${id}:`)
    )
  ];
  expect(misplaced, "stored by the probe instance outside its names").toEqual(
    []
  );
  for (const field of ["tables", "indexes"] as const) {
    expect(
      both[field].filter((value) => !addedNames[field].includes(value)),
      `the default instance's ${field}, next to the probe`
    ).toEqual(alone[field]);
  }
  // Jobs, whenever queued (at start too): the probe's are under its owner
  // id and prefix, and every other owner has as many jobs as with the
  // default alone. Counts, since job ids can be random.
  const owner = (job: string) => job.slice(0, job.indexOf(" "));
  const jobId = (job: string) => job.slice(job.indexOf(" ") + 1);
  expect(
    both.jobs.filter(
      (job) => owner(job) === id && !jobId(job).startsWith(`${id}:`)
    ),
    "the probe instance's jobs without its prefix"
  ).toEqual([]);
  const perOwner = (jobs: string[]) => {
    const counts: Record<string, number> = {};
    for (const job of jobs) {
      if (owner(job) === id) continue;
      counts[owner(job)] = (counts[owner(job)] ?? 0) + 1;
    }
    return counts;
  };
  expect(
    perOwner(both.jobs),
    "jobs per owner other than the probe, next to the probe"
  ).toEqual(perOwner(alone.jobs));
  // And the probe's smoke leaves every other owner's jobs as they were.
  const others = (jobs: string[]) => jobs.filter((job) => owner(job) !== id);
  expect(
    others(both.jobs),
    "other owners' jobs across the probe's smoke"
  ).toEqual(others(before.jobs));
  // The Lifecycle's own (the job queue, its bookkeeping keys) belongs to
  // no instance.
  const lifecycleOwn = (field: "tables" | "indexes" | "keys", name: string) =>
    name.startsWith("cf_agents_jobs") || empty[field].includes(name);
  for (const field of ["tables", "indexes"] as const) {
    for (const name of alone[field]) {
      if (lifecycleOwn(field, name)) continue;
      expect(both[field], `the probe instance's copy of ${name}`).toContain(
        probeCopy(name)
      );
    }
  }
  const bothKeys = both.keys.map(keyName);
  for (const entry of alone.keys) {
    const key = keyName(entry);
    if (lifecycleOwn("keys", entry) || !key.startsWith("cf_agents:")) continue;
    expect(bothKeys, `the probe instance's copy of ${key}`).toContain(
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
