import { NotFoundError } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { KeyValueStore } from "../../ports/storage.js";

export type StateSource = { kind: "server" } | { kind: "connection"; connectionId: string };

const STATE_KEY = "state:value";
const SERVER_SOURCE: StateSource = { kind: "server" };

export interface StateContainer<State> {
  /** Returns the current state. Throws if there is neither persisted nor initial state. */
  get(): State;
  set(next: State, source?: StateSource): void;
  /** True once a value exists (persisted or fallen back to initialState). */
  initialized(): boolean;
}

export function createStateContainer<State>(deps: {
  store: KeyValueStore;
  bus: EventBus;
  initialState?: State;
  validate?: (next: State, source: StateSource) => void;
  onChanged?: (state: State, source: StateSource) => void;
  /**
   * Audit 25 §2/§3: transport exclusion used to be the container's job
   * (broadcast minus the originating connectionId). Now the container just
   * hands the full source along; the caller (Agent) is the one that knows
   * how to turn a source into a ConversationEvent origin, and an adapter
   * downstream decides exclusion when it fans the event out to connections.
   */
  broadcast?: (state: State, source: StateSource) => void;
}): StateContainer<State> {
  let loaded = false;
  let current: State | undefined;

  function ensureLoaded(): void {
    if (loaded) return;
    const stored = deps.store.get<State>(STATE_KEY);
    current = stored !== undefined ? stored : deps.initialState;
    loaded = true;
  }

  return {
    get(): State {
      ensureLoaded();
      if (current === undefined) {
        throw new NotFoundError("No state available: no persisted value and no initialState");
      }
      return current;
    },

    set(next: State, source: StateSource = SERVER_SOURCE): void {
      ensureLoaded();
      if (deps.validate) {
        deps.validate(next, source); // throws to reject; nothing applied below.
      }

      // Persist before notifying — a throwing onChanged must not unpersist.
      current = next;
      deps.store.put(STATE_KEY, next);

      deps.bus.emit("state:update", { state: next, source });
      deps.onChanged?.(next, source);

      deps.broadcast?.(next, source);
    },

    initialized(): boolean {
      ensureLoaded();
      return current !== undefined;
    },
  };
}
