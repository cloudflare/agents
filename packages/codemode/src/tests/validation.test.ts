import { describe, expect, it, vi } from "vitest";
import {
  runCodeValidators,
  runToolCallValidators,
  toolCallValidatorNames,
  validateValidators,
  type CodemodeValidator
} from "../validation";

const codeContext = {
  code: "42",
  normalizedCode: "async () => (42)",
  connectors: []
};

describe("codemode validators", () => {
  it("does nothing when no validator is configured", async () => {
    await expect(
      runCodeValidators(undefined, codeContext)
    ).resolves.toBeUndefined();
  });

  it("skips validators that do not implement the current hook", async () => {
    await expect(
      runCodeValidators([{ name: "call-only" }], codeContext)
    ).resolves.toBeUndefined();
  });

  it("records only call-validator names for resume", () => {
    expect(
      toolCallValidatorNames([
        { name: "code-only", validateCode: () => ({ valid: true }) },
        { name: "call", validateToolCall: () => ({ valid: true }) },
        {
          name: "both",
          validateCode: () => ({ valid: true }),
          validateToolCall: () => ({ valid: true })
        }
      ])
    ).toEqual(["call", "both"]);
  });

  it("requires an explicit valid result from configured hooks", async () => {
    await expect(
      runCodeValidators(
        [{ name: "valid", validateCode: () => ({ valid: true }) }],
        codeContext
      )
    ).resolves.toBeUndefined();

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = await runCodeValidators(
      [
        {
          name: "missing-result",
          validateCode: () => undefined as never
        }
      ],
      codeContext
    );

    expect(error).toContain(
      "did not return an explicit valid or invalid result"
    );

    const malformed = await runCodeValidators(
      [
        {
          name: "malformed-result",
          validateCode: () =>
            ({ valid: false, issues: [{ message: 42 }] }) as never
        }
      ],
      codeContext
    );
    expect(malformed).toContain(
      "did not return an explicit valid or invalid result"
    );
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("runs validators sequentially and aggregates attributed issues", async () => {
    const order: string[] = [];
    const validators: CodemodeValidator[] = [
      {
        name: "lifecycle",
        validateToolCall: async () => {
          order.push("lifecycle");
          return {
            valid: false,
            issues: [
              {
                code: "invalid-state",
                path: "state",
                message: "The state is not applicable.",
                suggestion: "Load the resource before choosing its next state."
              }
            ]
          };
        }
      },
      {
        name: "fields",
        validateToolCall: () => {
          order.push("fields");
          return {
            valid: false,
            issues: [{ message: "The owner and region appear to be swapped." }]
          };
        }
      }
    ];

    const error = await runToolCallValidators(validators, {
      executionId: "exec_1",
      connector: "resources",
      method: "patch",
      args: { state: "active" }
    });

    expect(order).toEqual(["lifecycle", "fields"]);
    expect(error).toContain("Validation failed for resources.patch");
    expect(error).toContain("[lifecycle] (invalid-state) state:");
    expect(error).toContain("Load the resource");
    expect(error).toContain("[fields]");
  });

  it("uses a generic issue for an invalid result without details", async () => {
    const error = await runCodeValidators(
      [{ name: "policy", validateCode: () => ({ valid: false }) }],
      codeContext
    );
    expect(error).toContain("Validation failed without further details.");
  });

  it("rejects empty and duplicate names", () => {
    expect(() => validateValidators([{ name: " " }])).toThrow(
      "must not be empty"
    );
    expect(() =>
      validateValidators([{ name: "policy" }, { name: "policy" }])
    ).toThrow('Duplicate codemode validator name "policy"');
  });

  it("fails closed without exposing a thrown validator error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = await runCodeValidators(
      [
        {
          name: "private-policy",
          validateCode: () => {
            throw new Error("secret internal endpoint");
          }
        }
      ],
      codeContext
    );

    expect(error).toContain(
      'Validator "private-policy" could not complete; the operation was not executed.'
    );
    expect(error).not.toContain("secret internal endpoint");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("bounds the number and length of diagnostics", async () => {
    const error = await runCodeValidators(
      [
        {
          name: "many",
          validateCode: () => ({
            valid: false,
            issues: Array.from({ length: 30 }, () => ({
              message: "x".repeat(3_000)
            }))
          })
        }
      ],
      codeContext
    );

    expect(error?.match(/\[many\]/g)).toHaveLength(10);
    expect(error?.length).toBeLessThanOrEqual(20_000);
    expect(error).toContain("[truncated]");
  });
});
