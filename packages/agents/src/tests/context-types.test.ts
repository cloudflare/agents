import { describe, expectTypeOf, it } from "vitest";
import {
  Agent,
  getCurrentAgent,
  getCurrentContext,
  type AgentContextInput,
  type AgentContextOf,
  type AgentDestroyContextOf
} from "..";

type TypedContext = {
  traceId: string;
  lifecycle: AgentContextInput["lifecycle"];
};

class TypeInferenceAgent extends Agent<Record<string, unknown>> {
  onContextStart(_input: AgentContextInput<this>): TypedContext {
    return {
      traceId: "trace-id",
      lifecycle: "method"
    };
  }
}

class NoOverrideAgent extends Agent<Record<string, unknown>> {}

describe("context api types", () => {
  it("infers this.context from onContextStart return type", () => {
    expectTypeOf<TypeInferenceAgent["context"]>().toEqualTypeOf<
      TypedContext | undefined
    >();
  });

  it("keeps this.context unknown | undefined without override", () => {
    expectTypeOf<NoOverrideAgent["context"]>().toEqualTypeOf<
      unknown | undefined
    >();
  });

  it("types getCurrentContext as unknown", () => {
    expectTypeOf<
      ReturnType<typeof getCurrentContext>
    >().toEqualTypeOf<unknown>();
  });

  it("types getCurrentAgent<T>().context from T onContextStart", () => {
    expectTypeOf<
      ReturnType<typeof getCurrentAgent<TypeInferenceAgent>>["context"]
    >().toEqualTypeOf<TypedContext | undefined>();
  });

  it("types AgentContextInput<T>.agent as T", () => {
    expectTypeOf<
      AgentContextInput<TypeInferenceAgent>["agent"]
    >().toEqualTypeOf<TypeInferenceAgent>();
  });

  it("types AgentContextOf<T> from onContextStart return", () => {
    expectTypeOf<
      AgentContextOf<TypeInferenceAgent>
    >().toEqualTypeOf<TypedContext>();
  });

  it("types AgentDestroyContextOf<T> from onContextStart return", () => {
    expectTypeOf<
      AgentDestroyContextOf<TypeInferenceAgent>
    >().toEqualTypeOf<TypedContext>();
  });

  it("types onContextStart input.agent as subclass", () => {
    expectTypeOf<
      Parameters<TypeInferenceAgent["onContextStart"]>[0]["agent"]
    >().toEqualTypeOf<TypeInferenceAgent>();
  });

  it("types onContextEnd context from onContextStart return", () => {
    expectTypeOf<
      Parameters<TypeInferenceAgent["onContextEnd"]>[0]
    >().toEqualTypeOf<TypedContext>();
  });
});
