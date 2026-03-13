import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./in-memory-fs";

describe("InMemoryFs Buffer and Encoding Support", () => {
  describe("basic Buffer operations", () => {
    it("should write and read Uint8Array", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await fs.writeFile("/binary.bin", data);
      const result = await fs.readFileBuffer("/binary.bin");

      expect(result).toEqual(data);
    });

    it("should write Uint8Array and read as string", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await fs.writeFile("/test.txt", data);
      const result = await fs.readFile("/test.txt");

      expect(result).toBe("Hello");
    });

    it("should write string and read as Uint8Array", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      const result = await fs.readFileBuffer("/test.txt");

      expect(result).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    });

    it("should handle binary data with null bytes", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x00, 0x01, 0x00, 0xff, 0x00]);

      await fs.writeFile("/binary.bin", data);
      const result = await fs.readFileBuffer("/binary.bin");

      expect(result).toEqual(data);
    });

    it("should calculate correct size for binary files", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);

      await fs.writeFile("/binary.bin", data);
      const stat = await fs.stat("/binary.bin");

      expect(stat.size).toBe(5);
    });
  });

  describe("encoding support", () => {
    it("should write and read with utf8 encoding", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello 世界", "utf8");
      const result = await fs.readFile("/test.txt", "utf8");

      expect(result).toBe("Hello 世界");
    });

    it("should write and read with base64 encoding", async () => {
      const fs = new InMemoryFs();

      // "Hello" in base64 is "SGVsbG8="
      await fs.writeFile("/test.txt", "SGVsbG8=", "base64");
      const result = await fs.readFile("/test.txt", "utf8");

      expect(result).toBe("Hello");
    });

    it("should read as base64", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      const result = await fs.readFile("/test.txt", "base64");

      expect(result).toBe("SGVsbG8=");
    });

    it("should write and read with hex encoding", async () => {
      const fs = new InMemoryFs();

      // "Hello" in hex is "48656c6c6f"
      await fs.writeFile("/test.txt", "48656c6c6f", "hex");
      const result = await fs.readFile("/test.txt", "utf8");

      expect(result).toBe("Hello");
    });

    it("should read as hex", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      const result = await fs.readFile("/test.txt", "hex");

      expect(result).toBe("48656c6c6f");
    });

    it("should write with latin1 encoding", async () => {
      const fs = new InMemoryFs();

      // Latin1 character é is 0xe9
      await fs.writeFile("/test.txt", "café", "latin1");
      const buffer = await fs.readFileBuffer("/test.txt");

      expect(buffer).toEqual(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    });

    it("should support encoding in options object", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "SGVsbG8=", { encoding: "base64" });
      const result = await fs.readFile("/test.txt", { encoding: "utf8" });

      expect(result).toBe("Hello");
    });
  });

  describe("appendFile with Buffer", () => {
    it("should append Uint8Array to existing file", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      await fs.appendFile(
        "/test.txt",
        new Uint8Array([0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64])
      ); // " World"

      const result = await fs.readFile("/test.txt");
      expect(result).toBe("Hello World");
    });

    it("should append string to file with Buffer content", async () => {
      const fs = new InMemoryFs();
      const initial = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await fs.writeFile("/test.txt", initial);
      await fs.appendFile("/test.txt", " World");

      const result = await fs.readFile("/test.txt");
      expect(result).toBe("Hello World");
    });

    it("should append with encoding", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      // " World" in base64 is "IFdvcmxk"
      await fs.appendFile("/test.txt", "IFdvcmxk", "base64");

      const result = await fs.readFile("/test.txt");
      expect(result).toBe("Hello World");
    });
  });

  describe("constructor with Buffer content", () => {
    it("should initialize files with Uint8Array content", async () => {
      const fs = new InMemoryFs({
        "/binary.bin": new Uint8Array([0x00, 0x01, 0x02]),
        "/text.txt": "Hello"
      });

      const binary = await fs.readFileBuffer("/binary.bin");
      const text = await fs.readFile("/text.txt");

      expect(binary).toEqual(new Uint8Array([0x00, 0x01, 0x02]));
      expect(text).toBe("Hello");
    });
  });

  describe("edge cases", () => {
    it("should handle empty Uint8Array", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/empty.bin", new Uint8Array(0));
      const result = await fs.readFileBuffer("/empty.bin");

      expect(result).toEqual(new Uint8Array(0));
      expect(result.length).toBe(0);
    });

    it("should handle large binary files", async () => {
      const fs = new InMemoryFs();
      const size = 1024 * 1024; // 1MB
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }

      await fs.writeFile("/large.bin", data);
      const result = await fs.readFileBuffer("/large.bin");

      expect(result.length).toBe(size);
      expect(result[0]).toBe(0);
      expect(result[255]).toBe(255);
      expect(result[256]).toBe(0);
    });

    it("should preserve binary content through copy", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x00, 0xff, 0x00, 0xff]);

      await fs.writeFile("/src.bin", data);
      await fs.cp("/src.bin", "/dst.bin");

      const result = await fs.readFileBuffer("/dst.bin");
      expect(result).toEqual(data);
    });

    it("should follow symlinks for binary files", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x48, 0x69]);

      await fs.writeFile("/real.bin", data);
      await fs.symlink("/real.bin", "/link.bin");

      const result = await fs.readFileBuffer("/link.bin");
      expect(result).toEqual(data);
    });
  });
});

