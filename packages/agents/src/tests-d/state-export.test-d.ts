import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import { State, type StateChangeSource, type StateOptions } from "../state";

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
} satisfies StateOptions<CounterState>;

const asyncOptions = {
  onChanged: async (state, source) => {
    state satisfies CounterState;
    source satisfies StateChangeSource;
    await Promise.resolve();
  }
} satisfies StateOptions<CounterState>;

new State(asyncOptions);

class CounterObject extends DurableObject {
  readonly state = new State(options);
  readonly lifecycle = Lifecycle.install(this).use(this.state);
}

declare const object: CounterObject;
object.state satisfies DurableObjectCapability;
object.state.get() satisfies CounterState | undefined;
object.state.set({ count: 1 }) satisfies void;
