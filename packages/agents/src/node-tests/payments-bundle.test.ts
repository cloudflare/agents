import { build } from "esbuild";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("payment entry point isolation", () => {
  it.each(["index", "mcp"])(
    "%s contains no runtime SDK or wallet dependencies",
    async (entry) => {
      const result = await build({
        entryPoints: [resolve(`src/payments/x402/${entry}.ts`)],
        bundle: true,
        format: "esm",
        platform: "browser",
        metafile: true,
        write: false
      });
      const inputs = Object.keys(result.metafile!.inputs);
      expect(
        inputs.every((input) => input.startsWith("src/payments/x402/"))
      ).toBe(true);
    }
  );
});
