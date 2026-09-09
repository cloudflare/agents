// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Same semantics as upstream core/event-bus.ts, reimplemented over a Map
 * because node:events is not available under workerd.
 */

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
  clear(): void;
}

export function createEventBus(): EventBusController {
  const channels = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit: (channel, data) => {
      const handlers = channels.get(channel);
      if (!handlers) return;
      // Copy first: handlers may unsubscribe (or subscribe) while emitting.
      for (const handler of [...handlers]) handler(data);
    },
    on: (channel, handler) => {
      const safeHandler = (data: unknown) => {
        try {
          const result = handler(data) as unknown;
          if (result instanceof Promise) {
            result.catch((err: unknown) => {
              console.error(`Event handler error (${channel}):`, err);
            });
          }
        } catch (err) {
          console.error(`Event handler error (${channel}):`, err);
        }
      };
      const handlers =
        channels.get(channel) ?? new Set<(data: unknown) => void>();
      handlers.add(safeHandler);
      channels.set(channel, handlers);
      return () => {
        const current = channels.get(channel);
        if (!current) return;
        current.delete(safeHandler);
        if (current.size === 0) channels.delete(channel);
      };
    },
    clear: () => {
      channels.clear();
    }
  };
}
