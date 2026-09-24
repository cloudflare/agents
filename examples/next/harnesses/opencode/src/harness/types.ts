import type { Streams } from "agents/streams";
import type { OpenCodeRequest } from "./machine";

export type { OpenCodeRequest };

/**
 * The example keeps a stable `OC*` surface of its own rather than
 * re-exporting OpenCode's generated types, so an SDK release that changes an
 * internal shape is absorbed in `adapters.ts` instead of rippling through the
 * capability. This mirrors how the pi example treats pi's types.
 */
export type OCJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OCJson[]
  | { readonly [key: string]: OCJson };

/** One display-ready part projected from an OpenCode message. */
export type OCPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: "pending" | "running" | "completed" | "error";
      readonly input?: OCJson;
      readonly output?: string;
      readonly error?: string;
    };

/** One display-ready message projected from an OpenCode message. */
export type OCMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly OCPart[];
  readonly timestamp: number;
};

/** A permission OpenCode is waiting on. */
export type OCPermission = {
  readonly id: string;
  readonly sessionId: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly askedAt: number;
};

/** Live event projected from OpenCode's event stream onto the durable log. */
export type OCEvent =
  | {
      readonly type: "operation_start";
      readonly operationId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "operation_end";
      readonly operationId: string;
      readonly status: "completed" | "aborted" | "failed" | "declined";
      readonly error?: { readonly code: string; readonly message: string };
      readonly endedAt: number;
    }
  | {
      readonly type: "operation_wait";
      readonly operationId: string;
      readonly reason: "permission" | "busy" | "budget";
      readonly notBefore: number;
    }
  | { readonly type: "message_start"; readonly message: OCMessage }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly name: string;
      readonly input: OCJson;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly name: string;
      readonly error: boolean;
      readonly output?: string;
    }
  | { readonly type: "permission_asked"; readonly permission: OCPermission }
  | { readonly type: "permission_replied"; readonly permissionId: string }
  | { readonly type: "message_end"; readonly messageId: string }
  | { readonly type: "transcript_reset"; readonly reason: "compaction" }
  | { readonly type: "fault"; readonly code: string; readonly message: string };

/** Point-in-time view of one OpenCode session. */
export type OCSnapshot = {
  readonly sessionId: string;
  readonly messages: readonly OCMessage[];
  readonly running: boolean;
  readonly operationId: string | null;
  readonly stream: { readonly streamId: string; readonly cursor: number } | null;
  readonly pending: readonly OCPendingSubmission[];
  readonly permissions: readonly OCPermission[];
  readonly agent: string | null;
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
};

export type OCPendingSubmission = {
  readonly operationId: string;
  readonly sessionId: string;
  readonly request: OpenCodeRequest;
  readonly submittedAt: number;
};

export type OCSubmissionReceipt = {
  readonly operationId: string;
  readonly sessionId: string;
  /** False when this operation id was already submitted or settled. */
  readonly accepted: boolean;
};

/** Configuration for the Durable Object hosted OpenCode harness. */
export type OpenCodeHarnessConfig = {
  /** Durable output. Every turn's live events land in one stream. */
  readonly streams: Streams;
  /** Inline OpenCode config (no filesystem exists in a Durable Object). */
  readonly config?: Record<string, unknown>;
  /** Plugins bundled with the Worker, passed to `OpenCodeWorkerd.create`. */
  readonly plugins?: readonly unknown[];
  /** Default agent for new turns. */
  readonly agent?: string;
  /**
   * How a permission request is resolved. `"deny"` and `"allow"` answer
   * immediately; `"ask"` parks the run and surfaces the prompt to clients.
   * @default "ask"
   */
  readonly permissions?: "ask" | "allow" | "deny";
  /**
   * Longest one drive pass holds a Durable Object invocation before parking.
   * @default 20_000
   */
  readonly passBudgetMs?: number;
};

/** Wire messages for the browser protocol. */
export type OCClientMessage =
  | { readonly type: "snapshot"; readonly id: string }
  | {
      readonly type: "subscribe";
      readonly id?: string;
      readonly streamId: string;
      readonly from?: number;
    }
  | { readonly type: "unsubscribe"; readonly id?: string; readonly streamId: string }
  | {
      readonly type: "submit";
      readonly id: string;
      readonly request: OpenCodeRequest;
    }
  | { readonly type: "abort"; readonly id: string; readonly operationId?: string }
  | { readonly type: "steer"; readonly id: string; readonly text: string }
  | {
      readonly type: "permission";
      readonly id: string;
      readonly permissionId: string;
      readonly reply: "once" | "always" | "reject";
    };

export type OCServerMessage =
  | { readonly type: "snapshot"; readonly id?: string; readonly snapshot: OCSnapshot }
  | {
      readonly type: "events";
      readonly streamId: string;
      readonly operationId: string;
      readonly seq: number;
      readonly lastSeq: number;
      readonly events: readonly OCEvent[];
    }
  | { readonly type: "event"; readonly event: OCEvent }
  | {
      readonly type: "stream_start";
      readonly streamId: string;
      readonly operationId: string;
    }
  | {
      readonly type: "stream_end";
      readonly streamId: string;
      readonly operationId: string;
    }
  | { readonly type: "result"; readonly id: string; readonly result: OCJson }
  | { readonly type: "error"; readonly id?: string; readonly message: string };
