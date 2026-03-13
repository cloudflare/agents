import { describe, expect, it } from "vitest";
import { GitignoreParser } from "./gitignore";

describe("GitignoreParser", () => {
  describe("simple patterns", () => {
    it("should match file extension patterns", () => {
      const parser = new GitignoreParser();
      parser.parse("*.log");
      expect(parser.matches("debug.log", false)).toBe(true);
      expect(parser.matches("error.log", false)).toBe(true);
      expect(parser.matches("app.ts", false)).toBe(false);
    });

    it("should match exact file names", () => {
      const parser = new GitignoreParser();
      parser.parse("package-lock.json");
      expect(parser.matches("package-lock.json", false)).toBe(true);
      expect(parser.matches("package.json", false)).toBe(false);
    });

    it("should match directory names", () => {
      const parser = new GitignoreParser();
      parser.parse("node_modules");
      expect(parser.matches("node_modules", true)).toBe(true);
      expect(parser.matches("src/node_modules", true)).toBe(true);
    });
  });

  describe("negation patterns", () => {
    it("should negate previous patterns", () => {
      const parser = new GitignoreParser();
      parser.parse("*.log\n!important.log");
      expect(parser.matches("debug.log", false)).toBe(true);
      expect(parser.matches("important.log", false)).toBe(false);
    });

    it("should handle multiple negations", () => {
      const parser = new GitignoreParser();
      parser.parse("*\n!src\n!*.ts");
      expect(parser.matches("README.md", false)).toBe(true);
      expect(parser.matches("app.ts", false)).toBe(false);
      expect(parser.matches("src", true)).toBe(false);
    });
  });

  describe("directory-only patterns", () => {
    it("should only match directories with trailing slash", () => {
      const parser = new GitignoreParser();
      parser.parse("build/");
      expect(parser.matches("build", true)).toBe(true);
      expect(parser.matches("build", false)).toBe(false);
    });
  });

  describe("rooted patterns", () => {
    it("should only match at root with leading slash", () => {
      const parser = new GitignoreParser();
      parser.parse("/todo.txt");
      expect(parser.matches("todo.txt", false)).toBe(true);
      expect(parser.matches("docs/todo.txt", false)).toBe(false);
    });

    it("should be rooted when pattern contains slash", () => {
      const parser = new GitignoreParser();
      parser.parse("doc/frotz");
      expect(parser.matches("doc/frotz", false)).toBe(true);
      expect(parser.matches("a/doc/frotz", false)).toBe(false);
    });
  });

  describe("double-star patterns", () => {
    it("should match any directory depth", () => {
      const parser = new GitignoreParser();
      parser.parse("**/foo");
      expect(parser.matches("foo", false)).toBe(true);
      expect(parser.matches("a/foo", false)).toBe(true);
      expect(parser.matches("a/b/c/foo", false)).toBe(true);
    });

    it("should match trailing double-star", () => {
      const parser = new GitignoreParser();
      parser.parse("abc/**");
      expect(parser.matches("abc/def", false)).toBe(true);
      expect(parser.matches("abc/def/ghi", false)).toBe(true);
      expect(parser.matches("abc", false)).toBe(false);
    });
  });

  describe("comments and blank lines", () => {
    it("should ignore comments", () => {
      const parser = new GitignoreParser();
      parser.parse("# This is a comment\n*.log");
      expect(parser.matches("debug.log", false)).toBe(true);
    });

    it("should ignore blank lines", () => {
      const parser = new GitignoreParser();
      parser.parse("*.log\n\n*.tmp");
      expect(parser.matches("debug.log", false)).toBe(true);
      expect(parser.matches("cache.tmp", false)).toBe(true);
    });
  });

  describe("special characters", () => {
    it("should handle question mark wildcard", () => {
      const parser = new GitignoreParser();
      parser.parse("file?.txt");
      expect(parser.matches("file1.txt", false)).toBe(true);
      expect(parser.matches("fileA.txt", false)).toBe(true);
      expect(parser.matches("file12.txt", false)).toBe(false);
    });

    it("should handle character classes", () => {
      const parser = new GitignoreParser();
      parser.parse("file[0-9].txt");
      expect(parser.matches("file0.txt", false)).toBe(true);
      expect(parser.matches("file9.txt", false)).toBe(true);
      expect(parser.matches("fileA.txt", false)).toBe(false);
    });

    it("should handle negated character classes", () => {
      const parser = new GitignoreParser();
      parser.parse("file[!0-9].txt");
      expect(parser.matches("file0.txt", false)).toBe(false);
      expect(parser.matches("fileA.txt", false)).toBe(true);
    });
  });
});
