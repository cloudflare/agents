/**
 * tools — the tool interface bar. One contract that browser, computer, MCP,
 * workflows and subagents implement (providers), that gate/HITL, x402 and
 * telemetry wrap (middleware), and that the loop consumes (runtime).
 *
 * The claim/settle protocol for effects lives HERE, once, in the runtime —
 * not in any provider. A provider's whole durability obligation is the
 * EffectDeclaration on each descriptor (residue 1 as a declaration) plus an
 * ExternalResource for anything with an external lifecycle (residue 3).
 *
 * Async tools (subagents, workflows, long tools) return "pending": the call
 * settles later via a correlated log entry appended by the provider's inbound
 * half. Tool-out / entry-back is the ONE pattern; sync completion is its fast
 * path.
 *
 * Allowed imports: kernel, transcript, resource.
 */

import type {
  BlobRef,
  CorrelationId,
  Json,
  JSONSchema,
  TurnInfo
} from "./kernel.js";
import type { ExternalResource } from "./resource.js";
import type { SettleOutcome } from "./transcript.js";

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * Shared declaration for last-mile actions performed at least once when safe,
 * or at most once when repeating would be worse than losing the action.
 */
export type RetryContract = "at-least-once" | "at-most-once";

/**
 * The durability facts about executing this tool. This declaration is what
 * lets the runtime run claim/settle generically; a wrong declaration is the
 * one durability bug the framework cannot catch.
 */
export type EffectDeclaration =
  /** Read-only work is replay-safe and needs no claim. */
  | { readonly effect: "readonly" }
  /** Mutating work declares whether retry is safe and may supply a dedupe key. */
  | {
      readonly effect: "mutating";
      readonly retry: RetryContract;
      key?(input: Json): string;
    };

export interface ApprovalDescriptor {
  readonly title: string;
  readonly detail?: string;
  readonly input: Json;
}

/**
 * Conditional approval ("ask only when...") is NOT a descriptor mode: it
 * composes as a ToolMiddleware that rewrites descriptors' approval between
 * always and never based on its own policy (ADR 0004). Tools declare the
 * unconditional truth; middleware, where authority already composes, bends it.
 */
export interface ApprovalRequirement {
  readonly mode: "always" | "never";
  describe?(input: Json): ApprovalDescriptor;
}

export interface ToolDescriptor {
  /** Namespaced "<provider>/<tool>", unique across the merged catalog. */
  readonly name: string;
  readonly description: string;
  readonly input: JSONSchema;
  readonly effect: EffectDeclaration;
  readonly approval?: ApprovalRequirement;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: Json;
}

export interface ToolExecutionDeps {
  readonly turn: TurnInfo;
  readonly correlation: CorrelationId;
  readonly signal: AbortSignal;
  /** Externalize large outputs instead of returning them inline. */
  putBlob(
    data: Uint8Array | ReadableStream<Uint8Array>,
    meta: { mediaType: string }
  ): Promise<BlobRef>;
}

export type ToolExecutionResult =
  | { readonly status: "completed"; readonly output: Json | BlobRef }
  /**
   * The effect outlives this call. The provider's inbound half MUST later
   * append an entry carrying this correlation; the runtime settles the claim
   * from it. Detached agent tools and workflows are this, not a subsystem.
   */
  | { readonly status: "pending"; readonly correlation: CorrelationId }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly retryable: boolean;
    };

/** What tool authors implement. */
export interface ToolProvider {
  readonly name: string;
  catalog(): Promise<readonly ToolDescriptor[]>;
  execute(
    call: ToolCall,
    deps: ToolExecutionDeps
  ): Promise<ToolExecutionResult>;
  /** External-lifecycle resources this provider depends on (residue 3). */
  readonly resources?: readonly ExternalResource[];
}

/**
 * Cross-cutting wrappers — gate/HITL, x402 payment, telemetry, allow/deny
 * policy. Composition order is the authority order.
 */
export type ToolMiddleware = (next: ToolProvider) => ToolProvider;

// ---------------------------------------------------------------------------
// Runtime (what the loop sees)
// ---------------------------------------------------------------------------

export type ToolOutcome =
  /** A terminal success or error, whether fresh or recovered from the ledger. */
  | {
      readonly status: "settled";
      readonly result: SettleOutcome;
      /** 1-based execution attempt; values above 1 indicate replay. */
      readonly attempt: number;
    }
  /** Claim recorded, effect in flight; the turn should park. */
  | { readonly status: "pending"; readonly correlation: CorrelationId }
  /** Approval requested; the turn should park until the verdict entry lands. */
  | {
      readonly status: "awaiting-approval";
      readonly approval: ApprovalDescriptor;
    };

/**
 * The merged, gated catalog. execute() internally: check approval → claim →
 * provider.execute → settle. Duplicate calls (step re-runs, recovery) hit
 * the claim and return the recorded result — providers never see replays of
 * settled work.
 *
 * Enumerable by design: codemode consumes catalog() to project tools as a
 * TypeScript API; context assemblers consume it to describe capabilities in
 * the context.
 */
export interface ToolRuntime {
  catalog(): Promise<readonly ToolDescriptor[]>;
  execute(call: ToolCall): Promise<ToolOutcome>;
}
