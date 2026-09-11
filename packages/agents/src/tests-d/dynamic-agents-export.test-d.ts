import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import { Agent, type SubAgentStub } from "../index";
import {
  Lifecycle,
  type DurableObjectCapability,
  type LifecycleRouteEnvelope
} from "../lifecycle";
import {
  DynamicAgents,
  parseSubAgentPath,
  SUB_PREFIX,
  type AgentPathStep,
  type DynamicAgentClass,
  type DynamicAgentHost,
  type DynamicAgentRef,
  type DynamicAgentsOptions,
  type DynamicAgentStub
} from "../dynamic-agents";
import { WebSockets } from "../websockets";

// ── A plain Durable Object host ──────────────────────────────────────

class Notebook extends DurableObject<Cloudflare.Env> {
  readonly children = new DynamicAgents();
  readonly lifecycle = Lifecycle.install(this).use(this.children);

  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  hello(name: string): string {
    return `hello ${name}`;
  }

  async count(): Promise<number> {
    return 1;
  }
}

class Workspace extends DurableObject<Cloudflare.Env> {
  readonly children = new DynamicAgents({
    onBeforeChild: (request, child) => {
      expectTypeOf(request).toEqualTypeOf<Request>();
      expectTypeOf(child).toEqualTypeOf<DynamicAgentRef>();
      return undefined;
    },
    checkLeases: () => 0,
    keepAliveIntervalMs: 5_000
  } satisfies DynamicAgentsOptions);
  readonly webSockets = new WebSockets({ handlers: {} });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.children)
    .use(this.webSockets, { fallback: true });

  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  async open(name: string): Promise<string> {
    const notebook = await this.children.get(Notebook, name);
    expectTypeOf(notebook).toEqualTypeOf<DynamicAgentStub<Notebook>>();
    notebook.hello satisfies (name: string) => Promise<string>;
    notebook.count satisfies () => Promise<number>;
    return notebook.hello("world");
  }
}

declare const workspace: Workspace;
workspace.children satisfies DurableObjectCapability;
workspace satisfies DynamicAgentHost;
Notebook satisfies DynamicAgentClass<Notebook>;

// Identity surface.
expectTypeOf(workspace.children.isChild).toEqualTypeOf<boolean>();
expectTypeOf(workspace.children.name).toEqualTypeOf<string>();
expectTypeOf(workspace.children.parentPath).toEqualTypeOf<
  ReadonlyArray<AgentPathStep>
>();
expectTypeOf(workspace.children.selfPath).toEqualTypeOf<
  ReadonlyArray<AgentPathStep>
>();

// Child management.
workspace.children.has(Notebook, "n") satisfies boolean;
workspace.children.has("Notebook", "n") satisfies boolean;
workspace.children.list(Notebook) satisfies Array<{
  className: string;
  name: string;
  createdAt: number;
}>;
workspace.children.abort(Notebook, "n", new Error("stop"));
workspace.children.delete(Notebook, "n") satisfies Promise<void>;
workspace.children.keepAlive() satisfies Promise<() => void>;
workspace.children.holdLease("run") satisfies Promise<void>;
workspace.children.releaseLease("run") satisfies Promise<void>;
workspace.children.broadcast("hi") satisfies Promise<void>;

// A plain host's stub excludes the Durable Object, Lifecycle, and aperture
// members while keeping the host's own methods.
type NotebookStub = DynamicAgentStub<Notebook>;
null! as NotebookStub["hello"] satisfies (name: string) => Promise<string>;
// @ts-expect-error fetch is excluded
null! as NotebookStub["fetch"];
// @ts-expect-error alarm is excluded
null! as NotebookStub["alarm"];
// @ts-expect-error lifecycle is excluded
null! as NotebookStub["lifecycle"];
// @ts-expect-error the routing aperture is excluded
null! as NotebookStub["_cf_lifecycle"];

// An Agent child keeps the Agent-shaped stub.
class AgentChild extends Agent {
  search(query: string): Promise<string[]> {
    return Promise.resolve([query]);
  }
}
type AgentChildStub = DynamicAgentStub<AgentChild>;
null! as AgentChildStub satisfies SubAgentStub<AgentChild>;
null! as SubAgentStub<AgentChild> satisfies AgentChildStub;
null! as AgentChildStub["search"] satisfies (
  query: string
) => Promise<string[]>;
// @ts-expect-error Agent's own surface is excluded
null! as AgentChildStub["broadcast"];

// Routing helpers are re-exported for hosts.
SUB_PREFIX satisfies string;
parseSubAgentPath("https://example.com/agents/workspace/w/sub/notebook/n");
