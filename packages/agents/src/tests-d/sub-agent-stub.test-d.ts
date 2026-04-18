import { Agent } from "../index.ts";
import type { SubAgentStub } from "../index.ts";

// ── Test Agent with various method signatures (sub-agent stub) ───────

class TestSubAgent extends Agent {
  syncMethod(): string {
    return "hello";
  }

  asyncMethod(): Promise<number> {
    return Promise.resolve(42);
  }

  methodWithArgs(a: string, b: number): boolean {
    return a.length > b;
  }

  asyncMethodWithArgs(query: string): Promise<string[]> {
    return Promise.resolve([query]);
  }

  voidMethod(): void {
    // no-op
  }
}

// ── User methods are present ─────────────────────────────────────────

type Stub = SubAgentStub<TestSubAgent>;

// Sync methods are Promise-wrapped
null! as Stub["syncMethod"] satisfies () => Promise<string>;
null! as Stub["asyncMethod"] satisfies () => Promise<number>;
null! as Stub["methodWithArgs"] satisfies (
  a: string,
  b: number
) => Promise<boolean>;
null! as Stub["asyncMethodWithArgs"] satisfies (
  query: string
) => Promise<string[]>;
null! as Stub["voidMethod"] satisfies () => Promise<void>;

// ── Server/DurableObject internals are excluded ──────────────────────

// @ts-expect-error fetch is excluded
null! as Stub["fetch"];

// @ts-expect-error alarm is excluded
null! as Stub["alarm"];

// @ts-expect-error sql is excluded
null! as Stub["sql"];

// @ts-expect-error onStart is excluded
null! as Stub["onStart"];

// @ts-expect-error onConnect is excluded
null! as Stub["onConnect"];

// @ts-expect-error onMessage is excluded
null! as Stub["onMessage"];

// @ts-expect-error onClose is excluded
null! as Stub["onClose"];

// @ts-expect-error onError is excluded
null! as Stub["onError"];

// @ts-expect-error onRequest is excluded
null! as Stub["onRequest"];

// @ts-expect-error onException is excluded
null! as Stub["onException"];

// @ts-expect-error onAlarm is excluded
null! as Stub["onAlarm"];

// @ts-expect-error setName is excluded
null! as Stub["setName"];

// @ts-expect-error broadcast is excluded
null! as Stub["broadcast"];

// @ts-expect-error getConnection is excluded
null! as Stub["getConnection"];

// @ts-expect-error getConnections is excluded
null! as Stub["getConnections"];

// @ts-expect-error subAgent is excluded
null! as Stub["subAgent"];

// @ts-expect-error abortSubAgent is excluded
null! as Stub["abortSubAgent"];

// @ts-expect-error deleteSubAgent is excluded
null! as Stub["deleteSubAgent"];

// @ts-expect-error _cf_initAsFacet is excluded
null! as Stub["_cf_initAsFacet"];

// ── Agent subclass with extra base methods (AIChatAgent-like) ────────
// SubAgentStub only excludes `keyof Agent`. Methods added by a middle
// subclass (like AIChatAgent) appear on the stub — this is by design.

class MiddleAgent extends Agent {
  onChat(_msg: string): Promise<void> {
    return Promise.resolve();
  }
}

class ConcreteChild extends MiddleAgent {
  search(query: string): Promise<string[]> {
    return Promise.resolve([query]);
  }
}

type ChildStub = SubAgentStub<ConcreteChild>;

// User method is present
null! as ChildStub["search"] satisfies (query: string) => Promise<string[]>;

// MiddleAgent method IS present (not excluded — only keyof Agent is)
null! as ChildStub["onChat"] satisfies (_msg: string) => Promise<void>;
