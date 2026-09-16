import { expectTypeOf } from "vitest";
import { Agent } from "../index";
import { RoutedAgents, type RoutedAgentEntry } from "../routing";

class RoutedChild extends Agent<Cloudflare.Env> {
  ping(): string {
    return "pong";
  }
}

type Metadata = { readonly title: string };

declare const childBinding: DurableObjectNamespace<RoutedChild>;

const chats = new RoutedAgents<RoutedChild, Metadata>({
  namespace: childBinding,
  route: "chats"
});

expectTypeOf(chats.create({ metadata: { title: "Chat" } })).toEqualTypeOf<
  Promise<RoutedAgentEntry<Metadata>>
>();
expectTypeOf(chats.get("id")).toEqualTypeOf<
  Promise<DurableObjectStub<RoutedChild> | null>
>();
expectTypeOf(chats.list()).toEqualTypeOf<
  Promise<ReadonlyArray<RoutedAgentEntry<Metadata>>>
>();
expectTypeOf(chats.setMetadata("id", { title: "Next" })).toEqualTypeOf<
  Promise<boolean>
>();
expectTypeOf(chats.delete("id")).toEqualTypeOf<Promise<boolean>>();
