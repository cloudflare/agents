// Polyfill for queueMicrotask in test environment
if (typeof globalThis.queueMicrotask === "undefined") {
  globalThis.queueMicrotask = (callback: Function) => {
    Promise.resolve().then(() => callback());
  };
}

// Also add it to the global object for Vitest
if (
  typeof global !== "undefined" &&
  typeof global.queueMicrotask === "undefined"
) {
  global.queueMicrotask = (callback: Function) => {
    Promise.resolve().then(() => callback());
  };
}
