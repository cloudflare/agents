/**
 * What the browser and the Durable Object agree on: the Codex runtime's
 * harness protocol and the JSON the demo's HTTP routes return. This module
 * has no runtime imports, so the client bundle and the Worker both take it.
 *
 * The conversation itself does not appear here. Prompts, transcript,
 * operations and events all ride the shared harness link
 * (`@cloudflare/agents-next-harness/protocol`); only the two demo-specific
 * reads below are Codex's own.
 */
import type {
  KernelAction,
  KernelCheckpoint,
  KernelJson
} from "./kernel-types";

export type {
  KernelAction,
  KernelCheckpoint,
  KernelJson
} from "./kernel-types";
export type { SessionMessage } from "agents/sessions";

/**
 * The vocabulary `CodexRuntime` adds to the core harness events.
 *
 * Kernel events ride as extension frames so the shared React hook keeps
 * rendering messages, tools and status the same way it does for every other
 * harness, while the demo can still show the raw Codex event stream.
 */
export type CodexProtocol = {
  event:
    | { type: "kernel_event"; event: KernelJson }
    | {
        type: "kernel_checkpoint";
        phase: string;
        modelRound: number;
        transitions: number;
        kernelMs: number;
      };
  /** Codex takes prompts and nothing else. */
  submit: { kind: never; payload: never };
  result: {
    output: string | null;
    transitions: number;
    kernelMs: number;
  };
};

/** `GET /agents/coder/:name/file`: one Workspace file read for the demo. */
export type CodexWorkspaceFile = {
  readonly path: string;
  readonly found: boolean;
  readonly content?: string;
};

/**
 * `GET /agents/coder/:name/operation/:id`: the kernel state of one
 * operation. A few hundred bytes whatever the transcript weighs.
 */
export type CodexKernelSnapshot = {
  readonly operationId: string;
  readonly checkpoint: KernelCheckpoint | null;
  readonly action: KernelAction | null;
  readonly transitions: number;
  readonly kernelMs: number;
};

/** `POST /agents/coder/:name/restart`: the object aborts after replying. */
export type CodexRestartAck = { readonly restarting: true };

/** Every demo route answers a failure with this shape. */
export type CodexRouteError = { readonly error: string };
