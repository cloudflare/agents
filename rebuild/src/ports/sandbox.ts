import type { ErrorValue } from "../kernel/errors.js";

/** Code execution port for skills scripts and the execute tool. */
export interface Sandbox {
  run(request: {
    language: "js" | "ts" | "python" | "bash";
    source: string;
    input?: unknown;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; output?: unknown; error?: ErrorValue }>;
}
