import { expect, it } from "vitest";
// The published subpath import exercises the package export map against the
// built artifact; the `test` target builds first.
import * as transformNamespace from "@cloudflare/worker-bundler/transform";
import type { TransformResult } from "@cloudflare/worker-bundler/transform";

const { transformCode } = transformNamespace;

it("exports exactly the transform function from the subpath", () => {
  expect(Object.keys(transformNamespace).sort()).toEqual(["transformCode"]);
});

it("strips TypeScript through the transform subpath while preserving lines", () => {
  const source = [
    "interface Shape {",
    "  width: number;",
    "}",
    "const shape = { width: 2 } satisfies Shape;",
    "export const area: number = (shape as Shape).width ** 2;"
  ].join("\n");

  const result: TransformResult = transformCode(source, {
    filePath: "run.ts"
  });

  expect(result.code.split("\n")).toHaveLength(source.split("\n").length);
  expect(result.code).not.toContain("interface");
  expect(result.code).not.toContain("satisfies");
  expect(result.code).toContain("const shape = { width: 2 }");
  expect(result.sourceMap).toBeUndefined();
});
