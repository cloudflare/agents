/**
 * Wire contract between the browser and the Codex harness. This module is
 * imported by both the client and the Durable Object, so it must stay free of
 * runtime imports.
 */
import type { SessionMessage } from "agents/sessions";
import type { CodexOperationSnapshot } from "./codex-harness";
import type { KernelJson } from "./kernel-types";

export type { SessionMessage } from "agents/sessions";
export type { CodexOperationSnapshot } from "./codex-harness";
export type { KernelJson } from "./kernel-types";

/** A Workspace file read for the demo. */
export type CodexWorkspaceFile = {
  readonly path: string;
  readonly found: boolean;
  readonly content?: string;
};

/** One tool the kernel offers the model. */
export type CodexToolInfo = {
  readonly name: string;
  readonly description: string;
};

/** Everything the client needs to render a session on connect. */
export type CodexSessionSnapshot = {
  readonly operations: readonly CodexOperationSnapshot[];
  readonly file: CodexWorkspaceFile;
  readonly tools: readonly CodexToolInfo[];
};

/** Messages a browser sends over the WebSockets capability. */
export type CodexClientMessage =
  | { readonly type: "snapshot"; readonly id: string }
  | {
      readonly type: "submit";
      readonly id: string;
      readonly prompt: string;
      readonly operationId?: string;
    }
  | {
      /** Replay an operation's durable event stream from `from`, then tail it. */
      readonly type: "subscribe";
      readonly operationId: string;
      readonly from?: number;
    }
  | {
      /** Read one operation with its kernel checkpoint. */
      readonly type: "operation";
      readonly id: string;
      readonly operationId: string;
    }
  | {
      /** Read one transcript message, such as a tool call's input or output. */
      readonly type: "message";
      readonly id: string;
      readonly messageId: string;
    }
  | {
      /** Abort the Durable Object so the client can watch it recover. */
      readonly type: "restart";
      readonly id: string;
    };

/** Messages the Durable Object sends to a browser. */
export type CodexServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: CodexSessionSnapshot }
  | {
      /** An operation was accepted, settled, or read on demand. */
      readonly type: "operation";
      readonly id?: string;
      readonly operation: CodexOperationSnapshot;
    }
  | {
      readonly type: "events";
      readonly operationId: string;
      readonly seq: number;
      readonly lastSeq: number;
      readonly events: readonly KernelJson[];
    }
  | { readonly type: "stream_end"; readonly operationId: string }
  | {
      readonly type: "message";
      readonly id: string;
      readonly message: SessionMessage | null;
    }
  | {
      readonly type: "result";
      readonly id: string;
      readonly result: KernelJson;
    }
  | { readonly type: "error"; readonly id?: string; readonly message: string };
