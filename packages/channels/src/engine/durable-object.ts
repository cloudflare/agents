import type { AgentConnector } from "../types";
import { SqliteTurnStore, type TurnRecord } from "../storage/store";
import {
  DurableTurnEngine,
  type RecoveryResolution,
  type TurnEngine
} from "./engine";
import type { TurnEngineHost } from "./host";

export interface DurableTurnEngineOptions {
  connector: AgentConnector;
  guidance?: (conversationId: string) => string | undefined;
  onRecovered?: (turn: TurnRecord, resolution: RecoveryResolution) => void;
}

/**
 * Construct a turn engine over the host Durable Object's SQLite storage,
 * lifetime extension, clock, and alarm. The adapter serializes alarm updates
 * and only moves an existing alarm earlier, so concurrent settlements cannot
 * clobber an earlier retention wake.
 */
export function createTurnEngine(
  ctx: DurableObjectState,
  options: DurableTurnEngineOptions
): TurnEngine {
  const store = new SqliteTurnStore(ctx.storage);
  const holder = ctx as DurableObjectState & {
    waitUntil?: (task: Promise<unknown>) => void;
  };
  let wakeChain: Promise<void> = Promise.resolve();

  const hold = <T>(work: Promise<T>): Promise<T> => {
    holder.waitUntil?.(
      work.then(
        () => undefined,
        () => undefined
      )
    );
    return work;
  };

  const host: TurnEngineHost = {
    holdWhile: hold,
    now: () => Date.now(),
    storage: store,
    wake: (at) => {
      wakeChain = wakeChain
        .then(async () => {
          const current = await ctx.storage.getAlarm();
          if (current === null || at < current) {
            await ctx.storage.setAlarm(at);
          }
        })
        .catch(() => undefined);
      hold(wakeChain);
    }
  };

  return new DurableTurnEngine({ ...options, host });
}
