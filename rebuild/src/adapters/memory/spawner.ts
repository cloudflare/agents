import { AbortedError, NotFoundError } from "../../kernel/errors.js";
import type { AgentHandle, AgentSpawner } from "../../ports/agent-spawner.js";

export type AgentClassMap = Record<string, new (host: unknown) => unknown>;

interface InstanceEntry {
  instance: Record<string, unknown>;
}

/**
 * Minimal in-memory spawner: constructs real instances from a registered
 * class map, one per (className, name) pair, and dispatches call() to
 * instance methods. The app layer is expected to firm this up (real
 * per-instance port wiring, richer lifecycle) in a later wave.
 */
export function createMemoryAgentSpawner(
  classMap: AgentClassMap,
  hostFactory: (className: string, name: string) => unknown
): AgentSpawner {
  const instances = new Map<string, InstanceEntry>();
  const aborted = new Set<string>();

  function keyFor(className: string, name: string): string {
    return `${className}:${name}`;
  }

  return {
    get(className: string, name: string): AgentHandle {
      const key = keyFor(className, name);

      function ensureInstance(): InstanceEntry {
        let entry = instances.get(key);
        if (!entry) {
          const Ctor = classMap[className];
          if (!Ctor) throw new NotFoundError(`Unknown agent class: ${className}`);
          const host = hostFactory(className, name);
          const instance = new Ctor(host) as Record<string, unknown>;
          entry = { instance };
          instances.set(key, entry);
        }
        return entry;
      }

      // Constructing eagerly on get() keeps "lazy create" semantics per-key
      // (first get() for a key creates it) while still returning a handle
      // immediately.
      ensureInstance();

      return {
        className,
        name,
        async call<T>(method: string, args: unknown[]): Promise<T> {
          if (aborted.has(key)) {
            throw new AbortedError(`Agent ${className}:${name} was aborted`);
          }
          const entry = ensureInstance();
          const fn = entry.instance[method];
          if (typeof fn !== "function") {
            throw new NotFoundError(`Unknown method ${method} on ${className}`);
          }
          return (await fn.apply(entry.instance, args)) as T;
        },
        abort(): void {
          aborted.add(key);
        },
        async destroy(): Promise<void> {
          instances.delete(key);
          aborted.delete(key);
        },
      };
    },
  };
}
