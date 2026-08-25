import {
  subscribe as subscribeDiagnostic,
  unsubscribe as unsubscribeDiagnostic
} from "node:diagnostics_channel";

/** One event observed on an `agents:*` diagnostics channel. */
export type CapturedDiagnosticsEvent = {
  readonly type: string;
  readonly payload: unknown;
};

/**
 * Collect diagnostics events published for one named Durable Object.
 *
 * Works for any capability channel (`agents:schedule`, `agents:mcp`, …):
 * plain Lifecycle Objects publish capability events there by default, so
 * tests can assert emitted telemetry without faking the event sink. Call
 * `stop()` in a `finally` block.
 *
 * @param channel - The diagnostics channel name, e.g. `"agents:schedule"`.
 * @param objectName - The Durable Object name events must carry.
 */
export function captureDiagnosticsEvents(
  channel: string,
  objectName: string
): {
  readonly events: CapturedDiagnosticsEvent[];
  readonly stop: () => void;
} {
  const events: CapturedDiagnosticsEvent[] = [];
  const handler = (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.name !== objectName) return;
    events.push({ type: String(record.type), payload: record.payload });
  };
  subscribeDiagnostic(channel, handler);
  return {
    events,
    stop: () => unsubscribeDiagnostic(channel, handler)
  };
}
