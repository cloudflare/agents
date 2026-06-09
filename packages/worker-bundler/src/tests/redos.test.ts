import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "../file-system";
import { parseImports } from "../resolver";
import { transformAndResolve } from "../transformer";

// Regression tests for #1537: the import/export rewrite and the regex
// fallback parser used `[\w*{}\s,]+` followed by `\s+`, where both
// quantifiers can consume the same whitespace. On near-match inputs like
// `import <many spaces> X` the engine backtracked polynomially —
// ~175s for 10k spaces. The clause is now matched as non-whitespace tokens
// separated by whitespace, which is linear. The timing bounds below are
// deliberately generous (the fixed code runs in milliseconds); the old code
// exceeds them by orders of magnitude.

const WHITESPACE_BOMB = `import ${" ".repeat(50_000)}X`;

describe("import rewriting is ReDoS-safe (#1537)", () => {
  it("transformAndResolve completes quickly on a whitespace-bomb module", async () => {
    const files = new InMemoryFileSystem({ "index.js": WHITESPACE_BOMB });
    const start = performance.now();
    const result = await transformAndResolve(files, "index.js", []);
    const elapsed = performance.now() - start;
    expect(result.mainModule).toBe("index.js");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("parseImports regex fallback completes quickly on a whitespace bomb", () => {
    // JSX forces es-module-lexer to throw, exercising parseImportsRegex.
    const code = `const jsx = <div />;\n${WHITESPACE_BOMB}\nexport ${" ".repeat(50_000)}from!`;
    const start = performance.now();
    parseImports(code);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000);
  });

  it("still rewrites every import/export form", async () => {
    const files = new InMemoryFileSystem({
      "index.js": [
        `import def from './dep.js';`,
        `import { a, b } from './dep.js';`,
        `import * as ns from './dep.js';`,
        `import def2, { c } from './dep.js';`,
        `import './dep.js';`,
        `import {`,
        `  multi,`,
        `  line`,
        `} from './dep.js';`,
        `export { a } from './dep.js';`,
        `export * from './dep.js';`,
        `export const local = 1;`
      ].join("\n"),
      "dep.js":
        "export const a = 1, b = 2, c = 3, multi = 4, line = 5;\nexport default 6;"
    });
    const result = await transformAndResolve(files, "index.js", []);
    const code = result.modules["index.js"] as string;
    // Every one of the 8 import/export statements still references the dep
    // module after rewriting — none are dropped or mangled.
    const matches = code.match(/dep\.js/g) ?? [];
    expect(matches.length).toBe(8);
    expect(result.modules["dep.js"]).toBeDefined();
  });

  it("regex fallback still extracts every import/export form", () => {
    const code = [
      `const jsx = <div />;`, // force es-module-lexer failure
      `import a from 'mod-a';`,
      `import { b } from "mod-b";`,
      `import * as c from 'mod-c';`,
      `import 'mod-side';`,
      `import d, { e } from 'mod-d';`,
      `export { f } from 'mod-e';`,
      `export * from 'mod-f';`,
      `import('mod-dyn');`
    ].join("\n");
    expect(new Set(parseImports(code))).toEqual(
      new Set([
        "mod-a",
        "mod-b",
        "mod-c",
        "mod-side",
        "mod-d",
        "mod-e",
        "mod-f",
        "mod-dyn"
      ])
    );
  });
});
