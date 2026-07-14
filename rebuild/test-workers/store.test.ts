import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDurableKeyValueStore } from "../src/adapters/cloudflare/store.js";
import {
  describeKeyValueStoreContract,
  type WithStore,
} from "../src/ports/testing/kv-contract.js";

let storeCounter = 0;

const withStore: WithStore = async (fn) => {
  const id = env.STORE_TEST_AGENT.idFromName(`kv-contract-${storeCounter++}`);
  const stub = env.STORE_TEST_AGENT.get(id);
  await runInDurableObject(stub, (_instance, state) => {
    const store = createDurableKeyValueStore(state.storage);
    return fn(store);
  });
};

describeKeyValueStoreContract("durable", withStore);

describe("createDurableKeyValueStore", () => {
  it("persists values across runInDurableObject calls for the same id", async () => {
    const id = env.STORE_TEST_AGENT.idFromName("kv-persistence");
    const stub = env.STORE_TEST_AGENT.get(id);

    await runInDurableObject(stub, (_instance, state) => {
      createDurableKeyValueStore(state.storage).put("saved", { ok: true });
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(createDurableKeyValueStore(state.storage).get("saved")).toEqual({
        ok: true,
      });
    });
  });
});
