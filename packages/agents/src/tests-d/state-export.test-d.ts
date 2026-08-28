import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  StateManager,
  type StateChangeSource,
  type StateManagerOptions
} from "../state";

type CounterState = { count: number };

const options = {
  initialState: { count: 0 },
  validateStateChange: (state, source) => {
    state satisfies CounterState;
    source satisfies StateChangeSource;
  },
  onChanged: (state, source) => {
    state satisfies CounterState;
    source satisfies StateChangeSource;
  }
} satisfies StateManagerOptions<CounterState>;

class CounterObject extends DurableObject {
  readonly state = new StateManager(options);
  readonly lifecycle = Lifecycle.install(this).use(this.state);
}

declare const object: CounterObject;
object.state satisfies DurableObjectCapability;
object.state.get() satisfies CounterState | undefined;
object.state.set({ count: 1 }) satisfies void;
