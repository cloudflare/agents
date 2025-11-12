import { Agent } from "agents";
export class Stateful extends Agent<Env> {
  initialState = {
    color: "#3B82F6",
    counter: 0,
    text: ""
  };
}