describe("InMemoryFs readdirWithFileTypes", () => {
  it("should return entries with correct type info", async () => {
    const fs = new InMemoryFs({
      "/dir/file.txt": "content",
      "/dir/subdir/nested.txt": "nested"
    });

    const entries = await fs.readdirWithFileTypes("/dir");

    expect(entries).toHaveLength(2);

    const file = entries.find((e) => e.name === "file.txt");
    expect(file).toBeDefined();
    expect(file?.isFile).toBe(true);
    expect(file?.isDirectory).toBe(false);
    expect(file?.isSymbolicLink).toBe(false);

    const subdir = entries.find((e) => e.name === "subdir");
    expect(subdir).toBeDefined();
    expect(subdir?.isFile).toBe(false);
    expect(subdir?.isDirectory).toBe(true);
    expect(subdir?.isSymbolicLink).toBe(false);
  });

  it("should return entries sorted case-sensitively", async () => {
    const fs = new InMemoryFs({
      "/dir/Zebra.txt": "z",
      "/dir/apple.txt": "a",
      "/dir/Banana.txt": "b"
    });

    const entries = await fs.readdirWithFileTypes("/dir");
    const names = entries.map((e) => e.name);

    // Case-sensitive sort: uppercase before lowercase
    expect(names).toEqual(["Banana.txt", "Zebra.txt", "apple.txt"]);
  });

  it("should identify symlinks correctly", async () => {
    const fs = new InMemoryFs({
      "/dir/real.txt": "content"
    });
    await fs.symlink("/dir/real.txt", "/dir/link.txt");

    const entries = await fs.readdirWithFileTypes("/dir");

    const link = entries.find((e) => e.name === "link.txt");
    expect(link).toBeDefined();
    expect(link?.isFile).toBe(false);
    expect(link?.isDirectory).toBe(false);
    expect(link?.isSymbolicLink).toBe(true);
  });

  it("should throw ENOENT for non-existent directory", async () => {
    const fs = new InMemoryFs();

    await expect(fs.readdirWithFileTypes("/nonexistent")).rejects.toThrow(
      "ENOENT"
    );
  });

  it("should throw ENOTDIR for file path", async () => {
    const fs = new InMemoryFs({
      "/file.txt": "content"
    });

    await expect(fs.readdirWithFileTypes("/file.txt")).rejects.toThrow(
      "ENOTDIR"
    );
  });

  it("should return same names as readdir", async () => {
    const fs = new InMemoryFs({
      "/dir/a.txt": "a",
      "/dir/b.txt": "b",
      "/dir/sub/c.txt": "c"
    });

    const namesFromReaddir = await fs.readdir("/dir");
    const entriesWithTypes = await fs.readdirWithFileTypes("/dir");
    const namesFromWithTypes = entriesWithTypes.map((e) => e.name);

    expect(namesFromWithTypes).toEqual(namesFromReaddir);
  });
});

