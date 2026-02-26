import { describe, expectTypeOf, it } from "vitest";
import {
  Agent,
  getCurrentAgent,
  getCurrentContext,
  type AgentContextInput
} from "..";

type TypedContext = {
  traceId: string;
  lifecycle: AgentContextInput["lifecycle"];
};

class TypeInferenceAgent extends Agent<Record<string, unknown>> {
  onCreateContext(_input: AgentContextInput): TypedContext {
    return {
      traceId: "trace-id",
      lifecycle: "method"
    };
  }
}

class NoOverrideAgent extends Agent<Record<string, unknown>> {}

describe("context api types", () => {
  it("infers this.context from onCreateContext return type", () => {
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

  it("types getCurrentAgent<T>().context from T onCreateContext", () => {
    expectTypeOf<
      ReturnType<typeof getCurrentAgent<TypeInferenceAgent>>["context"]
    >().toEqualTypeOf<TypedContext | undefined>();
  });
});
