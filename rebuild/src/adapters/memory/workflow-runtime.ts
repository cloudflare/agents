import type { WorkflowRuntime } from "../../ports/workflow-runtime.js";

type Status = { status: string; output?: unknown; error?: string };
type Event = { type: string; payload?: unknown };
type ProgressListener = (name: string, id: string, status: Status) => void;

export interface MemoryWorkflowRuntime extends WorkflowRuntime {
  /** Lets a test flip a workflow instance's status directly, notifying progress listeners. */
  setStatus(name: string, id: string, status: Status): void;
  /** Registers a hook simulating a workflow -> agent progress callback. Returns an unsubscribe function. */
  onProgress(fn: ProgressListener): () => void;
  /** Every event sent to this instance via sendEvent(), in order. */
  eventsFor(name: string, id: string): Event[];
}

function keyFor(name: string, id: string): string {
  return `${name}:${id}`;
}

export function createMemoryWorkflowRuntime(): MemoryWorkflowRuntime {
  const statuses = new Map<string, Status>();
  const events = new Map<string, Event[]>();
  const listeners = new Set<ProgressListener>();

  function notify(name: string, id: string, status: Status): void {
    for (const fn of listeners) fn(name, id, status);
  }

  return {
    async create(name: string, options: { id: string; params?: unknown }): Promise<void> {
      statuses.set(keyFor(name, options.id), { status: "running" });
      events.set(keyFor(name, options.id), []);
    },
    async sendEvent(name: string, id: string, event: Event): Promise<void> {
      const key = keyFor(name, id);
      const list = events.get(key) ?? [];
      list.push(event);
      events.set(key, list);
    },
    async terminate(name: string, id: string): Promise<void> {
      const status: Status = { status: "terminated" };
      statuses.set(keyFor(name, id), status);
      notify(name, id, status);
    },
    async pause(name: string, id: string): Promise<void> {
      const status: Status = { status: "paused" };
      statuses.set(keyFor(name, id), status);
      notify(name, id, status);
    },
    async resume(name: string, id: string): Promise<void> {
      const status: Status = { status: "running" };
      statuses.set(keyFor(name, id), status);
      notify(name, id, status);
    },
    async restart(name: string, id: string): Promise<void> {
      const status: Status = { status: "running" };
      statuses.set(keyFor(name, id), status);
      events.set(keyFor(name, id), []);
      notify(name, id, status);
    },
    async status(name: string, id: string): Promise<Status | null> {
      return statuses.get(keyFor(name, id)) ?? null;
    },
    setStatus(name: string, id: string, status: Status): void {
      statuses.set(keyFor(name, id), status);
      notify(name, id, status);
    },
    onProgress(fn: ProgressListener): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    eventsFor(name: string, id: string): Event[] {
      return events.get(keyFor(name, id)) ?? [];
    },
  };
}
