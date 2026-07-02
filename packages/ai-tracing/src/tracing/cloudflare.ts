import { tracing as cloudflareTracing } from "cloudflare:workers";
import { createTracer } from "./tracer.js";
import type { Tracer } from "./tracer.js";

export const tracer: Tracer = createTracer(cloudflareTracing);
