const ALARM_PREFIX = "cf_alarm_coordinator:v1:";

type AlarmStorageOperations = Pick<
  DurableObjectTransaction,
  "delete" | "get" | "list" | "put"
>;

export type DurableObjectAlarmCoordinatorStorage = Pick<
  DurableObjectStorage,
  "deleteAlarm" | "list" | "setAlarm" | "transaction"
>;

export type DurableObjectAlarmSourceTransaction = AlarmStorageOperations & {
  schedule(id: string, at: number): Promise<void>;
  cancel(id: string): Promise<void>;
};

/**
 * A logical alarm scheduler. Implementations that provide `transaction` must
 * run the callback against the same storage used for `schedule`.
 */
export interface DurableObjectAlarmScheduler {
  schedule(id: string, at: number): void | Promise<void>;
  transaction?<T>(
    callback: (transaction: DurableObjectAlarmSourceTransaction) => Promise<T>
  ): Promise<T>;
}

/** A named logical alarm source sharing a Durable Object's native alarm. */
export interface DurableObjectAlarmSource extends DurableObjectAlarmScheduler {
  cancel(id: string): Promise<void>;
  transaction<T>(
    callback: (transaction: DurableObjectAlarmSourceTransaction) => Promise<T>
  ): Promise<T>;
}

export type DurableObjectAlarmHandler = (
  ids: readonly string[]
) => void | Promise<void>;

export interface DurableObjectAlarmCoordinator {
  source(name: string): DurableObjectAlarmSource;

  /**
   * Dispatch all sources with work due at the time this method starts. Each
   * handler receives the logical IDs due for its source.
   *
   * Handlers have at-least-once semantics and must be idempotent. If a handler
   * throws, due records remain intact and the error is rethrown so the Durable
   * Object alarm retry mechanism can invoke this method again.
   */
  handleAlarm(
    handlers: Readonly<Record<string, DurableObjectAlarmHandler | undefined>>
  ): Promise<void>;
}

type StoredAlarm = {
  source: string;
  id: string;
  scheduledAt: number;
  generation: string;
};

type DueAlarm = {
  key: string;
  alarm: StoredAlarm;
};

function assertName(kind: "source" | "alarm", value: string): void {
  if (value.length === 0) {
    throw new Error(`Durable Object alarm ${kind} must not be empty`);
  }
}

function assertScheduledAt(at: number): void {
  if (!Number.isFinite(at)) {
    throw new Error("Durable Object alarm time must be a finite number");
  }
}

function alarmKey(source: string, id: string): string {
  return `${ALARM_PREFIX}${encodeURIComponent(source)}:${encodeURIComponent(id)}`;
}

function isStoredAlarm(value: unknown): value is StoredAlarm {
  if (value === null || typeof value !== "object") return false;
  const alarm = value as Partial<StoredAlarm>;
  return (
    typeof alarm.source === "string" &&
    typeof alarm.id === "string" &&
    typeof alarm.scheduledAt === "number" &&
    Number.isFinite(alarm.scheduledAt) &&
    typeof alarm.generation === "string"
  );
}

class AlarmCoordinator implements DurableObjectAlarmCoordinator {
  readonly #storage: DurableObjectAlarmCoordinatorStorage;
  readonly #sources = new Map<string, DurableObjectAlarmSource>();

  constructor(storage: DurableObjectAlarmCoordinatorStorage) {
    this.#storage = storage;
  }

  source(name: string): DurableObjectAlarmSource {
    assertName("source", name);
    const existing = this.#sources.get(name);
    if (existing) return existing;

    const source = new AlarmSource(this.#storage, name);
    this.#sources.set(name, source);
    return source;
  }

  async handleAlarm(
    handlers: Readonly<Record<string, DurableObjectAlarmHandler | undefined>>
  ): Promise<void> {
    const startedAt = Date.now();
    const records = await this.#storage.list<unknown>({ prefix: ALARM_PREFIX });
    const due: DueAlarm[] = [];
    const idsBySource = new Map<string, string[]>();

    for (const [key, value] of records) {
      if (!isStoredAlarm(value) || value.scheduledAt > startedAt) continue;
      due.push({ key, alarm: value });
      const ids = idsBySource.get(value.source) ?? [];
      ids.push(value.id);
      idsBySource.set(value.source, ids);
    }

    if (due.length === 0) {
      await this.#storage.transaction(async (transaction) => {
        await rearm(transaction);
      });
      return;
    }

    for (const source of [...idsBySource.keys()].sort()) {
      const handler = handlers[source];
      if (!handler) {
        throw new Error(
          `No Durable Object alarm handler is registered for source "${source}"`
        );
      }
      await handler(idsBySource.get(source)?.sort() ?? []);
    }

    await this.#storage.transaction(async (transaction) => {
      for (const { key, alarm } of due) {
        const current = await transaction.get<unknown>(key);
        if (isStoredAlarm(current) && current.generation === alarm.generation) {
          await transaction.delete(key);
        }
      }
      await rearm(transaction);
    });
  }
}

class AlarmSource implements DurableObjectAlarmSource {
  readonly #storage: DurableObjectAlarmCoordinatorStorage;
  readonly #name: string;

  constructor(storage: DurableObjectAlarmCoordinatorStorage, name: string) {
    this.#storage = storage;
    this.#name = name;
  }

  async schedule(id: string, at: number): Promise<void> {
    await this.transaction((transaction) => transaction.schedule(id, at));
  }

  async cancel(id: string): Promise<void> {
    await this.transaction((transaction) => transaction.cancel(id));
  }

  async transaction<T>(
    callback: (transaction: DurableObjectAlarmSourceTransaction) => Promise<T>
  ): Promise<T> {
    return this.#storage.transaction(async (storageTransaction) => {
      const transaction = this.#sourceTransaction(storageTransaction);
      const result = await callback(transaction);
      await rearm(storageTransaction);
      return result;
    });
  }

  #sourceTransaction(
    transaction: DurableObjectTransaction
  ): DurableObjectAlarmSourceTransaction {
    return {
      get: transaction.get.bind(transaction),
      list: transaction.list.bind(transaction),
      put: transaction.put.bind(transaction),
      delete: transaction.delete.bind(transaction),
      schedule: async (id, at) => {
        assertName("alarm", id);
        assertScheduledAt(at);
        await transaction.put(alarmKey(this.#name, id), {
          source: this.#name,
          id,
          scheduledAt: at,
          generation: crypto.randomUUID()
        } satisfies StoredAlarm);
      },
      cancel: async (id) => {
        assertName("alarm", id);
        await transaction.delete(alarmKey(this.#name, id));
      }
    };
  }
}

async function rearm(transaction: DurableObjectTransaction): Promise<void> {
  const records = await transaction.list<unknown>({ prefix: ALARM_PREFIX });
  let earliest: number | undefined;

  for (const value of records.values()) {
    if (!isStoredAlarm(value)) continue;
    earliest =
      earliest === undefined
        ? value.scheduledAt
        : Math.min(earliest, value.scheduledAt);
  }

  if (earliest === undefined) {
    await transaction.deleteAlarm();
  } else {
    await transaction.setAlarm(earliest);
  }
}

/**
 * Coordinate named logical alarm sources through one Durable Object alarm.
 * Every owner of that native alarm must schedule through this coordinator.
 */
export function sharedAlarm(
  storage: DurableObjectAlarmCoordinatorStorage
): DurableObjectAlarmCoordinator {
  return new AlarmCoordinator(storage);
}
