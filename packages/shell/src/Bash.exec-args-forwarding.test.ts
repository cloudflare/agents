import { describe, expect, it } from "vitest";
import { Bash } from "./Shell";

describe("Bash exec args forwarding", () => {
  it("appends args once to the first command", async () => {
    const bash = new Bash();

    const result = await bash.exec("echo hi", { args: ["there"] });

    expect(result.stdout).toBe("hi there\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not append args to subsequent commands", async () => {
    const bash = new Bash();

    const result = await bash.exec("echo first\necho second", { args: ["x"] });

    expect(result.stdout).toBe("first x\nsecond\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("passes args literally without shell parsing", async () => {
    const bash = new Bash();

    const result = await bash.exec("printf '%s\\n'", {
      args: ["a b", "*.ts", "$HOME", "semi;colon"]
    });

    expect(result.stdout).toBe("a b\n*.ts\n$HOME\nsemi;colon\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
