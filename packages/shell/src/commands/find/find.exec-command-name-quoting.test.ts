import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find -exec command name quoting", () => {
  it("executes quoted command names containing spaces", async () => {
    const bash = new Bash({
      files: {
        "/bin/my cmd.sh": "echo FIND:$1\n",
        "/dir/f.txt": ""
      }
    });

    await bash.exec("chmod +x '/bin/my cmd.sh'");
    const result = await bash.exec(
      "find /dir -type f -exec '/bin/my cmd.sh' {} \\;"
    );

    expect(result.stdout).toBe("FIND:/dir/f.txt\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
