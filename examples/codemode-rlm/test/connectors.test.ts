import { describe, expect, it, vi } from "vitest";
import {
  ContextConnector,
  RlmConnector,
  type RlmHost
} from "../src/connectors";
import type { RlmStore } from "../src/store";

const ctx = {} as DurableObjectState;
const env = {} as Env;

describe("optional connector arguments", () => {
  it("uses defaults when optional-only context tools receive no object", async () => {
    const store = {
      inputs: vi.fn(() => []),
      history: vi.fn(() => [])
    } as unknown as RlmStore;
    const connector = new ContextConnector(ctx, env, store, "root", "input-1");

    await expect(connector.executeTool("inputs", undefined)).resolves.toEqual(
      []
    );
    await expect(connector.executeTool("history", undefined)).resolves.toEqual(
      []
    );
    expect(store.inputs).toHaveBeenCalledWith("root", "input-1", 20);
    expect(store.history).toHaveBeenCalledWith("root", 12);
  });

  it("uses the default limit when rlm.list receives no object", async () => {
    const list = vi.fn(async () => []);
    const connector = new RlmConnector(ctx, env, {
      list
    } as unknown as RlmHost);

    await expect(connector.executeTool("list", undefined)).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith(10);
  });
});
