import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import {
  getCurrentAgent as getCurrentRootAgent,
  type Agent as FullAgent,
  type Connection as AgentConnection,
  type ConnectionContext as AgentConnectionContext,
  type WSMessage as AgentWSMessage
} from "../index";
import {
  getCurrentAgent,
  Lifecycle,
  LifecycleCapability,
  type AlarmContribution,
  type LifecycleEvent,
  type LifecycleServices,
  type LifecycleObject,
  type Connection,
  type ConnectionContext,
  type DurableObjectCapability,
  type WSMessage
} from "../lifecycle";

expectTypeOf<AgentConnection>().toEqualTypeOf<Connection>();
expectTypeOf<AgentConnectionContext>().toEqualTypeOf<ConnectionContext>();
expectTypeOf<AgentWSMessage>().toEqualTypeOf<WSMessage>();

class LifecycleTypeProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);

  onRequest(request: Request): Response {
    return new Response(request.url);
  }
}

expectTypeOf<LifecycleTypeProbe>().toMatchTypeOf<DurableObject>();
expectTypeOf<LifecycleTypeProbe>().toMatchTypeOf<LifecycleObject>();
expectTypeOf<LifecycleTypeProbe["lifecycle"]>().toEqualTypeOf<Lifecycle>();

type ProbeProps = { readonly label: string };
type ProbeLifecycleObject = LifecycleObject<Cloudflare.Env, ProbeProps>;
expectTypeOf<ProbeLifecycleObject["onStart"]>().toEqualTypeOf<
  ((props?: ProbeProps) => void | Promise<void>) | undefined
>();
expectTypeOf<ProbeLifecycleObject["onRequest"]>().toEqualTypeOf<
  ((request: Request) => Response | Promise<Response>) | undefined
>();
expectTypeOf<ProbeLifecycleObject["onAlarm"]>().toEqualTypeOf<
  (() => void | Promise<void>) | undefined
>();
expectTypeOf<ProbeLifecycleObject["getNextAlarm"]>().toEqualTypeOf<
  (() => AlarmContribution | Promise<AlarmContribution>) | undefined
>();
expectTypeOf<ProbeLifecycleObject["onConnect"]>().toEqualTypeOf<
  | ((
      connection: Connection,
      context: ConnectionContext
    ) => void | Promise<void>)
  | undefined
>();
expectTypeOf<ProbeLifecycleObject["onMessage"]>().toEqualTypeOf<
  | ((connection: Connection, message: WSMessage) => void | Promise<void>)
  | undefined
>();
expectTypeOf<ProbeLifecycleObject["onClose"]>().toEqualTypeOf<
  | ((
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => void | Promise<void>)
  | undefined
>();
expectTypeOf<ProbeLifecycleObject["onError"]>().toEqualTypeOf<
  ((connection: Connection, error: unknown) => void | Promise<void>) | undefined
>();
expectTypeOf<ProbeLifecycleObject["getConnectionTags"]>().toEqualTypeOf<
  | ((
      connection: Connection,
      context: ConnectionContext
    ) => string[] | Promise<string[]>)
  | undefined
>();
expectTypeOf(getCurrentAgent().agent).toEqualTypeOf<
  LifecycleObject | undefined
>();
expectTypeOf(getCurrentAgent<LifecycleTypeProbe>().agent).toEqualTypeOf<
  LifecycleTypeProbe | undefined
>();
expectTypeOf(getCurrentRootAgent().agent).toEqualTypeOf<
  FullAgent | undefined
>();
expectTypeOf(getCurrentRootAgent<LifecycleTypeProbe>().agent).toEqualTypeOf<
  LifecycleTypeProbe | undefined
>();

class ServiceCapability extends LifecycleCapability {
  constructor() {
    super("type-probe");
  }

  probe(): void {
    expectTypeOf(this.lifecycle).toEqualTypeOf<LifecycleServices>();
    expectTypeOf(this.lifecycle.storage).toEqualTypeOf<DurableObjectStorage>();
    expectTypeOf(this.lifecycle.alarms.rearm()).toEqualTypeOf<Promise<void>>();
    this.lifecycle.events.emit("probe:started", { ready: true });
    this.lifecycle.routes.toRoot({ ready: true });
  }
}

new ServiceCapability() satisfies DurableObjectCapability;

const event = {
  source: "type-probe",
  type: "probe:started",
  payload: { ready: true }
} satisfies LifecycleEvent;
expectTypeOf(event).toMatchTypeOf<LifecycleEvent>();

const capability: DurableObjectCapability = {
  onStart: ({ props }) => {
    expectTypeOf(props).toEqualTypeOf<object | undefined>();
  },
  onRequest: ({ request }) => new Response(request.url),
  getNextAlarm: () => ({ time: Date.now(), exclusive: true })
};

expectTypeOf(capability).toMatchTypeOf<DurableObjectCapability>();
