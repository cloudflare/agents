import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("timeout command name quoting", () => {
  it("executes quoted command names containing spaces", async () => {
    const bash = new Bash({
      files: {
        "/bin/my cmd.sh": "echo TIMEOUT_OK\n"
      }
    });

    await bash.exec("chmod +x '/bin/my cmd.sh'");
    const result = await bash.exec("timeout 1 '/bin/my cmd.sh'");

    expect(result.stdout).toBe("TIMEOUT_OK\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
