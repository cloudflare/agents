import { describe, expect, it } from "vitest";
import { parseDemoArguments } from "../src/demo-args";

describe("demo arguments", () => {
  it("ignores pnpm's argument separator", () => {
    expect(parseDemoArguments(["--", "Plan", "the", "rollout"]).prompt).toBe(
      "Plan the rollout"
    );
  });

  it("parses and normalizes an explicit origin", () => {
    expect(
      parseDemoArguments(["--", "--origin", "http://127.0.0.1:8787/", "Prompt"])
    ).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      prompt: "Prompt"
    });
  });

  it("uses the environment origin when no flag is provided", () => {
    expect(parseDemoArguments([], "https://example.com/").baseUrl).toBe(
      "https://example.com"
    );
  });

  it("rejects an origin flag without a URL", () => {
    expect(() => parseDemoArguments(["--", "--origin"])).toThrow(
      "--origin requires a URL"
    );
  });
});
