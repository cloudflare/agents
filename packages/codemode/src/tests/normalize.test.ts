import { describe, it, expect } from "vitest";
import { normalizeCode } from "../normalize";

describe("normalizeCode", () => {
  describe("empty / whitespace input", () => {
    it("returns default async arrow for empty string", () => {
      expect(normalizeCode("")).toBe("async () => {}");
    });

    it("returns default async arrow for whitespace-only string", () => {
      expect(normalizeCode("   \n\t  ")).toBe("async () => {}");
    });
  });

  describe("arrow function passthrough", () => {
    it("passes through a simple async arrow function", () => {
      const code = "async () => { return 1; }";
      expect(normalizeCode(code)).toBe(code);
    });

    it("passes through a sync arrow function", () => {
      const code = "() => { return 1; }";
      expect(normalizeCode(code)).toBe(code);
    });

    it("passes through an arrow with parameters", () => {
      const code = "async (a, b) => { return a + b; }";
      expect(normalizeCode(code)).toBe(code);
    });

    it("passes through a concise-body arrow function", () => {
      const code = "() => 42";
      expect(normalizeCode(code)).toBe(code);
    });

    it("passes through arrow with trailing semicolon", () => {
      // Semicolon is part of the ExpressionStatement; inner expr is still ArrowFunctionExpression
      const result = normalizeCode("async () => { return 1; };");
      expect(result).toBe("async () => { return 1; };");
    });
  });

  describe("trailing expression → return insertion", () => {
    it("wraps a single expression and returns it", () => {
      const result = normalizeCode("1 + 2");
      expect(result).toBe("async () => {\nreturn (1 + 2)\n}");
    });

    it("keeps preceding statements and returns the last expression", () => {
      const code = "const x = 10;\nx * 2";
      const result = normalizeCode(code);
      expect(result).toContain("const x = 10;");
      expect(result).toContain("return (x * 2)");
      expect(result).toMatch(/^async \(\) => \{/);
    });

    it("returns a function call expression", () => {
      const result = normalizeCode('console.log("hello")');
      expect(result).toContain('return (console.log("hello"))');
    });

    it("returns an await expression", () => {
      const result = normalizeCode("await fetch('http://example.com')");
      expect(result).toContain("return (await fetch('http://example.com'))");
    });
  });

  describe("non-expression last statement → plain wrap", () => {
    it("wraps a variable declaration", () => {
      const code = "const x = 42";
      const result = normalizeCode(code);
      expect(result).toBe("async () => {\nconst x = 42\n}");
    });

    it("wraps a for loop", () => {
      const code = "for (let i = 0; i < 10; i++) {}";
      const result = normalizeCode(code);
      expect(result).toBe(`async () => {\n${code}\n}`);
    });

    it("wraps an if statement", () => {
      const code = "if (true) { doStuff(); }";
      const result = normalizeCode(code);
      expect(result).toBe(`async () => {\n${code}\n}`);
    });

    it("wraps multiple statements ending with a declaration", () => {
      const code = "const a = 1;\nconst b = 2;";
      const result = normalizeCode(code);
      expect(result).toBe(`async () => {\n${code}\n}`);
    });
  });

  describe("parse error fallback", () => {
    it("wraps syntactically invalid code as-is", () => {
      const code = "const = oops {{{";
      const result = normalizeCode(code);
      expect(result).toBe(`async () => {\n${code}\n}`);
    });
  });

  describe("whitespace trimming", () => {
    it("trims leading and trailing whitespace before processing", () => {
      const result = normalizeCode("  () => 42  ");
      expect(result).toBe("() => 42");
    });
  });

  // ── LLM failure modes ──────────────────────────────────────────────

  describe("markdown code fences", () => {
    it("strips ```js fences", () => {
      const code = "```js\nasync () => { return 1; }\n```";
      expect(normalizeCode(code)).toBe("async () => { return 1; }");
    });

    it("strips ```javascript fences", () => {
      const code = "```javascript\nconst x = 1;\nx + 2\n```";
      const result = normalizeCode(code);
      expect(result).toContain("return (x + 2)");
      expect(result).not.toContain("```");
    });

    it("strips ```typescript fences", () => {
      const code = "```typescript\n() => 42\n```";
      expect(normalizeCode(code)).toBe("() => 42");
    });

    it("strips ```ts fences", () => {
      const code = "```ts\n() => 42\n```";
      expect(normalizeCode(code)).toBe("() => 42");
    });

    it("strips ```tsx fences", () => {
      const code = "```tsx\n() => 42\n```";
      expect(normalizeCode(code)).toBe("() => 42");
    });

    it("strips ```jsx fences", () => {
      const code = "```jsx\n() => 42\n```";
      expect(normalizeCode(code)).toBe("() => 42");
    });

    it("strips bare ``` fences with no language tag", () => {
      const code = "```\nasync () => { return 1; }\n```";
      expect(normalizeCode(code)).toBe("async () => { return 1; }");
    });

    it("handles fences with trailing whitespace", () => {
      const code = "```js\nasync () => { return 1; }\n```  ";
      expect(normalizeCode(code)).toBe("async () => { return 1; }");
    });

    it("does not strip fences if code is not fully wrapped", () => {
      // Only one backtick fence, not a complete pair
      const code = "```js\nasync () => { return 1; }";
      const result = normalizeCode(code);
      // Falls through to parse error → wrapped
      expect(result).toContain("async () => {");
    });
  });

  describe("export default unwrapping", () => {
    it("unwraps export default arrow function", () => {
      const code = "export default async () => { return 1; }";
      expect(normalizeCode(code)).toBe("async () => { return 1; }");
    });

    it("unwraps export default sync arrow function", () => {
      const code = "export default () => { return 1; }";
      expect(normalizeCode(code)).toBe("() => { return 1; }");
    });

    it("unwraps export default expression and normalizes it", () => {
      const code = "export default 42";
      const result = normalizeCode(code);
      expect(result).toContain("return (42)");
    });
  });

  describe("named function declaration → auto-call", () => {
    it("wraps and calls a single named function", () => {
      const code = "async function doStuff() { return 42; }";
      const result = normalizeCode(code);
      expect(result).toContain(code);
      expect(result).toContain("return doStuff();");
      expect(result).toMatch(/^async \(\) => \{/);
    });

    it("wraps and calls a sync named function", () => {
      const code = "function compute() { return 1 + 2; }";
      const result = normalizeCode(code);
      expect(result).toContain(code);
      expect(result).toContain("return compute();");
    });

    it("does not auto-call when there are multiple statements", () => {
      // Multiple statements: function + a call → not a single FunctionDeclaration
      const code = "function helper() { return 1; }\nhelper()";
      const result = normalizeCode(code);
      // Last statement is expression → return insertion
      expect(result).toContain("return (helper())");
    });
  });

  describe("IIFE passthrough", () => {
    it("wraps IIFE with return (technically works)", () => {
      const code = "(async () => { return 42; })()";
      const result = normalizeCode(code);
      // Last expression → gets returned — this is functional
      expect(result).toContain("return ((async () => { return 42; })())");
    });
  });

  describe("top-level return (parse error in module mode)", () => {
    it("wraps top-level return — works by accident in catch branch", () => {
      const code = "return 42";
      const result = normalizeCode(code);
      // Parse error → caught → wrapped → actually works at runtime
      expect(result).toBe("async () => {\nreturn 42\n}");
    });
  });

  describe("combined LLM quirks", () => {
    it("handles code fences + export default + arrow", () => {
      const code = "```js\nexport default async () => { return 1; }\n```";
      expect(normalizeCode(code)).toBe("async () => { return 1; }");
    });

    it("handles code fences + named function", () => {
      const code =
        "```js\nasync function run() { return await codemode.searchWeb({ query: 'test' }); }\n```";
      const result = normalizeCode(code);
      expect(result).toContain("return run();");
      expect(result).not.toContain("```");
    });
  });
});
