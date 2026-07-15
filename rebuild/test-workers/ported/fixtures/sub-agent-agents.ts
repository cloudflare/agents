import { Think, callable, hostAgent, type AgentHost } from "../compat.js";

type AgentPath = Array<{ className: string; name: string }>;
type SubAgentRecord = { className: string; name: string; createdAt: number };
type StreamCallback = (chunk: string) => void;
type TestState = { count: number; lastMsg: string };

const COUNTER_CHILD = "CounterSubAgentDO";
const CALLBACK_CHILD = "CallbackSubAgentDO";
const OUTER_CHILD = "OuterSubAgentDO";

class CounterSubAgent extends Think<TestState> {
  private readonly constructedName: string;

  constructor(host: AgentHost) {
    super(host);
    this.constructedName = this.name;
  }

  protected override getInitialState(): TestState {
    return { count: 0, lastMsg: "" };
  }

  @callable()
  ping(): string {
    return "pong";
  }

  @callable()
  increment(key: string): number {
    const storageKey = `counter:${key}`;
    const next = (this.host.store.get<number>(storageKey) ?? 0) + 1;
    this.host.store.put(storageKey, next);
    return next;
  }

  @callable()
  get(key: string): number {
    return this.host.store.get<number>(`counter:${key}`) ?? 0;
  }

  @callable()
  getName(): string {
    return this.name;
  }

  @callable()
  getConstructorName(): string {
    return this.constructedName;
  }

  @callable()
  async keepAliveWhileOk(): Promise<string> {
    return this.keepAliveWhile(async () => "ok");
  }

