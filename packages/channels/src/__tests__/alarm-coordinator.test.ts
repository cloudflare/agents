import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sharedAlarm,
  type DurableObjectAlarmCoordinatorStorage
} from "../alarm-coordinator";

type MemoryAlarmStorage = {
  storage: DurableObjectAlarmCoordinatorStorage;
  alarm(): number | null;
  records(): Map<string, unknown>;
};

function memoryAlarmStorage(): MemoryAlarmStorage {
  let values = new Map<string, unknown>();
  let scheduledAlarm: number | null = null;

  const storage = {
    async list<T>(options?: DurableObjectListOptions) {
      return filtered<T>(values, options);
    },
    async setAlarm(at: number | Date) {
      scheduledAlarm = typeof at === "number" ? at : at.getTime();
    },
    async deleteAlarm() {
      scheduledAlarm = null;
    },
    async transaction<T>(
      callback: (transaction: DurableObjectTransaction) => Promise<T>
    ) {
      const draft = new Map(values);
      let draftAlarm = scheduledAlarm;
      const transaction = {
        async get(key: string | string[]) {
          if (Array.isArray(key)) {
            return new Map(
              key.flatMap((entry) =>
                draft.has(entry) ? [[entry, draft.get(entry)]] : []
              )
            );
          }
          return draft.get(key);
        },
        async list<U>(options?: DurableObjectListOptions) {
          return filtered<U>(draft, options);
        },
        async put(key: string | Record<string, unknown>, value?: unknown) {
          if (typeof key === "string") {
            draft.set(key, structuredClone(value));
          } else {
            for (const [entryKey, entryValue] of Object.entries(key)) {
              draft.set(entryKey, structuredClone(entryValue));
            }
          }
        },
        async delete(key: string | string[]) {
          if (Array.isArray(key)) {
            let deleted = 0;
            for (const entry of key) {
              if (draft.delete(entry)) deleted++;
            }
            return deleted;
          }
          return draft.delete(key);
        },
        async setAlarm(at: number | Date) {
          draftAlarm = typeof at === "number" ? at : at.getTime();
        },
        async deleteAlarm() {
          draftAlarm = null;
        }
      } as unknown as DurableObjectTransaction;

      const result = await callback(transaction);
      values = draft;
      scheduledAlarm = draftAlarm;
      return result;
    }
  } as DurableObjectAlarmCoordinatorStorage;

  return {
    storage,
    alarm: () => scheduledAlarm,
    records: () => new Map(values)
  };
}

function filtered<T>(
  values: Map<string, unknown>,
  options?: DurableObjectListOptions
): Map<string, T> {
  return new Map(
    [...values.entries()].filter(([key]) =>
      options?.prefix ? key.startsWith(options.prefix) : true
    )
  ) as Map<string, T>;
}

function logicalRecords(storage: MemoryAlarmStorage): unknown[] {
  return [...storage.records().entries()]
    .filter(([key]) => key.startsWith("cf_alarm_coordinator:"))
    .map(([, value]) => value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DurableObjectAlarmCoordinator", () => {
  it("merges logical ids and named sources into the earliest native alarm", async () => {
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    const channels = alarms.source("channels");
    const application = alarms.source("application");

    await channels.schedule("delivery-later", 300);
    await application.schedule("daily-cleanup", 100);
    await channels.schedule("delivery-middle", 200);

    expect(memory.alarm()).toBe(100);
    expect(logicalRecords(memory)).toHaveLength(3);
  });

  it("dispatches each due source once and rearms to remaining work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(200);
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    const channels = alarms.source("channels");
    const application = alarms.source("application");
    const channelHandler = vi.fn();
    const applicationHandler = vi.fn();

    await channels.schedule("delivery-1", 100);
    await channels.schedule("delivery-2", 150);
    await application.schedule("cleanup", 300);

    await alarms.handleAlarm({
      channels: channelHandler,
      application: applicationHandler
    });

    expect(channelHandler).toHaveBeenCalledOnce();
    expect(channelHandler).toHaveBeenCalledWith(["delivery-1", "delivery-2"]);
    expect(applicationHandler).not.toHaveBeenCalled();
    expect(memory.alarm()).toBe(300);
    expect(logicalRecords(memory)).toHaveLength(1);
  });

  it("preserves a new generation scheduled by a running handler", async () => {
    vi.spyOn(Date, "now").mockReturnValue(200);
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    const channels = alarms.source("channels");
    await channels.schedule("delivery-1", 100);

    await alarms.handleAlarm({
      channels: async () => {
        await channels.schedule("delivery-1", 500);
      }
    });

    expect(memory.alarm()).toBe(500);
    expect(logicalRecords(memory)).toEqual([
      expect.objectContaining({
        source: "channels",
        id: "delivery-1",
        scheduledAt: 500
      })
    ]);
  });

  it("preserves due work and rethrows when a handler fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(200);
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    await alarms.source("application").schedule("cleanup", 100);

    await expect(
      alarms.handleAlarm({
        application: async () => {
          throw new Error("try again");
        }
      })
    ).rejects.toThrow("try again");

    expect(logicalRecords(memory)).toHaveLength(1);
  });

  it("does not dispatch an early native alarm", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    const handler = vi.fn();
    await alarms.source("channels").schedule("delivery-1", 200);

    await alarms.handleAlarm({ channels: handler });

    expect(handler).not.toHaveBeenCalled();
    expect(memory.alarm()).toBe(200);
    expect(logicalRecords(memory)).toHaveLength(1);
  });

  it("rolls back source-owned state and its logical alarm together", async () => {
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    const application = alarms.source("application");

    await expect(
      application.transaction(async (transaction) => {
        await transaction.put("application:cleanup-state", { pending: true });
        await transaction.schedule("cleanup", 400);
        throw new Error("abort transaction");
      })
    ).rejects.toThrow("abort transaction");

    expect(memory.records().has("application:cleanup-state")).toBe(false);
    expect(logicalRecords(memory)).toHaveLength(0);
    expect(memory.alarm()).toBeNull();
  });

  it("can atomically persist source-owned state with a logical alarm", async () => {
    const memory = memoryAlarmStorage();
    const alarms = sharedAlarm(memory.storage);
    const application = alarms.source("application");

    await application.transaction(async (transaction) => {
      await transaction.put("application:cleanup-state", { pending: true });
      await transaction.schedule("cleanup", 400);
    });

    expect(memory.records().get("application:cleanup-state")).toEqual({
      pending: true
    });
    expect(memory.alarm()).toBe(400);
  });
});
