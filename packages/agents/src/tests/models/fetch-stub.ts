import { vi } from "vitest";

/** One recorded global `fetch` call. */
export interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Stubs the global `fetch` that `createAI({ accountId, apiToken })` calls,
 * recording each call and answering with `response()`. Restore it with
 * `vi.restoreAllMocks()`.
 */
export function stubFetch(response: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ init: init ?? {}, url: String(input) });
    return response();
  });
  return calls;
}

/** A recorded call's request headers, as a plain object with lowercase names. */
export function headersOf(call: FetchCall | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(call?.init.headers));
}
