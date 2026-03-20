export interface ThreadState {
  mode: "concise" | "detailed" | "creative";
}

export type Mode = ThreadState["mode"];

export const DEFAULT_MODE: Mode = "detailed";

export interface AgentState {
  initialized: boolean;
  totalMessages: number;
}