  @callable()
  tryCancelSchedule(): string {
    try {
      const schedule = this.schedule(60, "unusedCallback", {});
      this.cancelSchedule(schedule.id);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  @callable()
  initOk(): boolean {
    return true;
  }

  @callable()
  trySetState(
    count: number,
    lastMsg: string
  ): {
    error: string;
    persistedCount: number;
    persistedMsg: string;
  } {
    try {
      this.setState({ count, lastMsg });
      return {
        error: "",
        persistedCount: this.state.count,
        persistedMsg: this.state.lastMsg
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        persistedCount: this.state.count,
        persistedMsg: this.state.lastMsg
      };
    }
  }

  @callable()
  parentPathProbe(): AgentPath {
    return this.parentPath();
  }

  @callable()
  selfPathProbe(): AgentPath {
    return this.selfPath();
  }
}

class CallbackSubAgent extends Think {
  @callable()
  stream(chunks: string[], onChunk: StreamCallback): string {
    let accumulated = "";
    for (const chunk of chunks) {
      accumulated += chunk;
      onChunk(accumulated);
    }
    const log = this.host.store.get<string[]>("stream:log") ?? [];
    this.host.store.put("stream:log", [...log, accumulated]);
    return accumulated;
  }

  @callable()
  getLog(): string[] {
    return this.host.store.get<string[]>("stream:log") ?? [];
  }
}

class OuterSubAgent extends Think {
  @callable()
  ping(): string {
    return "outer-pong";
  }
}

class ReservedChild extends Think {
  @callable()
  ping(): string {
    return "reserved-pong";
  }
}

class TestSubAgentParentImpl extends Think {
  subAgentPing(childName: string): Promise<string> {
    return this.subAgent(COUNTER_CHILD, childName).call("ping", []);
  }

  subAgentIncrement(childName: string, key: string): Promise<number> {
    return this.subAgent(COUNTER_CHILD, childName).call("increment", [key]);
  }

  subAgentGet(childName: string, key: string): Promise<number> {
    return this.subAgent(COUNTER_CHILD, childName).call("get", [key]);
  }

  subAgentIncrementMultiple(
    childNames: string[],
    key: string
  ): Promise<number[]> {
    return Promise.all(
      childNames.map((childName) => this.subAgentIncrement(childName, key))
    );
  }

  subAgentAbort(childName: string): void {
    this.abortSubAgent(COUNTER_CHILD, childName, "test abort");
  }

  subAgentDelete(childName: string): Promise<void> {
    return this.deleteSubAgent(COUNTER_CHILD, childName);
  }

  subAgentGetName(childName: string): Promise<string> {
    return this.subAgent(COUNTER_CHILD, childName).call("getName", []);
  }

  subAgentGetConstructorName(childName: string): Promise<string> {
    return this.subAgent(COUNTER_CHILD, childName).call(
      "getConstructorName",
      []
    );
  }

  async subAgentMissingExport(): Promise<{ error: string }> {
    try {
      await this.subAgent("MissingSubAgentDO", "missing").call("ping", []);
      return { error: "" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async subAgentSameNameDifferentClass(childName: string): Promise<{
    counterPing: string;
    callbackLog: string[];
  }> {
    const counterPing = await this.subAgent(
      COUNTER_CHILD,
      childName
    ).call<string>("ping", []);
    const callbackLog = await this.subAgent(CALLBACK_CHILD, childName).call<
      string[]
    >("getLog", []);
    return { counterPing, callbackLog };
  }

  writeParentStorage(key: string, value: string): void {
    this.host.store.put(`parent:${key}`, value);
  }

  readParentStorage(key: string): string | undefined {
    return this.host.store.get<string>(`parent:${key}`);
  }

  async subAgentStreamViaCallback(
    childName: string,
    chunks: string[]
  ): Promise<{ received: string[]; done: string }> {
    const received: string[] = [];
    const done = await this.subAgent(CALLBACK_CHILD, childName).call<string>(
      "stream",
      [chunks, (chunk: string) => received.push(chunk)]
    );
    return { received, done };
  }

  subAgentGetStreamLog(childName: string): Promise<string[]> {
    return this.subAgent(CALLBACK_CHILD, childName).call("getLog", []);
  }

  nestedPing(childName: string): Promise<string> {
    return this.subAgent(OUTER_CHILD, childName).call("ping", []);
  }

  subAgentTryKeepAliveWhile(childName: string): Promise<string> {
    return this.subAgent(COUNTER_CHILD, childName).call("keepAliveWhileOk", []);
  }

  tryParentAgent(): undefined | string {
    return this.parentAgent() === undefined ? undefined : "present";
  }

  subAgentTryCancelSchedule(childName: string): Promise<string> {
    return this.subAgent(COUNTER_CHILD, childName).call(
      "tryCancelSchedule",
      []
    );
  }

  async subAgentTryScheduleAfterAbort(childName: string): Promise<string> {
    await this.subAgentTryCancelSchedule(childName);
    this.abortSubAgent(COUNTER_CHILD, childName, "restart probe");
    return this.subAgentTryCancelSchedule(childName);
  }

  subAgentInitOk(childName: string): Promise<boolean> {
    return this.subAgent(COUNTER_CHILD, childName).call("initOk", []);
  }

  subAgentTrySetState(
    childName: string,
    count: number,
    lastMsg: string
  ): Promise<{ error: string; persistedCount: number; persistedMsg: string }> {
    return this.subAgent(COUNTER_CHILD, childName).call("trySetState", [
      count,
      lastMsg
    ]);
  }

  subAgentParentPath(childName: string): Promise<AgentPath> {
    return this.subAgent(COUNTER_CHILD, childName).call("parentPathProbe", []);
  }

  subAgentSelfPath(childName: string): Promise<AgentPath> {
    return this.subAgent(COUNTER_CHILD, childName).call("selfPathProbe", []);
  }

  has(className: string, childName: string): boolean {
    return this.hasSubAgent(className, childName);
  }

  list(className?: string): SubAgentRecord[] {
    return this.listSubAgents(className);
  }

  async subAgentWithNullChar(): Promise<string> {
    try {
      await this.subAgentPing("bad\0name");
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async deleteUnknownSubAgent(childName: string): Promise<{
    error: string;
    has: boolean;
  }> {
    try {
      await this.deleteSubAgent(COUNTER_CHILD, childName);
      return { error: "", has: this.hasSubAgent(COUNTER_CHILD, childName) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        has: this.hasSubAgent(COUNTER_CHILD, childName)
      };
    }
  }

  async doubleDeleteSubAgent(childName: string): Promise<{ error: string }> {
    try {
      await this.subAgentPing(childName);
      await this.deleteSubAgent(COUNTER_CHILD, childName);
      await this.deleteSubAgent(COUNTER_CHILD, childName);
      return { error: "" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

class ReservedClassParentImpl extends Think {
  private async trySpawn(className: string): Promise<string> {
    try {
      await this.subAgent(className, "reserved").call("ping", []);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  trySpawnReserved(): Promise<string> {
    return this.trySpawn("Sub");
  }

  trySpawnReservedUpper(): Promise<string> {
    return this.trySpawn("SUB");
  }

  trySpawnReservedTrailing(): Promise<string> {
    return this.trySpawn("Sub_");
  }
}

const TestSubAgentParentBase = hostAgent(TestSubAgentParentImpl);
const ReservedClassParentBase = hostAgent(ReservedClassParentImpl);
const CounterSubAgentDOBase = hostAgent(CounterSubAgent);
const CallbackSubAgentDOBase = hostAgent(CallbackSubAgent);
const OuterSubAgentDOBase = hostAgent(OuterSubAgent);
const ReservedChildBase = hostAgent(ReservedChild);

export class TestSubAgentParent extends TestSubAgentParentBase {
  subAgentPing(childName: string): Promise<string> {
    return this.withAgent((agent) => agent.subAgentPing(childName));
  }

  subAgentIncrement(childName: string, key: string): Promise<number> {
    return this.withAgent((agent) => agent.subAgentIncrement(childName, key));
  }

  subAgentGet(childName: string, key: string): Promise<number> {
    return this.withAgent((agent) => agent.subAgentGet(childName, key));
  }

  subAgentIncrementMultiple(
    childNames: string[],
    key: string
  ): Promise<number[]> {
    return this.withAgent((agent) =>
      agent.subAgentIncrementMultiple(childNames, key)
    );
  }

  subAgentAbort(childName: string): Promise<void> {
    return this.withAgent((agent) => agent.subAgentAbort(childName));
  }

  subAgentDelete(childName: string): Promise<void> {
    return this.withAgent((agent) => agent.subAgentDelete(childName));
  }

  subAgentGetName(childName: string): Promise<string> {
    return this.withAgent((agent) => agent.subAgentGetName(childName));
  }

  subAgentGetConstructorName(childName: string): Promise<string> {
    return this.withAgent((agent) =>
      agent.subAgentGetConstructorName(childName)
    );
  }

  subAgentMissingExport(): Promise<{ error: string }> {
    return this.withAgent((agent) => agent.subAgentMissingExport());
  }

  subAgentSameNameDifferentClass(childName: string): Promise<{
    counterPing: string;
    callbackLog: string[];
  }> {
    return this.withAgent((agent) =>
      agent.subAgentSameNameDifferentClass(childName)
    );
  }

  writeParentStorage(key: string, value: string): Promise<void> {
    return this.withAgent((agent) => agent.writeParentStorage(key, value));
  }

  readParentStorage(key: string): Promise<string | undefined> {
    return this.withAgent((agent) => agent.readParentStorage(key));
  }

  subAgentStreamViaCallback(
    childName: string,
    chunks: string[]
  ): Promise<{ received: string[]; done: string }> {
    return this.withAgent((agent) =>
      agent.subAgentStreamViaCallback(childName, chunks)
    );
  }

  subAgentGetStreamLog(childName: string): Promise<string[]> {
    return this.withAgent((agent) => agent.subAgentGetStreamLog(childName));
  }

  nestedPing(childName: string): Promise<string> {
    return this.withAgent((agent) => agent.nestedPing(childName));
  }

  subAgentTryKeepAliveWhile(childName: string): Promise<string> {
    return this.withAgent((agent) =>
      agent.subAgentTryKeepAliveWhile(childName)
    );
  }

  tryParentAgent(): Promise<undefined | string> {
    return this.withAgent((agent) => agent.tryParentAgent());
  }

  subAgentTryCancelSchedule(childName: string): Promise<string> {
    return this.withAgent((agent) =>
      agent.subAgentTryCancelSchedule(childName)
    );
  }

  subAgentTryScheduleAfterAbort(childName: string): Promise<string> {
    return this.withAgent((agent) =>
      agent.subAgentTryScheduleAfterAbort(childName)
    );
  }

  subAgentInitOk(childName: string): Promise<boolean> {
    return this.withAgent((agent) => agent.subAgentInitOk(childName));
  }

  subAgentTrySetState(
    childName: string,
    count: number,
    lastMsg: string
  ): Promise<{ error: string; persistedCount: number; persistedMsg: string }> {
    return this.withAgent((agent) =>
      agent.subAgentTrySetState(childName, count, lastMsg)
    );
  }

  subAgentParentPath(childName: string): Promise<AgentPath> {
    return this.withAgent((agent) => agent.subAgentParentPath(childName));
  }

  subAgentSelfPath(childName: string): Promise<AgentPath> {
    return this.withAgent((agent) => agent.subAgentSelfPath(childName));
  }

  has(className: string, childName: string): Promise<boolean> {
    return this.withAgent((agent) => agent.has(className, childName));
  }

  list(className?: string): Promise<SubAgentRecord[]> {
    return this.withAgent((agent) => agent.list(className));
  }

  subAgentWithNullChar(): Promise<string> {
    return this.withAgent((agent) => agent.subAgentWithNullChar());
  }

  deleteUnknownSubAgent(childName: string): Promise<{
    error: string;
    has: boolean;
  }> {
    return this.withAgent((agent) => agent.deleteUnknownSubAgent(childName));
  }

  doubleDeleteSubAgent(childName: string): Promise<{ error: string }> {
    return this.withAgent((agent) => agent.doubleDeleteSubAgent(childName));
  }
}

export class ReservedClassParent extends ReservedClassParentBase {
  trySpawnReserved(): Promise<string> {
    return this.withAgent((agent) => agent.trySpawnReserved());
  }

  trySpawnReservedUpper(): Promise<string> {
    return this.withAgent((agent) => agent.trySpawnReservedUpper());
  }

  trySpawnReservedTrailing(): Promise<string> {
    return this.withAgent((agent) => agent.trySpawnReservedTrailing());
  }
}

export class CounterSubAgentDO extends CounterSubAgentDOBase {}
export class CallbackSubAgentDO extends CallbackSubAgentDOBase {}
export class OuterSubAgentDO extends OuterSubAgentDOBase {}
export class Sub extends ReservedChildBase {}
export class SUB extends ReservedChildBase {}
export class Sub_ extends ReservedChildBase {}
