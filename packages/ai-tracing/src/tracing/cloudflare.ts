import { tracing as cloudflareTracing } from "cloudflare:workers";
import { createTracer } from "./tracer";
import type { Tracer } from "./tracer";

export const tracer: Tracer = createTracer(cloudflareTracing);
