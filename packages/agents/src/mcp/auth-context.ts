import { AsyncLocalStorage } from "node:async_hooks";

export interface McpAuthContext {
  props: Record<string, unknown>;
}

const authContextStorage = new AsyncLocalStorage<McpAuthContext>();

export function getMcpAuthContext(): McpAuthContext | undefined {
  return authContextStorage.getStore();
}

export function runWithAuthContext<T>(context: McpAuthContext, fn: () => T): T {
  return authContextStorage.run(context, fn);
}
