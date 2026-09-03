/** JSON values accepted by the Codex transition kernel. */
export type KernelJson =
  | null
  | boolean
  | number
  | string
  | KernelJson[]
  | { [key: string]: KernelJson };

/** Serialized state required to advance a Codex turn. */
export type KernelCheckpoint = {
  version: number;
  thread_id: string;
  turn_id: string;
  model: string;
  phase: "waiting_for_model" | "waiting_for_tool" | "completed" | "failed";
  model_round: number;
  next_event_seq: number;
  input: KernelJson[];
  pending_calls: KernelJson[];
  final_output: string;
  response_id: string | null;
};

/** Effect result returned to the pure kernel. */
export type KernelEffectResult =
  | { type: "model"; frames: KernelJson[] }
  | { type: "tool"; output: KernelJson; success: boolean }
  | { type: "error"; message: string };

/** Command accepted by the pure kernel. */
export type KernelCommand =
  | {
      type: "start_turn";
      thread_id: string;
      turn_id: string;
      prompt: string;
      model: string;
    }
  | {
      type: "resolve_effect";
      checkpoint: KernelCheckpoint;
      effect_id: string;
      result: KernelEffectResult;
    };

/** One event emitted by a kernel transition. */
export type KernelEvent = {
  seq: number;
  type: string;
  [key: string]: KernelJson;
};

/** External work requested by the kernel. */
export type KernelAction =
  | { type: "model"; effect_id: string; request: KernelJson }
  | {
      type: "tool";
      effect_id: string;
      call_id: string;
      name: string;
      arguments: KernelJson;
    }
  | { type: "completed"; output: string }
  | { type: "failed"; message: string };

/** Result of one pure kernel transition. */
export type KernelTransition = {
  checkpoint: KernelCheckpoint;
  events: KernelEvent[];
  action: KernelAction;
};

/** Runtime capable of advancing the Codex-derived kernel. */
export interface KernelRuntime {
  /** Advance the kernel by one pure transition. */
  transition(command: KernelCommand): Promise<KernelTransition>;
}
