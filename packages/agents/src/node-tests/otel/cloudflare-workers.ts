/** `cloudflare:workers` for the node project: native tracing is the model in fake-tracing.ts. */
import { createFakeTracing } from "./fake-tracing";

export const tracing = createFakeTracing();
