import { describe, expect, it } from "vitest";
import { LifecycleCapability, type LifecycleJobContext } from "../../lifecycle";
import { lifecycleInstances } from "../../lifecycle/durable-object-lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";
import { describeInstanceConformance } from "../shared/instance-conformance";

/** A small capability of kind `notes`: one table, one index, one key, jobs. */
class Notes extends LifecycleCapability {
  readonly ran: string[] = [];
  readonly #table: string;
  readonly #index: string;
  readonly #versionKey: string;

  constructor(name?: string) {
    super("notes", name);
    this.#table = this.store.table("notes");
    this.#index = this.store.index("notes_tag");
    this.#versionKey = this.store.key("notes_schema_version");
  }

  onStart(): void {
    const sql = this.lifecycle.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#table} (id TEXT PRIMARY KEY, tag TEXT)`
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${this.#index} ON ${this.#table} (tag)`
    );
    this.lifecycle.storage.kv.put(this.#versionKey, 1);
  }

  async add(id: string, tag: string): Promise<void> {
    this.lifecycle.storage.sql.exec(
      `INSERT OR REPLACE INTO ${this.#table} (id, tag) VALUES (?, ?)`,
      id,
      tag
    );
    await this.lifecycle.jobs.push({
      id: `report-${id}`,
      fn: "report",
      time: Date.now() + 60_000
    });
    this.lifecycle.events.emit("note:added", { id });
  }

  ids(): string[] {
    return this.lifecycle.storage.sql
      .exec<{ id: string }>(`SELECT id FROM ${this.#table} ORDER BY id`)
      .toArray()
      .map((row) => row.id);
  }

  jobIds(): string[] {
    return this.lifecycle.jobs.list().map((job) => job.id);
  }

  pushUnnamed() {
    return this.lifecycle.jobs.push({
      fn: "report",
      time: Date.now() + 60_000
    });
  }

  cancel(id: string): Promise<boolean> {
    return this.lifecycle.jobs.cancel(id);
  }

  makeDue(id: string): Promise<boolean> {
    return this.lifecycle.jobs.reschedule(id, Date.now() - 1);
  }

  onJob({ job }: LifecycleJobContext): void {
    this.ran.push(job.id);
  }
}

/** Composes a Notes, which composes nothing; and a composer of composers. */
class NoteTaker extends LifecycleCapability {
  readonly notes: Notes;
  constructor(name?: string) {
    super("note-taker", name);
    this.notes = this.compose(new Notes(this.composedName));
  }
}

class Desk extends LifecycleCapability {
  readonly taker: NoteTaker;
  constructor() {
    super("desk");
    this.taker = this.compose(new NoteTaker(this.composedName));
  }
}

describe("capability instances", () => {
  describeInstanceConformance({
    kind: "notes",
    make: (name) => new Notes(name),
    smoke: (notes) => notes.add("n1", "t")
  });

  it("keeps two instances' rows, jobs and events apart", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const plain = new Notes();
      const audit = new Notes("audit");
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();
      const capture = captureDiagnosticsEvents(
        "agents:lifecycle",
        lifecycle.name
      );
      try {
        await plain.add("same", "t");
        await audit.add("same", "t");
        await audit.add("audit-only", "t");
      } finally {
        capture.stop();
      }

      expect(plain.ids()).toEqual(["same"]);
      expect(audit.ids()).toEqual(["audit-only", "same"]);
      // The same job id in both, each seeing its own.
      expect(plain.jobIds()).toEqual(["report-same"]);
      expect(audit.jobIds().sort()).toEqual([
        "report-audit-only",
        "report-same"
      ]);
      expect(
        storage.sql
          .exec<{ id: string; capability: string }>(
            "SELECT id, capability FROM cf_agents_jobs ORDER BY id"
          )
          .toArray()
          .map((row) => `${row.capability} ${row.id}`)
      ).toEqual([
        "notes/audit notes/audit:report-audit-only",
        "notes/audit notes/audit:report-same",
        "notes report-same"
      ]);
      expect(
        capture.events
          .filter((event) => event.type === "note:added")
          .map((event) => event.payload)
      ).toEqual([
        { id: "same" },
        { id: "same", instance: "audit" },
        { id: "audit-only", instance: "audit" }
      ]);

      // Each instance's due job reaches it, under its own id.
      await audit.makeDue("report-same");
      await lifecycle.alarm();
      expect(audit.ran).toEqual(["report-same"]);
      expect(plain.ran).toEqual([]);
    });
  });

  it("composes under a composer whose kind has characters a name cannot", async () => {
    class Report extends LifecycleCapability {
      readonly notes: Notes;
      constructor() {
        super("report_v2");
        this.notes = this.compose(new Notes(this.composedName));
      }
    }
    await withCapabilityHarness(async ({ install }) => {
      const report = new Report();
      const { lifecycle } = install(report);
      await lifecycle.start();
      await report.notes.add("r", "t");
      expect(report.notes.ids()).toEqual(["r"]);
    });
  });

  it("keeps a named instance's job pushed without an id its own", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const audit = new Notes("audit");
      const { lifecycle } = install(audit);
      await lifecycle.start();
      const job = await audit.pushUnnamed();
      expect(job.id).not.toContain("notes/audit");
      expect(
        storage.sql
          .exec<{ id: string }>("SELECT id FROM cf_agents_jobs")
          .toArray()[0]?.id
      ).toBe(`notes/audit:${job.id}`);
      expect(await audit.cancel(job.id)).toBe(true);
      expect(audit.jobIds()).toEqual([]);
    });
  });

  it("names a duplicate by kind and instance", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { lifecycle } = install(new Notes());
      expect(() => lifecycle.use(new Notes())).toThrow(
        'The default Notes is already installed. Give this one a name: new Notes({ name: "…" })'
      );
      lifecycle.use(new Notes("audit"));
      expect(() => lifecycle.use(new Notes("audit"))).toThrow(
        'Notes instance "audit" is already installed. Give this one another name: new Notes({ name: "…" })'
      );
    });
  });

  it("rejects a name that is not a plain lowercase name", () => {
    expect(() => new Notes("Audit")).toThrow(/not a valid instance name/);
    expect(() => new Notes("a".repeat(33))).toThrow(
      /not a valid instance name/
    );
  });

  it("refuses a derived @ name an app gives its own instance", async () => {
    await withCapabilityHarness(async ({ install }) => {
      // Even the very name a composer derives: only the composer may give it.
      const desk = new Desk();
      const { lifecycle } = install(desk);
      expect(() =>
        lifecycle.use(new NoteTaker(desk.taker.instanceName))
      ).toThrow(/names starting with "@" are given by a composer/);
      expect(() => lifecycle.use(new Notes("@desk"))).toThrow(
        /not a valid instance name/
      );
    });
  });

  it("installs what a capability composes first, named after its composer, two levels deep", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const desk = new Desk();
      const { lifecycle } = install(desk);
      expect(lifecycleInstances(lifecycle).installed).toEqual([
        "notes/@note-taker/@desk",
        "note-taker/@desk",
        "desk"
      ]);
      // An app's own instance with the same plain name is another one, and
      // so is what it composes.
      lifecycle.use(new NoteTaker("desk"));
      expect(lifecycleInstances(lifecycle).installed.slice(3)).toEqual([
        "notes/@note-taker/desk",
        "note-taker/desk"
      ]);
      // They start, each on tables of its own.
      await lifecycle.start();
      await desk.taker.notes.add("d", "t");
      expect(desk.taker.notes.ids()).toEqual(["d"]);
      const tables = storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cf_agents_notes%' ORDER BY name"
        )
        .toArray()
        .map((row) => row.name);
      expect(tables).toEqual([
        "cf_agents_notes__c_note_2dtaker_2f_40desk",
        "cf_agents_notes__c_note_2dtaker_2fdesk"
      ]);
    });
  });

  it("keeps and reports the jobs of an instance nobody installed", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const notes = new Notes();
      const { lifecycle } = install(notes);
      await lifecycle.start();
      await notes.add("n1", "t"); // the queue exists
      storage.sql.exec(
        `INSERT INTO cf_agents_jobs (id, capability, fn, time)
         VALUES ('notes/gone:report-x', 'notes/gone', 'report', ?)`,
        Date.now() - 1
      );
      const capture = captureDiagnosticsEvents(
        "agents:lifecycle",
        lifecycle.name
      );
      try {
        await lifecycle.alarm();
      } finally {
        capture.stop();
      }
      expect(
        capture.events.filter((event) => event.type === "capability_missing")
      ).toEqual([
        { type: "capability_missing", payload: { capability: "notes/gone" } }
      ]);
      expect(
        storage.sql
          .exec<{ id: string }>("SELECT id FROM cf_agents_jobs")
          .toArray()
          .map((row) => row.id)
      ).toContain("notes/gone:report-x");
      expect(lifecycleInstances(lifecycle, { stored: true }).stored).toEqual([
        "notes/gone"
      ]);
    });
  });
});