describe("InMemoryFs lazy files", () => {
  it("should read lazy file content", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "lazy content"
    });

    const result = await fs.readFile("/lazy.txt");
    expect(result).toBe("lazy content");
  });

  it("should call the lazy function only once", async () => {
    const provider = vi.fn(() => "computed");
    const fs = new InMemoryFs({
      "/lazy.txt": provider
    });

    await fs.readFile("/lazy.txt");
    await fs.readFile("/lazy.txt");
    await fs.readFile("/lazy.txt");

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("should return Uint8Array from lazy provider", async () => {
    const data = new Uint8Array([0x48, 0x69]);
    const fs = new InMemoryFs({
      "/lazy.bin": () => data
    });

    const result = await fs.readFileBuffer("/lazy.bin");
    expect(result).toEqual(data);
  });

  it("should replace lazy entry when written to", async () => {
    const provider = vi.fn(() => "original");
    const fs = new InMemoryFs({
      "/lazy.txt": provider
    });

    await fs.writeFile("/lazy.txt", "overwritten");
    const result = await fs.readFile("/lazy.txt");

    expect(result).toBe("overwritten");
    expect(provider).not.toHaveBeenCalled();
  });

  it("should materialize on stat and return correct size", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "hello"
    });

    const stat = await fs.stat("/lazy.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);
  });

  it("should materialize on lstat and return correct size", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "hello"
    });

    const stat = await fs.lstat("/lazy.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);
  });

  it("should handle appendFile on lazy file", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "hello"
    });

    await fs.appendFile("/lazy.txt", " world");
    const result = await fs.readFile("/lazy.txt");
    expect(result).toBe("hello world");
  });

  it("should work via writeFileLazy", async () => {
    const fs = new InMemoryFs();
    fs.writeFileLazy("/dynamic.txt", () => "dynamic content");

    const result = await fs.readFile("/dynamic.txt");
    expect(result).toBe("dynamic content");
  });

  it("should copy lazy files via cp", async () => {
    const provider = vi.fn(() => "lazy data");
    const fs = new InMemoryFs({
      "/src.txt": provider
    });

    await fs.cp("/src.txt", "/dst.txt");

    // Neither copy has been read yet
    expect(provider).not.toHaveBeenCalled();

    const result = await fs.readFile("/dst.txt");
    expect(result).toBe("lazy data");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("should show lazy file in exists check", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "exists"
    });

    expect(await fs.exists("/lazy.txt")).toBe(true);
  });

  it("should show lazy file in readdir", async () => {
    const fs = new InMemoryFs({
      "/dir/lazy.txt": () => "content",
      "/dir/eager.txt": "content"
    });

    const entries = await fs.readdir("/dir");
    expect(entries).toContain("lazy.txt");
    expect(entries).toContain("eager.txt");
  });

  it("should support async lazy providers", async () => {
    const fs = new InMemoryFs({
      "/async.txt": async () => "async content"
    });

    const result = await fs.readFile("/async.txt");
    expect(result).toBe("async content");
  });

  it("should support async lazy provider returning Uint8Array", async () => {
    const data = new Uint8Array([0x41, 0x42]);
    const fs = new InMemoryFs({
      "/async.bin": async () => data
    });

    const result = await fs.readFileBuffer("/async.bin");
    expect(result).toEqual(data);
  });

  it("should call async lazy provider only once", async () => {
    const provider = vi.fn(async () => "once");
    const fs = new InMemoryFs({
      "/async.txt": provider
    });

    await fs.readFile("/async.txt");
    await fs.readFile("/async.txt");
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
