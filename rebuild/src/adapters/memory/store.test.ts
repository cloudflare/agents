import {
  describeKeyValueStoreContract,
  type WithStore,
} from "../../ports/testing/kv-contract.js";
import { createMemoryKeyValueStore } from "./store.js";

const withStore: WithStore = async (fn) => {
  await fn(createMemoryKeyValueStore());
};

describeKeyValueStoreContract("memory", withStore);
