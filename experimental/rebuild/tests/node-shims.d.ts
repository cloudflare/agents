/**
 * Minimal ambient typings for the Node built-ins the tests use, so the
 * package typechecks without @types/node (no node_modules dependency).
 */

declare module "node:test" {
  interface TestContext {
    diagnostic(message: string): void;
  }
  type TestFn = (t: TestContext) => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export { test, TestFn, TestContext };
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, regexp: RegExp, message?: string): void;
    rejects(block: () => Promise<unknown>, message?: string | RegExp | Error): Promise<void>;
    throws(block: () => unknown, message?: string | RegExp | Error): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:sqlite" {
  class StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): { changes: number };
  }
  class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export { DatabaseSync, StatementSync };
}

// setTimeout/console/queueMicrotask/ReadableStream come from lib "dom".
