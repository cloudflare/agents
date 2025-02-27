---
"agents-sdk": patch
---

`Agent::initialState`

You can now set an initial state for an agent

```ts
type State = {
  counter: number;
  text: string;
  color: string;
};

class MyAgent extends Agent<Env, State> {
  initialState = {
    counter: 0,
    text: "",
    color: "#3B82F6",
  };

  doSomething() {
    console.log(this.state); // {counter: 0, text: "", color: "#3B82F6"}, if you haven't set the state yet
  }
}
```

As before, this gets synced to useAgent, so you can do:

```ts
const [state, setState] = useState<State>();
const agent = useAgent<State>({
  agent: "my-agent",
  onStateUpdate: (state) => {
    setState(state);
  },
});
```
