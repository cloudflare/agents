import { ValidationError } from "../../kernel/errors.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";
import type { AgentHandle, AgentSpawner } from "../../ports/agent-spawner.js";

export interface SubAgentRecord {
  className: string;
  name: string;
  createdAt: number;
}

export interface SubAgentRegistry {
  /** Lazily gets or creates the child handle; first call for a key registers it. */
  get(className: string, name: string): AgentHandle;
  has(className: string, name: string): boolean;
  /** Registered sub-agents, in creation order; optionally filtered by className. */
  list(className?: string): SubAgentRecord[];
  /** Removes the registry row and wipes the child's storage. Idempotent. */
  delete(className: string, name: string): Promise<void>;
  /** Kills the running child instance; storage (and the registry row) is kept. */
  abort(className: string, name: string, reason?: unknown): void;
}

const RESERVED_CLASS_NAME = "sub";

/** PascalCase/camelCase -> kebab-case, e.g. "SubAgent" -> "sub-agent", "Sub" -> "sub". */
function kebabCase(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function assertNotReserved(className: string): void {
  if (kebabCase(className) === RESERVED_CLASS_NAME) {
    throw new ValidationError(`"${className}" is a reserved sub-agent class name`);
  }
}

export function createSubAgentRegistry(deps: {
  store: KeyValueStore;
  spawner: AgentSpawner;
  clock: Clock;
  ids: IdSource;
}): SubAgentRegistry {
  const kv = scoped(deps.store, "sub:reg:");

  function rowKey(className: string, name: string): string {
    return `${className}:${name}`;
  }

  return {
    get(className, name) {
      assertNotReserved(className);
      const key = rowKey(className, name);
      if (!kv.get<SubAgentRecord>(key)) {
        kv.put<SubAgentRecord>(key, { className, name, createdAt: deps.clock.now() });
      }
      return deps.spawner.get(className, name);
    },

    has(className, name) {
      return kv.get<SubAgentRecord>(rowKey(className, name)) !== undefined;
    },

    list(className) {
      const rows = [...kv.list<SubAgentRecord>().values()];
      const filtered = className === undefined ? rows : rows.filter((r) => r.className === className);
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    },

    async delete(className, name) {
      kv.delete(rowKey(className, name));
      const handle = deps.spawner.get(className, name);
      await handle.destroy();
    },

    abort(className, name, reason) {
      const handle = deps.spawner.get(className, name);
      handle.abort(reason);
    },
  };
}
