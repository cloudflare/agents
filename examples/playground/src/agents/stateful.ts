import { Agent } from "agents";
import type { Env } from "../server";
export class Stateful extends Agent<Env> {
  initialState = {
    counter: 0,
    text: "",
    color: "#3B82F6",
  };
}
