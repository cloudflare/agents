/**
 * Schema versions for every capability in one record, and the probes a
 * legacy lift needs (STANDARDISE.md row 7).
 *
 * One KV record (`cf_agents:schema_versions`) holds each capability id's
 * version. The Lifecycle reads it once per start and writes it once when
 * something moved. A capability declares its steps and calls `migrate()`
 * from `onStart`: a start with nothing to migrate reads nothing more.
 */

/** @internal The one record of schema versions, by capability id. */
export const SCHEMA_VERSIONS_KEY = "cf_agents:schema_versions";

/**
 * @internal A capability's schema: its current version and the step that
 * brings each version up from the one before. Steps must be idempotent: a
 * reset before the record is written runs them again.
 */
export type LifecycleSchemaSteps<Step> = {
  readonly version: number;
  /** `steps[n]` takes the schema from version n-1 to n. */
  readonly steps: Readonly<Record<number, Step>>;
  /**
   * The capability's own version key from before the one record. Read
   * once, when the record has no entry for the id, and then deleted.
   */
  readonly legacyKey?: string;
};

/** @internal A capability's handle on the shared schema record. */
export type LifecycleSchema = {
  /** Run the missing steps, in order, in one transaction. */
  readonly migrateSync: (schema: LifecycleSchemaSteps<() => void>) => void;
  /** Run the missing steps in order; for steps that await (job pushes). */
  readonly migrate: (
    schema: LifecycleSchemaSteps<() => void | Promise<void>>
  ) => Promise<void>;
};

/**
 * @internal Whether table `name` exists, without reading `sqlite_master`:
 * a `LIMIT 0` read of a missing table throws, of an existing one reads no
 * row (RUNTIME-FACTS, measured).
 */
export function hasTable(sql: SqlStorage, name: string): boolean {
  try {
    sql.exec(`SELECT 1 FROM [${name}] LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/** @internal Whether `table` has column `column`, the same way. */
export function hasColumn(
  sql: SqlStorage,
  table: string,
  column: string
): boolean {
  try {
    // Brackets: a double-quoted name that is no column would be read as a
    // string instead of failing.
    sql.exec(`SELECT [${column}] FROM [${table}] LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * @internal The versions record of one Lifecycle: read once, written when
 * dirty.
 */
export class SchemaVersions {
  readonly #storage: DurableObjectStorage;
  #versions: Record<string, number> | undefined;
  #dirty = false;
  /** Legacy keys folded in, deleted with the next write. */
  readonly #folded: string[] = [];

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  #record(): Record<string, number> {
    this.#versions ??=
      this.#storage.kv.get<Record<string, number>>(SCHEMA_VERSIONS_KEY) ?? {};
    return this.#versions;
  }

  #current(id: string, legacyKey: string | undefined): number {
    const record = this.#record();
    const known = record[id];
    if (known !== undefined) return known;
    if (legacyKey === undefined) return 0;
    const legacy = this.#storage.kv.get<number>(legacyKey);
    if (legacy === undefined) return 0;
    record[id] = legacy;
    this.#dirty = true;
    this.#folded.push(legacyKey);
    return legacy;
  }

  #set(id: string, version: number): void {
    this.#record()[id] = version;
    this.#dirty = true;
  }

  /** Drop capability `id`'s version, so its steps run again from 0. */
  forget(id: string): void {
    delete this.#record()[id];
    this.#dirty = true;
    this.flush();
  }

  /** Write the record if anything moved. Returns true when it wrote. */
  flush(): boolean {
    if (!this.#dirty) return false;
    this.#storage.kv.put(SCHEMA_VERSIONS_KEY, this.#record());
    for (const key of this.#folded.splice(0)) this.#storage.kv.delete(key);
    this.#dirty = false;
    return true;
  }

  /** The handle for capability `id`; `afterChange` runs after a step. */
  forCapability(id: string, afterChange: () => void): LifecycleSchema {
    const missing = <Step>(schema: LifecycleSchemaSteps<Step>): Step[] => {
      const current = this.#current(id, schema.legacyKey);
      const steps: Step[] = [];
      for (let next = current + 1; next <= schema.version; next++) {
        const step = schema.steps[next];
        if (step) steps.push(step);
      }
      return current >= schema.version ? [] : steps;
    };
    return Object.freeze({
      migrateSync: (schema) => {
        const current = this.#current(id, schema.legacyKey);
        if (current >= schema.version) {
          afterChange();
          return;
        }
        const steps = missing(schema);
        this.#storage.transactionSync(() => {
          for (const step of steps) step();
        });
        this.#set(id, schema.version);
        afterChange();
      },
      migrate: async (schema) => {
        const current = this.#current(id, schema.legacyKey);
        if (current >= schema.version) {
          afterChange();
          return;
        }
        for (const step of missing(schema)) await step();
        this.#set(id, schema.version);
        afterChange();
      }
    });
  }
}
