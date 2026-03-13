import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("xargs command name quoting", () => {
  it("executes quoted command names containing spaces", async () => {
    const bash = new Bash({
      files: {
        "/bin/my cmd.sh": "echo XARGS:$1\n"
      }
    });

    await bash.exec("chmod +x '/bin/my cmd.sh'");
    const result = await bash.exec(
      "printf '/dir/f.txt\\n' | xargs -I {} '/bin/my cmd.sh' {}"
    );

    expect(result.stdout).toBe("XARGS:/dir/f.txt\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
