export interface ObservabilityEvent {
  type: string;
  agent: string;
  name: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface EventBus {
  emit(type: string, payload?: Record<string, unknown>): void;
  subscribe(channel: string | "*", fn: (e: ObservabilityEvent) => void): () => void;
}

const CHANNEL_PREFIXES: Array<[string, string]> = [
  ["chat:recovery", "chat"],
  ["chat:transcript", "transcript"],
  ["chat:stream", "chat"],
  ["chat:context", "chat"],
  ["chat", "chat"],
  ["fiber:recovery", "fiber"],
  ["fiber", "fiber"],
  ["agent_tool", "agentTool"],
  ["schedule", "schedule"],
  ["queue", "schedule"],
  ["workflow", "workflow"],
  ["email", "email"],
  ["channel", "channel"],
  ["notice", "channel"],
  ["state", "state"],
  ["rpc", "rpc"],
  ["message", "message"],
  ["tool:result", "message"],
  ["tool:approval", "message"],
  ["tool:fetch", "tool"],
  ["tool", "tool"],
  ["connect", "lifecycle"],
  ["disconnect", "lifecycle"],
  ["destroy", "lifecycle"],
];

/** Maps an event type to its taxonomy channel. Unknown types map to "misc". */
export function channelForType(type: string): string {
  for (const [prefix, channel] of CHANNEL_PREFIXES) {
    if (type === prefix || type.startsWith(`${prefix}:`)) {
      return channel;
    }
  }
  return "misc";
}

export function createEventBus(source: { agent: string; name: string }, clock?: () => number): EventBus {
  const now = clock ?? (() => Date.now());
  const subscribers = new Map<string, Set<(e: ObservabilityEvent) => void>>();

  function subscribersFor(channel: string): Set<(e: ObservabilityEvent) => void> {
    let set = subscribers.get(channel);
    if (!set) {
      set = new Set();
      subscribers.set(channel, set);
    }
    return set;
  }

  return {
    emit(type: string, payload: Record<string, unknown> = {}): void {
      const event: ObservabilityEvent = {
        type,
        agent: source.agent,
        name: source.name,
        payload,
        timestamp: now(),
      };
      const channel = channelForType(type);
      const targets = new Set<(e: ObservabilityEvent) => void>();
      for (const fn of subscribersFor(channel)) targets.add(fn);
      for (const fn of subscribersFor("*")) targets.add(fn);
      for (const fn of targets) {
        try {
          fn(event);
        } catch {
          // Subscriber failures must not break delivery to other subscribers.
        }
      }
    },
    subscribe(channel: string | "*", fn: (e: ObservabilityEvent) => void): () => void {
      const set = subscribersFor(channel);
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
  };
}
