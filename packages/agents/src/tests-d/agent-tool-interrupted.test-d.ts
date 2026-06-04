/**
 * Type-level tests for the #1630 follow-up public surface:
 *  - the typed `AgentToolInterruptedReason` union,
 *  - `reason` / `childStillRunning` on `RunAgentToolResult`, `AgentToolFailure` and
 *    `AgentToolLifecycleResult`,
 *  - the `agentToolReattach*` knobs on `AgentStaticOptions`.
 *
 * These guard the machine-readable contract callers (e.g. orchestration
 * harnesses) compile against so they never have to parse the human-readable
 * `error` prose.
 */

import type {
  AgentStaticOptions,
  AgentToolFailure,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  RunAgentToolResult
} from "../index";

// ── AgentToolInterruptedReason union ───────────────────────────────

const reasons: AgentToolInterruptedReason[] = [
  "no-progress",
  "window-exceeded",
  "not-tailable",
  "inspect-timeout",
  "inspect-failed",
  "recovery-deadline"
];
void reasons;

// @ts-expect-error — values outside the union are rejected.
const badReason: AgentToolInterruptedReason = "timed-out";
void badReason;

// Exhaustive switch — adding a reason later forces every consumer to handle it.
function describeReason(reason: AgentToolInterruptedReason): string {
  switch (reason) {
    case "no-progress":
    case "window-exceeded":
    case "not-tailable":
    case "inspect-timeout":
    case "inspect-failed":
    case "recovery-deadline":
      return reason;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
void describeReason;

// ── reason / childStillRunning on the result + failure + lifecycle ─

const interrupted: RunAgentToolResult = {
  runId: "r-1",
  agentType: "Child",
  status: "interrupted",
  reason: "no-progress",
  childStillRunning: false
};
void interrupted;

// Both new fields are optional (a completed result carries neither).
const completed: RunAgentToolResult = {
  runId: "r-2",
  agentType: "Child",
  status: "completed"
};
void completed;

const wrongResultReason: RunAgentToolResult = {
  runId: "r-3",
  agentType: "Child",
  status: "interrupted",
  // @ts-expect-error — `reason` only accepts the typed union.
  reason: "nope"
};
void wrongResultReason;

const failure: AgentToolFailure = {
  ok: false,
  status: "interrupted",
  error: "interrupted",
  retryable: true,
  reason: "window-exceeded",
  childStillRunning: true
};
void failure;

const lifecycle: AgentToolLifecycleResult = {
  status: "interrupted",
  reason: "recovery-deadline",
  childStillRunning: false
};
void lifecycle;

const wrongChildStillRunning: AgentToolFailure = {
  ok: false,
  status: "interrupted",
  error: "interrupted",
  retryable: true,
  // @ts-expect-error — `childStillRunning` is a boolean.
  childStillRunning: "yes"
};
void wrongChildStillRunning;

// ── AgentStaticOptions re-attach knobs ─────────────────────────────

const options: AgentStaticOptions = {
  agentToolReattachNoProgressTimeoutMs: 120_000,
  agentToolReattachMaxWindowMs: 900_000
};
void options;

// The hard ceiling is optional and uncapped by default — `Infinity` (no
// wall-clock cap, mirroring chat-recovery's `maxRecoveryWork`) is a valid value.
const uncappedCeiling: AgentStaticOptions = {
  agentToolReattachMaxWindowMs: Number.POSITIVE_INFINITY
};
void uncappedCeiling;

const wrongOption: AgentStaticOptions = {
  // @ts-expect-error — the budget knobs are numbers (milliseconds).
  agentToolReattachNoProgressTimeoutMs: "120s"
};
void wrongOption;
