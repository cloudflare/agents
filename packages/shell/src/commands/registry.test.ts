import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Shell";
import {
  clearCommandCache,
  createLazyCommands,
  getLoadedCommandCount
} from "./registry";

describe("Command Registry", () => {
  beforeEach(() => {
    clearCommandCache();
  });

  it("should create lazy commands with correct names", () => {
    const commands = createLazyCommands();

    expect(commands.length).toBeGreaterThan(30);

    const names = commands.map((c) => c.name);
    expect(names).toContain("echo");
    expect(names).toContain("cat");
    expect(names).toContain("grep");
    expect(names).toContain("sed");
    expect(names).toContain("awk");
    expect(names).toContain("find");
    expect(names).toContain("ls");
    expect(names).toContain("mkdir");
    expect(names).toContain("bash");
    expect(names).toContain("sh");
  });

  it("should load command on first execution", async () => {
    expect(getLoadedCommandCount()).toBe(0);

    const env = new Bash();
    const result = await env.exec("echo hello world");

    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
    expect(getLoadedCommandCount()).toBeGreaterThan(0);
  });

  it("should cache commands after loading", async () => {
    const env = new Bash();

    await env.exec("echo first");
    const countAfterFirst = getLoadedCommandCount();

    await env.exec("echo second");
    const countAfterSecond = getLoadedCommandCount();

    // Same command shouldn't increase count
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("should load different commands independently", async () => {
    const env = new Bash({ files: { "/test.txt": "content" } });

    await env.exec("echo test");
    const countAfterEcho = getLoadedCommandCount();

    await env.exec("cat /test.txt");
    const countAfterCat = getLoadedCommandCount();

    expect(countAfterCat).toBeGreaterThan(countAfterEcho);
  });

  it("should clear cache correctly", async () => {
    const env = new Bash();

    await env.exec("echo test");
    expect(getLoadedCommandCount()).toBeGreaterThan(0);

    clearCommandCache();
    expect(getLoadedCommandCount()).toBe(0);
  });
});
