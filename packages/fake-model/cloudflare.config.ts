import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

const name = process.env.FAKE_MODEL_NAME ?? "fake-model";

export default defineConfig({
  worker: {
    name,
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    env: { Cell: bindings.durableObject({ worker: name, exportName: "Cell" }) },
    exports: { Cell: exports.durableObject({ storage: "sqlite" }) },
    observability: { enabled: true }
  }
});
