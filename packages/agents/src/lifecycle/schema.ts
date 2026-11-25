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
  /**
   * A version kept somewhere older still, read only when neither the
   * record nor `legacyKey` has one. It removes what it read.
   */
  readonly legacyVersion?: () => number | undefined;
};

/** @internal A capability's handle on the shared schema record. */
export type LifecycleSchema = {
  /**
   * Run the missing steps, in order, in one transaction. Returns the
   * version found before them.
   */
  readonly migrateSync: (schema: LifecycleSchemaSteps<() => void>) => number;
  /** Run the missing steps in order; for steps that await (job pushes). */
  readonly migrate: (
    schema: LifecycleSchemaSteps<() => void | Promise<void>>
  ) => Promise<number>;
};

/**
 * @internal The Lifecycle's own entries. No capability kind is blank, so
 * neither id can be taken: the job queue's columns, and the host's own
 * tables (Agent's).
 */
export const LIFECYCLE_SCHEMA_ID = "";
export const HOST_SCHEMA_ID = " ";

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
  /**
   * Legacy keys folded in, by capability id, deleted with the next write.
   * Kept across a re-read: another migration may re-read while this one
   * awaits a step.
   */
  readonly #folded = new Map<string, string>();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  #record(): Record<string, number> {
    // No prototype: an id such as `constructor` is only ever its own entry.
    this.#versions ??= Object.assign(
      Object.create(null) as Record<string, number>,
      this.#storage.kv.get<Record<string, number>>(SCHEMA_VERSIONS_KEY)
    );
    return this.#versions;
  }

  /**
   * Read the record again at the next use. Outside startup a write may sit
   * in a transaction that rolls back, so a migration there trusts only
   * what storage holds.
   */
  #reread(): void {
    this.#versions = undefined;
    this.#dirty = false;
  }

  #current(id: string, schema: LifecycleSchemaSteps<unknown>): number {
    const record = this.#record();
    const known = record[id];
    if (known !== undefined) return known;
    const { legacyKey } = schema;
    const legacy =
      legacyKey === undefined
        ? undefined
        : this.#storage.kv.get<number>(legacyKey);
    if (legacy !== undefined && legacyKey !== undefined) {
      this.#folded.set(id, legacyKey);
    }
    const version = legacy ?? schema.legacyVersion?.();
    if (version === undefined) return 0;
    record[id] = version;
    this.#dirty = true;
    return version;
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
    for (const [id, key] of this.#folded) {
      // Only once the folded version is in the record being written.
      if (this.#record()[id] === undefined) continue;
      this.#storage.kv.delete(key);
      this.#folded.delete(id);
    }
    this.#dirty = false;
    return true;
  }

  /**
   * The handle for capability `id`. During startup the record is read once
   * and written by the Lifecycle at the end; otherwise each migration reads
   * it from storage and writes it at once.
   */
  forCapability(id: string, inStartup: () => boolean): LifecycleSchema {
    const afterChange = () => {
      if (!inStartup()) this.flush();
    };
    const begin = () => {
      if (!inStartup()) this.#reread();
    };
    const missing = <Step>(
      schema: LifecycleSchemaSteps<Step>,
      current: number
    ): Step[] => {
      const steps: Step[] = [];
      for (let next = current + 1; next <= schema.version; next++) {
        const step = schema.steps[next];
        if (step) steps.push(step);
      }
      return steps;
    };
    return Object.freeze({
      migrateSync: (schema) => {
        begin();
        const current = this.#current(id, schema);
        if (current < schema.version) {
          const steps = missing(schema, current);
          this.#storage.transactionSync(() => {
            for (const step of steps) step();
          });
          this.#set(id, schema.version);
        }
        afterChange();
        return current;
      },
      migrate: async (schema) => {
        begin();
        const current = this.#current(id, schema);
        if (current < schema.version) {
          for (const step of missing(schema, current)) await step();
          this.#set(id, schema.version);
        }
        afterChange();
        return current;
      }
    });
  }
}
