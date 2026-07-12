/** Handle to a (possibly lazily created) named child agent instance. */
export interface AgentHandle {
  readonly className: string;
  readonly name: string;
  call<T = unknown>(method: string, args: unknown[]): Promise<T>;
  /** Kill the running instance, keep storage. */
  abort(reason?: unknown): void;
  /** Wipe storage. */
  destroy(): Promise<void>;
}

export interface AgentSpawner {
  /** Lazily creates the instance on first access. */
  get(className: string, name: string): AgentHandle;
}
