import { env } from "cloudflare:workers";

/** Real local Worker Loader adjusted only for workerd's supported child date. */
export const LOCAL_DYNAMIC_WORKER_LOADER: WorkerLoader = {
  get(name, getCode) {
    return env.LOADER.get(name, async () => ({
      ...(await getCode()),
      compatibilityDate: "2026-08-06"
    }));
  },
  load(code) {
    // ponytail: local workerd stops at 2026-08-06; remove this adapter when it supports Run's pinned 2026-08-27 child date.
    return env.LOADER.load({ ...code, compatibilityDate: "2026-08-06" });
  }
};
