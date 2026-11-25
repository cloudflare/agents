import { useEffect, useRef } from "react";
import {
  followEventLog,
  type EventLogHandlers,
  type EventLogSocket
} from "../event-log-client";

/**
 * Follow a server event log (`declareEventLog()`) for as long as the
 * component is mounted. `onResync` gets the snapshot to rebuild from (on
 * the first subscription, and whenever missed events cannot be replayed);
 * `onEvent` gets every event after it, in seq order, across reconnects.
 * Handlers are read through a ref, so passing new functions each render
 * does not resubscribe; changing `agent` or `log` does.
 *
 * ```tsx
 * const agent = useAgent({ agent: "room", name: "lobby" });
 * const [items, setItems] = useState<Item[]>([]);
 * useEventLog<Item, Item[]>(agent, "feed", {
 *   onResync: (snapshot) => setItems(snapshot ?? []),
 *   onEvent: (item) => setItems((prev) => [...prev, item])
 * });
 * ```
 *
 * @internal Not exported yet; kept with its test until chat adopts event logs.
 */
export function useEventLog<T = unknown, S = unknown>(
  agent: EventLogSocket | null | undefined,
  log: string,
  handlers: EventLogHandlers<T, S>
): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!agent) return;
    const subscription = followEventLog<T, S>(agent, log, {
      onEvent: (data, seq) => handlersRef.current.onEvent(data, seq),
      onResync: (snapshot, seq) => handlersRef.current.onResync(snapshot, seq),
      onSynced: (seq) => handlersRef.current.onSynced?.(seq),
      onError: (error) => handlersRef.current.onError?.(error)
    });
    return () => subscription.close();
  }, [agent, log]);
}
