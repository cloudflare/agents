import { describe, expect, it } from "vitest";
import {
  ConstantRegex,
  createUserRegex,
  type RegexLike,
  UserRegex
} from "./user-regex";

describe("UserRegex", () => {
  describe("constructor", () => {
    it("creates regex from pattern string", () => {
      const regex = new UserRegex("foo");
      expect(regex.source).toBe("foo");
      expect(regex.flags).toBe("");
    });

    it("creates regex with flags", () => {
      const regex = new UserRegex("foo", "gi");
      expect(regex.source).toBe("foo");
      expect(regex.flags).toBe("gi");
      expect(regex.global).toBe(true);
      expect(regex.ignoreCase).toBe(true);
    });

    it("throws on invalid pattern", () => {
      expect(() => new UserRegex("[")).toThrow();
    });
  });

  describe("test()", () => {
    it("returns true for matching input", () => {
      const regex = new UserRegex("foo");
      expect(regex.test("foobar")).toBe(true);
    });

    it("returns false for non-matching input", () => {
      const regex = new UserRegex("foo");
      expect(regex.test("bar")).toBe(false);
    });

    it("handles case-insensitive matching", () => {
      const regex = new UserRegex("foo", "i");
      expect(regex.test("FOO")).toBe(true);
    });

    it("resets lastIndex for global regex", () => {
      const regex = new UserRegex("a", "g");
      regex.lastIndex = 5;
      expect(regex.test("aaa")).toBe(true);
      // lastIndex should be reset before test
    });
  });

  describe("exec()", () => {
    it("returns match array for matching input", () => {
      const regex = new UserRegex("f(o+)");
      const result = regex.exec("foobar");
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe("foo");
      expect(result?.[1]).toBe("oo");
      expect(result?.index).toBe(0);
    });

    it("returns null for non-matching input", () => {
      const regex = new UserRegex("xyz");
      expect(regex.exec("foobar")).toBeNull();
    });

    it("advances lastIndex for global regex", () => {
      const regex = new UserRegex("a", "g");
      regex.exec("aaa");
      expect(regex.lastIndex).toBe(1);
      regex.exec("aaa");
      expect(regex.lastIndex).toBe(2);
    });
  });

  describe("match()", () => {
    it("returns first match without global flag", () => {
      const regex = new UserRegex("o+");
      const result = regex.match("foobar");
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe("oo");
    });

    it("returns all matches with global flag", () => {
      const regex = new UserRegex("o", "g");
      const result = regex.match("foobar");
      expect(result).toEqual(["o", "o"]);
    });

    it("returns null for non-matching input", () => {
      const regex = new UserRegex("xyz");
      expect(regex.match("foobar")).toBeNull();
    });

    it("resets lastIndex for global regex", () => {
      const regex = new UserRegex("o", "g");
      regex.lastIndex = 10;
      const result = regex.match("foobar");
      expect(result).toEqual(["o", "o"]);
    });
  });

  describe("replace()", () => {
    it("replaces first match without global flag", () => {
      const regex = new UserRegex("o");
      expect(regex.replace("foobar", "0")).toBe("f0obar");
    });

    it("replaces all matches with global flag", () => {
      const regex = new UserRegex("o", "g");
      expect(regex.replace("foobar", "0")).toBe("f00bar");
    });

    it("supports replacement patterns", () => {
      const regex = new UserRegex("(f)(o+)");
      expect(regex.replace("foobar", "$2$1")).toBe("oofbar");
    });

    it("supports callback replacement", () => {
      const regex = new UserRegex("o", "g");
      const result = regex.replace("foobar", (match) => match.toUpperCase());
      expect(result).toBe("fOObar");
    });

    it("callback receives capture groups", () => {
      const regex = new UserRegex("(o+)", "g");
      const result = regex.replace("foobar", (_match, group1) =>
        String(group1).toUpperCase()
      );
      expect(result).toBe("fOObar");
    });

    it("resets lastIndex for global regex", () => {
      const regex = new UserRegex("o", "g");
      regex.lastIndex = 10;
      expect(regex.replace("foobar", "0")).toBe("f00bar");
    });
  });

  describe("split()", () => {
    it("splits string by pattern", () => {
      const regex = new UserRegex(",\\s*");
      expect(regex.split("a, b,  c")).toEqual(["a", "b", "c"]);
    });

    it("respects limit parameter", () => {
      const regex = new UserRegex(",");
      expect(regex.split("a,b,c,d", 2)).toEqual(["a", "b"]);
    });

    it("handles no matches", () => {
      const regex = new UserRegex("x");
      expect(regex.split("abc")).toEqual(["abc"]);
    });

    it("handles empty strings between matches", () => {
      const regex = new UserRegex(",");
      expect(regex.split("a,,b")).toEqual(["a", "", "b"]);
    });
  });

  describe("search()", () => {
    it("returns index of first match", () => {
      const regex = new UserRegex("bar");
      expect(regex.search("foobar")).toBe(3);
    });

    it("returns -1 for no match", () => {
      const regex = new UserRegex("xyz");
      expect(regex.search("foobar")).toBe(-1);
    });
  });

  describe("matchAll()", () => {
    it("iterates over all matches", () => {
      const regex = new UserRegex("o+", "g");
      const matches = [...regex.matchAll("foobooo")];
      expect(matches).toHaveLength(2);
      expect(matches[0][0]).toBe("oo");
      expect(matches[1][0]).toBe("ooo");
    });

    it("includes capture groups", () => {
      const regex = new UserRegex("(o+)", "g");
      const matches = [...regex.matchAll("foobar")];
      expect(matches[0][1]).toBe("oo");
    });

    it("throws without global flag", () => {
      const regex = new UserRegex("o");
      expect(() => [...regex.matchAll("foo")]).toThrow(
        "matchAll requires global flag"
      );
    });

    // NOTE: RE2 does not support lookahead (?=) as it would break linear-time guarantee
    // This test uses a zero-length pattern that RE2 can handle
    it("handles zero-length matches", () => {
      // Use word boundary \b instead of lookahead - both produce zero-length matches
      const regex = new UserRegex("\\b", "g");
      const matches = [...regex.matchAll("a b")];
      // Word boundaries: before 'a', after 'a', before 'b', after 'b' = 4 matches
      expect(matches).toHaveLength(4);
    });

    it("resets lastIndex before iterating", () => {
      const regex = new UserRegex("o", "g");
      regex.lastIndex = 10;
      const matches = [...regex.matchAll("foo")];
      expect(matches).toHaveLength(2);
    });
  });

  describe("properties", () => {
    it("native returns underlying RegExp", () => {
      const regex = new UserRegex("foo", "gi");
      expect(regex.native).toBeInstanceOf(RegExp);
      expect(regex.native.source).toBe("foo");
    });

    it("multiline flag", () => {
      const regex = new UserRegex("^foo", "m");
      expect(regex.multiline).toBe(true);
    });

    it("lastIndex is readable and writable", () => {
      const regex = new UserRegex("a", "g");
      expect(regex.lastIndex).toBe(0);
      regex.lastIndex = 5;
      expect(regex.lastIndex).toBe(5);
    });
  });
});

