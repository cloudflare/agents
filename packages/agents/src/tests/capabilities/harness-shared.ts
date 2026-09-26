import type { MachineJson } from "../../state-machine";

export type TestHarnessSnapshot =
  | {
      status: "running" | "waiting" | "paused";
      revision: number;
      state: MachineJson;
      gates?: Array<{
        gateId: string;
        kind: string;
        state: string;
        expiresAt: number;
      }>;
      result?: never;
      error?: never;
    }
  | {
      status: "completed";
      revision: number;
      result?: MachineJson;
      state?: never;
      gates?: never;
      error?: never;
    }
  | {
      status: "failed" | "cancelled";
      revision: number;
      error: { name: string; message: string };
      state?: never;
      gates?: never;
      result?: never;
    };
