import { describe, expect, it } from "vitest";
import { Bash } from "./Shell";

describe("Bash General", () => {
  describe("pipes", () => {
    it("should pipe output between commands", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\nhello\n" }
      });
      const result = await env.exec("cat /test.txt | grep hello");
      expect(result.stdout).toBe("hello\nhello\n");
    });

    it("should support multiple pipes", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\nline4\nline5\n" }
      });
      const result = await env.exec("cat /test.txt | head -n 3 | tail -n 1");
      expect(result.stdout).toBe("line3\n");
    });

    it("should pipe echo to grep", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "foo\\nbar\\nfoo" | grep foo');
      expect(result.stdout).toBe("foo\nfoo\n");
    });

    it("should pipe through wc", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "one\\ntwo\\nthree" | wc -l');
      expect(result.stdout.trim()).toBe("3");
    });

    it("should pipe ls to grep", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "",
          "/dir/file.md": "",
          "/dir/other.js": ""
        }
      });
      const result = await env.exec("ls /dir | grep file");
      expect(result.stdout).toContain("file.txt");
      expect(result.stdout).toContain("file.md");
      expect(result.stdout).not.toContain("other.js");
    });

    it("should handle long pipe chains", async () => {
      const env = new Bash();
      const result = await env.exec('echo "hello world" | cat | cat | cat');
      expect(result.stdout).toBe("hello world\n");
    });

    it("should pass exit code through pipe", async () => {
      const env = new Bash({
        files: { "/test.txt": "no match\n" }
      });
      const result = await env.exec("cat /test.txt | grep missing");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("output redirection", () => {
    it("should redirect output to file with >", async () => {
      const env = new Bash();
      await env.exec("echo hello > /output.txt");
      const content = await env.readFile("/output.txt");
      expect(content).toBe("hello\n");
    });

    it("should overwrite existing file with >", async () => {
      const env = new Bash({
        files: { "/output.txt": "old content\n" }
      });
      await env.exec("echo new > /output.txt");
      const content = await env.readFile("/output.txt");
      expect(content).toBe("new\n");
    });

    it("should append with >>", async () => {
      const env = new Bash({
        files: { "/output.txt": "line1\n" }
      });
      await env.exec("echo line2 >> /output.txt");
      const content = await env.readFile("/output.txt");
      expect(content).toBe("line1\nline2\n");
    });

    it("should create file when appending to non-existent", async () => {
      const env = new Bash();
      await env.exec("echo first >> /new.txt");
      const content = await env.readFile("/new.txt");
      expect(content).toBe("first\n");
    });

    it("should redirect command output to file", async () => {
      const env = new Bash({
        files: { "/input.txt": "hello world\n" }
      });
      await env.exec("cat /input.txt > /output.txt");
      const content = await env.readFile("/output.txt");
      expect(content).toBe("hello world\n");
    });

    it("should redirect simple output to file", async () => {
      const env = new Bash();
      await env.exec('echo "line 1" > /output.txt');
      await env.exec('echo "line 2" >> /output.txt');
      const content = await env.readFile("/output.txt");
      expect(content).toBe("line 1\nline 2\n");
    });

    it("should handle redirection with spaces", async () => {
      const env = new Bash();
      await env.exec("echo test   >   /output.txt");
      const content = await env.readFile("/output.txt");
      expect(content).toBe("test\n");
    });
  });

  describe("environment variables", () => {
    it("should expand $VAR", async () => {
      const env = new Bash({
        env: { NAME: "world" }
      });
      const result = await env.exec("echo hello $NAME");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should expand ${VAR}", async () => {
      const env = new Bash({
        env: { NAME: "world" }
      });
      const result = await env.exec("echo hello ${NAME}");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should expand ${VAR} adjacent to text", async () => {
      const env = new Bash({
        env: { PREFIX: "pre" }
      });
      const result = await env.exec("echo ${PREFIX}fix");
      expect(result.stdout).toBe("prefix\n");
    });

    it("should handle default values with ${VAR:-default}", async () => {
      const env = new Bash();
      const result = await env.exec("echo ${MISSING:-default}");
      expect(result.stdout).toBe("default\n");
    });

    it("should use value when set with ${VAR:-default}", async () => {
      const env = new Bash({
        env: { SET: "value" }
      });
      const result = await env.exec("echo ${SET:-default}");
      expect(result.stdout).toBe("value\n");
    });

    it("should expand empty for unset variable", async () => {
      const env = new Bash();
      const result = await env.exec('echo "value:$UNSET:"');
      expect(result.stdout).toBe("value::\n");
    });

    it("should set variables with export (within same exec)", async () => {
      const env = new Bash();
      // Each exec is a new shell - export only persists within the same exec
      const result = await env.exec("export FOO=bar; echo $FOO");
      expect(result.stdout).toBe("bar\n");
    });

    it("should set multiple variables with export (within same exec)", async () => {
      const env = new Bash();
      const result = await env.exec("export A=1 B=2 C=3; echo $A $B $C");
      expect(result.stdout).toBe("1 2 3\n");
    });

    it("should unset variables (within same exec)", async () => {
      const env = new Bash({
        env: { FOO: "bar" }
      });
      // unset only affects the current exec
      const result = await env.exec('unset FOO; echo "v:$FOO:"');
      expect(result.stdout).toBe("v::\n");
    });

    it("should unset multiple variables (within same exec)", async () => {
      const env = new Bash({
        env: { A: "1", B: "2" }
      });
      const result = await env.exec('unset A B; echo "$A$B"');
      expect(result.stdout).toBe("\n");
    });

    it("export does not persist across exec calls", async () => {
      const env = new Bash();
      await env.exec("export FOO=bar");
      // Each exec is a new shell - FOO is not set
      const result = await env.exec("echo $FOO");
      expect(result.stdout).toBe("\n");
    });

    it("should return final env in result", async () => {
      const env = new Bash({ env: { INITIAL: "value" } });
      const result = await env.exec("export NEW_VAR=hello");
      expect(result.env.INITIAL).toBe("value");
      expect(result.env.NEW_VAR).toBe("hello");
    });

    it("should return env with modified values", async () => {
      const env = new Bash({ env: { FOO: "original" } });
      const result = await env.exec("export FOO=modified");
      expect(result.env.FOO).toBe("modified");
    });

    it("should return env with unset values removed", async () => {
      const env = new Bash({ env: { TO_REMOVE: "value" } });
      const result = await env.exec("unset TO_REMOVE");
      expect(result.env.TO_REMOVE).toBeUndefined();
    });

    it("should return env even for empty command", async () => {
      const env = new Bash({ env: { EXISTING: "value" } });
      const result = await env.exec("");
      expect(result.env.EXISTING).toBe("value");
    });

    it("should use HOME variable", async () => {
      const env = new Bash({
        env: { HOME: "/home/user" }
      });
      const result = await env.exec("echo $HOME");
      expect(result.stdout).toBe("/home/user\n");
    });

    it("should expand variable in path", async () => {
      const env = new Bash({
        files: { "/home/user/file.txt": "content" },
        env: { HOME: "/home/user" }
      });
      const result = await env.exec("cat $HOME/file.txt");
      expect(result.stdout).toBe("content");
    });

    it("should expand multiple variables in one line", async () => {
      const env = new Bash({
        env: { A: "hello", B: "world" }
      });
      const result = await env.exec("echo $A $B");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should expand variables in double quotes", async () => {
      const env = new Bash({
        env: { VAR: "value" }
      });
      const result = await env.exec('echo "$VAR"');
      expect(result.stdout).toBe("value\n");
    });
  });

  describe("command chaining", () => {
    it("should run commands with &&", async () => {
      const env = new Bash();
      const result = await env.exec("echo first && echo second");
      expect(result.stdout).toBe("first\nsecond\n");
    });

    it("should not run second command if first fails with &&", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing && echo second");
      expect(result.stdout).not.toContain("second");
      expect(result.exitCode).toBe(1);
    });

    it("should run second command with || if first fails", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing || echo fallback");
      expect(result.stdout).toBe("fallback\n");
    });

    it("should stop at first success with ||", async () => {
      const env = new Bash({
        files: { "/marker.txt": "" }
      });
      // When first command succeeds, || should stop there
      // We verify by checking that the marker file still exists (wasn't deleted)
      await env.exec("cat /missing || rm /marker.txt");
      // Since cat fails, rm should run and delete the marker
      const result1 = await env.exec("cat /marker.txt");
      expect(result1.exitCode).toBe(1); // marker was deleted

      // Reset
      await env.writeFile("/marker.txt", "");
      // Now first command succeeds, so second should NOT run
      await env.exec("echo ok || rm /marker.txt");
      const result2 = await env.exec("cat /marker.txt");
      expect(result2.exitCode).toBe(0); // marker still exists
    });

    it("should run commands with ; regardless of exit code", async () => {
      const env = new Bash();
      const result = await env.exec("echo first ; echo second");
      expect(result.stdout).toBe("first\nsecond\n");
    });

    it("should run commands with ; even if first fails", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing ; echo second");
      expect(result.stdout).toContain("second");
    });

    it("should chain multiple && operators", async () => {
      const env = new Bash();
      const result = await env.exec("echo a && echo b && echo c");
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should short-circuit && chain on failure", async () => {
      const env = new Bash();
      const result = await env.exec("echo a && cat /missing && echo c");
      expect(result.stdout).toContain("a");
      expect(result.stdout).not.toContain("c");
    });

    it("should chain || operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /missing || cat /missing2 || echo fallback"
      );
      expect(result.stdout).toBe("fallback\n");
    });

    it("should combine && and ||", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /missing && echo success || echo failure"
      );
      expect(result.stdout).toContain("failure");
      expect(result.stdout).not.toContain("success");
    });
  });

  describe("exit codes", () => {
    it("should return 0 for successful command", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello");
      expect(result.exitCode).toBe(0);
    });

    it("should return non-zero for failed command", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing");
      expect(result.exitCode).not.toBe(0);
    });

    it("should return 127 for unknown command", async () => {
      const env = new Bash();
      const result = await env.exec("unknowncommand");
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("command not found");
    });

    it("should handle exit command", async () => {
      const env = new Bash();
      const result = await env.exec("exit 0");
      expect(result.exitCode).toBe(0);
    });

    it("should handle exit with non-zero code", async () => {
      const env = new Bash();
      const result = await env.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("should return exit code from last command in pipe", async () => {
      const env = new Bash();
      const result = await env.exec("echo test | grep missing");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("cd command", () => {
    it("should change directory within same exec", async () => {
      const env = new Bash({
        files: { "/home/user/.keep": "" }
      });
      // cd works within the same exec
      const result = await env.exec("cd /home/user; pwd");
      expect(result.stdout).toBe("/home/user\n");
    });

    it("cd does not persist across exec calls", async () => {
      const env = new Bash({
        files: { "/home/user/.keep": "" },
        cwd: "/"
      });
      await env.exec("cd /home/user");
      // Each exec is a new shell - cwd resets to initial value
      expect(env.getCwd()).toBe("/");
      const result = await env.exec("pwd");
      expect(result.stdout).toBe("/\n");
    });

    it("should go to HOME with cd alone", async () => {
      const env = new Bash({
        files: { "/home/.keep": "" },
        env: { HOME: "/home" },
        cwd: "/tmp"
      });
      const result = await env.exec("cd; pwd");
      expect(result.stdout).toBe("/home\n");
    });

    it("should go to HOME with cd ~", async () => {
      const env = new Bash({
        files: { "/home/user/.keep": "" },
        env: { HOME: "/home/user" },
        cwd: "/tmp"
      });
      const result = await env.exec("cd ~; pwd");
      expect(result.stdout).toBe("/home/user\n");
    });

    it("should handle cd - within same exec", async () => {
      const env = new Bash({
        files: {
          "/dir1/.keep": "",
          "/dir2/.keep": ""
        }
      });
      // cd - works within the same exec
      const result = await env.exec("cd /dir1; cd /dir2; cd -; pwd");
      expect(result.stdout).toContain("/dir1\n");
    });

    it("should handle cd ..", async () => {
      const env = new Bash({
        files: { "/parent/child/.keep": "" },
        cwd: "/parent/child"
      });
      const result = await env.exec("cd ..; pwd");
      expect(result.stdout).toBe("/parent\n");
    });

    it("should error on non-existent directory", async () => {
      const env = new Bash();
      const result = await env.exec("cd /nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file or directory");
    });

    it("should error when cd to file", async () => {
      const env = new Bash({
        files: { "/file.txt": "content" }
      });
      const result = await env.exec("cd /file.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not a directory");
    });

    it("should handle relative path cd", async () => {
      const env = new Bash({
        files: { "/home/user/projects/.keep": "" },
        cwd: "/home/user"
      });
      const result = await env.exec("cd projects; pwd");
      expect(result.stdout).toBe("/home/user/projects\n");
    });
  });

  describe("quoting", () => {
    it("should preserve spaces in double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "hello   world"');
      expect(result.stdout).toBe("hello   world\n");
    });

    it("should preserve spaces in single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello   world'");
      expect(result.stdout).toBe("hello   world\n");
    });

    it("should handle nested quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "it\'s working"');
      expect(result.stdout).toBe("it's working\n");
    });

    it("should handle escaped quotes in double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "say \\"hello\\""');
      expect(result.stdout).toBe('say "hello"\n');
    });

    it("should handle empty string argument", async () => {
      const env = new Bash();
      const result = await env.exec('echo ""');
      expect(result.stdout).toBe("\n");
    });
  });

  describe("file access API", () => {
    it("should read files via API", async () => {
      const env = new Bash({
        files: { "/test.txt": "content" }
      });
      const content = await env.readFile("/test.txt");
      expect(content).toBe("content");
    });

    it("should write files via API", async () => {
      const env = new Bash();
      await env.writeFile("/test.txt", "new content");
      const content = await env.readFile("/test.txt");
      expect(content).toBe("new content");
    });

    it("should read relative paths via API", async () => {
      const env = new Bash({
        files: { "/home/user/file.txt": "content" },
        cwd: "/home/user"
      });
      const content = await env.readFile("file.txt");
      expect(content).toBe("content");
    });

    it("should write relative paths via API", async () => {
      const env = new Bash({
        files: { "/home/user/.keep": "" },
        cwd: "/home/user"
      });
      await env.writeFile("new.txt", "content");
      const content = await env.readFile("/home/user/new.txt");
      expect(content).toBe("content");
    });

    it("should get current working directory", async () => {
      const env = new Bash({ cwd: "/home/user" });
      expect(env.getCwd()).toBe("/home/user");
    });

    it("should get environment variables", async () => {
      const env = new Bash({
        env: { FOO: "bar", BAZ: "qux" }
      });
      const envVars = env.getEnv();
      expect(envVars.FOO).toBe("bar");
      expect(envVars.BAZ).toBe("qux");
    });
  });

  describe("empty and whitespace", () => {
    it("should handle empty command", async () => {
      const env = new Bash();
      const result = await env.exec("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("should handle whitespace-only command", async () => {
      const env = new Bash();
      const result = await env.exec("   ");
      expect(result.exitCode).toBe(0);
    });

    it("should handle command with extra whitespace", async () => {
      const env = new Bash();
      const result = await env.exec("   echo   hello   world   ");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should handle tabs as whitespace", async () => {
      const env = new Bash();
      const result = await env.exec("echo\thello\tworld");
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("default layout", () => {
    it("should create /home/user as default cwd", async () => {
      const env = new Bash();
      expect(env.getCwd()).toBe("/home/user");
    });

    it("should create /bin with command stubs", async () => {
      const env = new Bash();
      const result = await env.exec("ls /bin");
      expect(result.stdout).toContain("ls");
      expect(result.stdout).toContain("cat");
      expect(result.stdout).toContain("grep");
      expect(result.stdout).toContain("echo");
    });

    it("should create /tmp directory", async () => {
      const env = new Bash();
      const result = await env.exec("ls /tmp");
      expect(result.exitCode).toBe(0);
    });

    it("should allow running commands via /bin path", async () => {
      const env = new Bash();
      const result = await env.exec("/bin/echo hello");
      expect(result.stdout).toBe("hello\n");
    });

    it("should set HOME to /home/user", async () => {
      const env = new Bash();
      const result = await env.exec("echo $HOME");
      expect(result.stdout).toBe("/home/user\n");
    });

    it("should not create default layout when files are provided", async () => {
      const env = new Bash({ files: { "/test.txt": "content" } });
      expect(env.getCwd()).toBe("/");
      // /bin always exists for PATH-based command resolution, but /home/user doesn't
      const result = await env.exec("ls /home/user");
      expect(result.exitCode).not.toBe(0); // /home/user doesn't exist
      expect(result.stderr).toContain("No such file or directory");
    });

    it("should not create default layout when cwd is provided", async () => {
      const env = new Bash({ cwd: "/custom" });
      // /bin always exists for PATH-based command resolution, but /home/user doesn't
      const result = await env.exec("ls /home/user");
      expect(result.exitCode).not.toBe(0); // /home/user doesn't exist
      expect(result.stderr).toContain("No such file or directory");
    });
  });
});