describe("ConstantRegex", () => {
  describe("constructor", () => {
    it("wraps native RegExp literal", () => {
      const regex = new ConstantRegex(/foo/gi);
      expect(regex.source).toBe("foo");
      expect(regex.flags).toBe("gi");
    });
  });

  describe("test()", () => {
    it("returns true for matching input", () => {
      const regex = new ConstantRegex(/foo/);
      expect(regex.test("foobar")).toBe(true);
    });

    it("resets lastIndex for global regex", () => {
      const regex = new ConstantRegex(/a/g);
      regex.lastIndex = 5;
      expect(regex.test("aaa")).toBe(true);
    });
  });

  describe("match()", () => {
    it("returns all matches with global flag", () => {
      const regex = new ConstantRegex(/o/g);
      expect(regex.match("foobar")).toEqual(["o", "o"]);
    });

    it("resets lastIndex for global regex", () => {
      const regex = new ConstantRegex(/o/g);
      regex.lastIndex = 10;
      expect(regex.match("foobar")).toEqual(["o", "o"]);
    });
  });

  describe("replace()", () => {
    it("replaces matches", () => {
      const regex = new ConstantRegex(/o/g);
      expect(regex.replace("foobar", "0")).toBe("f00bar");
    });

    it("supports callback replacement", () => {
      const regex = new ConstantRegex(/\d+/g);
      const result = regex.replace("a1b22c333", (m) => `[${m}]`);
      expect(result).toBe("a[1]b[22]c[333]");
    });

    it("resets lastIndex for global regex", () => {
      const regex = new ConstantRegex(/o/g);
      regex.lastIndex = 10;
      expect(regex.replace("foobar", "0")).toBe("f00bar");
    });
  });

  describe("split()", () => {
    it("splits string by pattern", () => {
      const regex = new ConstantRegex(/\s+/);
      expect(regex.split("a b  c")).toEqual(["a", "b", "c"]);
    });
  });

  describe("search()", () => {
    it("returns index of first match", () => {
      const regex = new ConstantRegex(/\d/);
      expect(regex.search("abc123")).toBe(3);
    });
  });

  describe("matchAll()", () => {
    it("iterates over all matches", () => {
      const regex = new ConstantRegex(/\d+/g);
      const matches = [...regex.matchAll("a1b22c333")];
      expect(matches.map((m) => m[0])).toEqual(["1", "22", "333"]);
    });

    it("throws without global flag", () => {
      const regex = new ConstantRegex(/\d/);
      expect(() => [...regex.matchAll("123")]).toThrow(
        "matchAll requires global flag"
      );
    });
  });

  describe("exec()", () => {
    it("returns match with capture groups", () => {
      const regex = new ConstantRegex(/(\d+)/);
      const result = regex.exec("abc123def");
      expect(result?.[0]).toBe("123");
      expect(result?.[1]).toBe("123");
    });
  });

  describe("properties", () => {
    it("exposes all flag properties", () => {
      const regex = new ConstantRegex(/foo/gim);
      expect(regex.global).toBe(true);
      expect(regex.ignoreCase).toBe(true);
      expect(regex.multiline).toBe(true);
    });

    it("native returns underlying RegExp", () => {
      const nativeRe = /test/;
      const regex = new ConstantRegex(nativeRe);
      expect(regex.native).toBe(nativeRe);
    });
  });
});

