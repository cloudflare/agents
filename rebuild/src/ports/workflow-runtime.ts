/** Abstraction over a durable workflow engine (e.g. Cloudflare Workflows). */
export interface WorkflowRuntime {
  create(name: string, options: { id: string; params?: unknown }): Promise<void>;
  sendEvent(name: string, id: string, event: { type: string; payload?: unknown }): Promise<void>;
  terminate(name: string, id: string): Promise<void>;
  pause(name: string, id: string): Promise<void>;
  resume(name: string, id: string): Promise<void>;
  restart(name: string, id: string): Promise<void>;
  status(name: string, id: string): Promise<{ status: string; output?: unknown; error?: string } | null>;
}
