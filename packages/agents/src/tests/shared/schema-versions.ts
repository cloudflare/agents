import { SCHEMA_VERSIONS_KEY } from "../../lifecycle/schema";

/**
 * Put storage back as a release before the one schema record left it for
 * capability `id`: no entry in the record, and `legacyKey` at `version`
 * (or absent). Run while the object is evicted, or follow with
 * `forgetSchemaVersion` for the live Lifecycle's copy.
 */
export function storeAsReleased(
  storage: DurableObjectStorage,
  id: string,
  legacyKey: string,
  version?: number
): void {
  const record = storage.kv.get<Record<string, number>>(SCHEMA_VERSIONS_KEY);
  if (record && id in record) {
    delete record[id];
    storage.kv.put(SCHEMA_VERSIONS_KEY, record);
  }
  if (version === undefined) storage.kv.delete(legacyKey);
  else storage.kv.put(legacyKey, version);
}

/** Capability `id`'s version in the one record, if it has one. */
export function storedSchemaVersion(
  storage: DurableObjectStorage,
  id: string
): number | undefined {
  return storage.kv.get<Record<string, number>>(SCHEMA_VERSIONS_KEY)?.[id];
}
