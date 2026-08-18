import type { DurableObjectAlarmCoordinatorStorage } from "../alarm-coordinator";
import type { ChannelHostStorage } from "../host";

export function memoryStorage(
  values = new Map<string, unknown>()
): ChannelHostStorage {
  return {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async list<T>(options?: DurableObjectListOptions) {
      const entries = [...values.entries()].filter(([key]) =>
        options?.prefix ? key.startsWith(options.prefix) : true
      );
      return new Map(entries) as Map<string, T>;
    }
  } as ChannelHostStorage;
}

export function memoryAlarmStorage(
  values = new Map<string, unknown>()
): ChannelHostStorage & DurableObjectAlarmCoordinatorStorage {
  const storage = memoryStorage(values);
  let alarm: number | null = null;

  return {
    ...storage,
    async setAlarm(at: number | Date) {
      alarm = typeof at === "number" ? at : at.getTime();
    },
    async deleteAlarm() {
      alarm = null;
    },
    async transaction<T>(
      callback: (transaction: DurableObjectTransaction) => Promise<T>
    ): Promise<T> {
      const draft = new Map(values);
      const draftStorage = memoryStorage(draft);
      let draftAlarm = alarm;
      const transaction = {
        ...draftStorage,
        async setAlarm(at: number | Date) {
          draftAlarm = typeof at === "number" ? at : at.getTime();
        },
        async deleteAlarm() {
          draftAlarm = null;
        }
      } as unknown as DurableObjectTransaction;

      const result = await callback(transaction);
      values.clear();
      for (const [key, value] of draft) values.set(key, value);
      alarm = draftAlarm;
      return result;
    }
  } as ChannelHostStorage & DurableObjectAlarmCoordinatorStorage;
}
