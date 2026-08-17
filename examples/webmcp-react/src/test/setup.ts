import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear() {
    values.clear();
  },
  getItem(key) {
    return values.get(key) ?? null;
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  removeItem(key) {
    values.delete(key);
  },
  setItem(key, value) {
    values.set(key, String(value));
  }
};

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage
});

beforeEach(() => {
  storage.clear();
  Reflect.deleteProperty(document, "modelContext");
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "modelContext");
});
