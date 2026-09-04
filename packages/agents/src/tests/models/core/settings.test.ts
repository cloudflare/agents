/**
 * Option merging: the three layers, the flat gateway sugar (`id` included) and
 * the per-field retry merge.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_ID,
  parseModelOptions,
  resolveOptions
} from "../../../models/core/settings";

describe("core settings - gateway id", () => {
  it("defaults to the auto-created gateway", () => {
    expect(resolveOptions(undefined, undefined, undefined).gateway.id).toBe(
      DEFAULT_GATEWAY_ID
    );
  });

  it("takes a flat id at the provider level", () => {
    expect(
      resolveOptions({ cacheTtl: 60, id: "prod" }, undefined, undefined).gateway
    ).toEqual({ cacheTtl: 60, id: "prod" });
  });

  it("prefers the flat id over the nested one, at every layer", () => {
    expect(
      resolveOptions(
        { gateway: { id: "nested" }, id: "flat" },
        undefined,
        undefined
      ).gateway.id
    ).toBe("flat");
    expect(
      resolveOptions(
        undefined,
        { gateway: { id: "nested" }, id: "flat" },
        undefined
      ).gateway.id
    ).toBe("flat");
  });

  it("lets each layer override the one below it", () => {
    expect(
      resolveOptions({ id: "provider" }, undefined, undefined).gateway.id
    ).toBe("provider");
    expect(
      resolveOptions({ id: "provider" }, { id: "model" }, undefined).gateway.id
    ).toBe("model");
    expect(
      resolveOptions({ id: "provider" }, { id: "model" }, { id: "call" })
        .gateway.id
    ).toBe("call");
    // A layer that says nothing never blanks the one below it.
    expect(
      resolveOptions({ id: "provider" }, { cacheTtl: 5 }, {}).gateway.id
    ).toBe("provider");
  });

  it("still accepts the provider gateway as a bare string or object", () => {
    expect(resolveOptions("prod", undefined, undefined).gateway.id).toBe(
      "prod"
    );
    expect(
      resolveOptions({ gateway: "prod" }, undefined, undefined).gateway.id
    ).toBe("prod");
    expect(
      resolveOptions({ gateway: { cacheTtl: 5, id: "prod" } }, undefined, {})
        .gateway
    ).toEqual({ cacheTtl: 5, id: "prod" });
  });

  it("reads a flat id out of a per-call options bag", () => {
    const call = parseModelOptions({ id: "call", skipCache: true });
    expect(call).toMatchObject({ id: "call", skipCache: true });
    expect(resolveOptions({ id: "provider" }, undefined, call).gateway.id).toBe(
      "call"
    );
  });
});

describe("core settings - retries", () => {
  it("merges the policy field by field across the layers", () => {
    expect(
      resolveOptions(
        { retries: { backoff: "linear", maxAttempts: 5 } },
        { retries: { maxAttempts: 3 } },
        { retries: { retryDelayMs: 250 } }
      ).gateway.retries
    ).toEqual({ backoff: "linear", maxAttempts: 3, retryDelayMs: 250 });
  });

  it("leaves retries off entirely when no layer sets one", () => {
    expect(resolveOptions({ id: "prod" }, {}, {}).gateway).not.toHaveProperty(
      "retries"
    );
  });

  it("drops a policy in which nothing survives parsing", () => {
    expect(parseModelOptions({ retries: { maxAttempts: 9 } })).toEqual({});
    expect(parseModelOptions({ retries: "aggressive" })).toEqual({});
    expect(parseModelOptions({ retries: {} })).toEqual({});
  });

  it("does not let an unparseable per-call policy blank the model's", () => {
    expect(
      resolveOptions(
        undefined,
        { retries: { backoff: "exponential", maxAttempts: 2 } },
        parseModelOptions({ retries: { maxAttempts: 42 } })
      ).gateway.retries
    ).toEqual({ backoff: "exponential", maxAttempts: 2 });
  });

  it("keeps a valid parsed policy", () => {
    expect(
      parseModelOptions({
        retries: { backoff: "constant", maxAttempts: 2, retryDelayMs: 100 }
      })
    ).toEqual({
      retries: { backoff: "constant", maxAttempts: 2, retryDelayMs: 100 }
    });
  });
});

describe("core settings - other layers", () => {
  it("merges metadata field by field and headers last-wins", () => {
    const resolved = resolveOptions(
      { metadata: { env: "prod", tenant: "acme" } },
      { headers: { "x-a": "1" }, metadata: { tenant: "beta" } },
      { headers: { "x-a": "2", "x-b": "3" }, metadata: { run: "7" } }
    );
    expect(resolved.gateway.metadata).toEqual({
      env: "prod",
      run: "7",
      tenant: "beta"
    });
    expect(resolved.headers).toEqual({ "x-a": "2", "x-b": "3" });
  });

  it("keeps a per-call null reasoning effort", () => {
    expect(
      resolveOptions(
        undefined,
        { reasoningEffort: "high" },
        {
          reasoningEffort: null
        }
      ).reasoningEffort
    ).toBe(null);
  });
});
