/**
 * Type tests for serializable type inference.
 * Tests that custom interfaces with named properties are correctly
 * recognized as serializable (not just index-signature objects).
 *
 * This was a bug fix: previously, RPCMethod used { [key: string]: SerializableValue }
 * which didn't match interfaces with named properties.
 */
import type { env } from "cloudflare:workers";
import { Agent } from "..";
import { useAgent } from "../react";

// ============================================
// Custom interfaces that should be serializable
// ============================================

interface SimpleState {
  counter: number;
  name: string;
}

interface NestedState {
  user: {
    id: number;
    name: string;
  };
  items: string[];
  metadata: {
    createdAt: string;
    tags: string[];
  };
}

interface StateWithOptionals {
  required: string;
  optional?: number;
  nullable: string | null;
}

interface StateWithArrays {
  items: Array<{ id: number; value: string }>;
  numbers: number[];
  nested: Array<Array<string>>;
}

// ============================================
// Agent with methods returning custom interfaces
// Uses declare class to define method signatures (same pattern as typed-use-agent.test-d.ts)
// ============================================

declare class SerializableAgent extends Agent<typeof env, SimpleState> {
  // Methods returning custom interfaces - should be recognized as RPC methods
  getSimpleState: () => SimpleState;
  getNestedState: () => NestedState;
  getStateWithOptionals: () => StateWithOptionals;
  getStateWithArrays: () => StateWithArrays;
  getAsyncState: () => Promise<SimpleState>;

  // Methods returning primitives and basic types
  getString: () => string;
  getNumber: () => number;
  getBoolean: () => boolean;
  getNull: () => null;
  getUndefined: () => undefined;
  getVoid: () => void;
  getArray: () => string[];
  getUnknownArray: () => unknown[];
  getRecord: () => Record<string, number>;

  // Methods with interface parameters
  updateState: (newState: SimpleState) => SimpleState;
  updateNested: (state: NestedState) => NestedState;

  // Union return types
  getUnion: () => string | number;
  getNullable: () => string | null;
  getComplexUnion: () => SimpleState | NestedState;

  // Non-serializable types (should be excluded from RPC)
  nonSerializableReturn: () => Date;
  nonSerializableParams: (date: Date) => void;
  nestedNonSerializable: () => { timestamp: Date };
}

// ============================================
// POSITIVE TESTS - Custom interfaces should work
// ============================================

const agent = useAgent<SerializableAgent, SimpleState>({ agent: "test" });

// Custom interfaces should be recognized as callable methods
agent.call("getSimpleState") satisfies Promise<SimpleState>;
agent.call("getNestedState") satisfies Promise<NestedState>;
agent.call("getStateWithOptionals") satisfies Promise<StateWithOptionals>;
agent.call("getStateWithArrays") satisfies Promise<StateWithArrays>;
agent.call("getAsyncState") satisfies Promise<SimpleState>;

// Primitive returns should work
agent.call("getString") satisfies Promise<string>;
agent.call("getNumber") satisfies Promise<number>;
agent.call("getBoolean") satisfies Promise<boolean>;
agent.call("getNull") satisfies Promise<null>;
agent.call("getUndefined") satisfies Promise<undefined>;
agent.call("getVoid") satisfies Promise<void>;
agent.call("getArray") satisfies Promise<string[]>;
agent.call("getUnknownArray") satisfies Promise<unknown[]>;
agent.call("getRecord") satisfies Promise<Record<string, number>>;

// Methods with interface parameters should work
agent.call("updateState", [
  { counter: 1, name: "test" }
]) satisfies Promise<SimpleState>;
agent.call("updateNested", [
  {
    user: { id: 1, name: "test" },
    items: ["a"],
    metadata: { createdAt: "now", tags: [] }
  }
]) satisfies Promise<NestedState>;

// Union types should work
agent.call("getUnion") satisfies Promise<string | number>;
agent.call("getNullable") satisfies Promise<string | null>;
agent.call("getComplexUnion") satisfies Promise<SimpleState | NestedState>;

// ============================================
// NEGATIVE TESTS - Non-serializable should NOT work
// ============================================

// @ts-expect-error Date return not serializable
agent.call("nonSerializableReturn");

// @ts-expect-error Date parameter not serializable
agent.call("nonSerializableParams", [new Date()]);

// @ts-expect-error Nested Date in interface not serializable
agent.call("nestedNonSerializable");

// ============================================
// PARAMETER VALIDATION TESTS
// ============================================

// @ts-expect-error wrong parameter type
agent.call("updateState", [{ counter: "wrong", name: "test" }]);

// @ts-expect-error missing required property
agent.call("updateState", [{ counter: 1 }]);

// @ts-expect-error non-existent method
agent.call("nonExistentMethod");

// @ts-expect-error requires parameters
agent.call("updateState");
