import { describe, expectTypeOf, it } from "vitest";
import {
  Agent,
  AgentContext,
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
  context = new AgentContext(this, {
    onStart: (_input): TypedContext => ({
      traceId: "trace-id",
      lifecycle: "method"
    }),
    onClose: (_ctx: TypedContext, _input) => {}
  });
}

class NoOverrideAgent extends Agent<Record<string, unknown>> {}

describe("context api types", () => {
  it("types this.context as the runtime value (Proxy)", () => {
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

  it("types getCurrentAgent<T>().context from T context type", () => {
    expectTypeOf<
      ReturnType<typeof getCurrentAgent<TypeInferenceAgent>>["context"]
    >().toEqualTypeOf<(TypedContext | undefined) | undefined>();
  });

  it("types AgentContextInput<T>.agent as T", () => {
    expectTypeOf<
      AgentContextInput<TypeInferenceAgent>["agent"]
    >().toEqualTypeOf<TypeInferenceAgent>();
  });

  it("types AgentContextOf<T> from context type", () => {
    expectTypeOf<AgentContextOf<TypeInferenceAgent>>().toEqualTypeOf<
      TypedContext | undefined
    >();
  });

  it("types AgentDestroyContextOf<T> as NonNullable value type", () => {
    expectTypeOf<
      AgentDestroyContextOf<TypeInferenceAgent>
    >().toEqualTypeOf<TypedContext>();
  });
});