describe("createUserRegex()", () => {
  it("creates UserRegex instance", () => {
    const regex = createUserRegex("foo", "g");
    expect(regex).toBeInstanceOf(UserRegex);
    expect(regex.source).toBe("foo");
    expect(regex.global).toBe(true);
  });

  it("defaults to empty flags", () => {
    const regex = createUserRegex("foo");
    expect(regex.flags).toBe("");
  });
});

describe("RegexLike interface compatibility", () => {
  const testCases: Array<{ name: string; create: () => RegexLike }> = [
    { name: "UserRegex", create: () => new UserRegex("\\d+", "g") },
    { name: "ConstantRegex", create: () => new ConstantRegex(/\d+/g) }
  ];

  for (const { name, create } of testCases) {
    describe(name, () => {
      it("implements RegexLike interface", () => {
        const regex = create();

        // All methods should be callable
        expect(typeof regex.test).toBe("function");
        expect(typeof regex.exec).toBe("function");
        expect(typeof regex.match).toBe("function");
        expect(typeof regex.replace).toBe("function");
        expect(typeof regex.split).toBe("function");
        expect(typeof regex.search).toBe("function");
        expect(typeof regex.matchAll).toBe("function");

        // All properties should be accessible
        expect(regex.native).toBeInstanceOf(RegExp);
        expect(typeof regex.source).toBe("string");
        expect(typeof regex.flags).toBe("string");
        expect(typeof regex.global).toBe("boolean");
        expect(typeof regex.ignoreCase).toBe("boolean");
        expect(typeof regex.multiline).toBe("boolean");
        expect(typeof regex.lastIndex).toBe("number");
      });

      it("produces same results for same pattern", () => {
        const regex = create();
        const input = "a1b22c333";

        expect(regex.test(input)).toBe(true);
        expect(regex.search(input)).toBe(1);
        expect(regex.match(input)).toEqual(["1", "22", "333"]);
        expect(regex.split(input)).toEqual(["a", "b", "c", ""]);
        expect(regex.replace(input, "X")).toBe("aXbXcX");
      });
    });
  }
});

describe("edge cases", () => {
  describe("special regex characters in pattern", () => {
    it("handles escaped special chars", () => {
      const regex = createUserRegex("\\[\\]\\(\\)");
      expect(regex.test("[]()")).toBe(true);
    });

    it("handles character classes", () => {
      const regex = createUserRegex("[a-z]+");
      expect(regex.match("ABC123def")?.[0]).toBe("def");
    });

    it("handles anchors", () => {
      const regex = createUserRegex("^foo$");
      expect(regex.test("foo")).toBe(true);
      expect(regex.test("foobar")).toBe(false);
    });
  });

  describe("empty and whitespace", () => {
    it("handles empty pattern", () => {
      const regex = createUserRegex("");
      expect(regex.test("anything")).toBe(true);
    });

    it("handles whitespace pattern", () => {
      const regex = createUserRegex("\\s+", "g");
      expect(regex.split("a b  c")).toEqual(["a", "b", "c"]);
    });
  });

  describe("unicode", () => {
    it("matches unicode characters", () => {
      const regex = createUserRegex("café");
      expect(regex.test("I love café")).toBe(true);
    });

    it("handles unicode with u flag", () => {
      const regex = createUserRegex("\\u{1F600}", "u");
      expect(regex.test("Hello 😀")).toBe(true);
    });
  });

  describe("dotAll flag", () => {
    it("dot matches newline with s flag", () => {
      const regex = createUserRegex("a.b", "s");
      expect(regex.test("a\nb")).toBe(true);
    });

    it("dot does not match newline without s flag", () => {
      const regex = createUserRegex("a.b");
      expect(regex.test("a\nb")).toBe(false);
    });
  });

  describe("capture groups", () => {
    it("handles named capture groups", () => {
      const regex = createUserRegex("(?<year>\\d{4})-(?<month>\\d{2})");
      const result = regex.exec("2024-01");
      expect(result?.groups).toEqual({ year: "2024", month: "01" });
    });

    it("handles nested groups", () => {
      const regex = createUserRegex("((a)(b))");
      const result = regex.exec("ab");
      expect(result?.[0]).toBe("ab");
      expect(result?.[1]).toBe("ab");
      expect(result?.[2]).toBe("a");
      expect(result?.[3]).toBe("b");
    });

    it("handles non-capturing groups", () => {
      const regex = createUserRegex("(?:a)(b)");
      const result = regex.exec("ab");
      expect(result?.[0]).toBe("ab");
      expect(result?.[1]).toBe("b");
      expect(result?.[2]).toBeUndefined();
    });
  });
});
