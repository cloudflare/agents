import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("break builtin", () => {
  describe("basic break", () => {
    it("should exit for loop early", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -eq 3 ]; then break; fi
          echo $i
        done
        echo done
      `);
      expect(result.stdout).toBe("1\n2\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should exit while loop early", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=0
        while [ $x -lt 10 ]; do
          x=$((x + 1))
          if [ $x -eq 3 ]; then break; fi
          echo $x
        done
        echo done
      `);
      expect(result.stdout).toBe("1\n2\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should exit until loop early", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=0
        until [ $x -ge 10 ]; do
          x=$((x + 1))
          if [ $x -eq 3 ]; then break; fi
          echo $x
        done
        echo done
      `);
      expect(result.stdout).toBe("1\n2\ndone\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("break with level argument", () => {
    it("should break multiple levels with break n", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2; do
          for j in a b c; do
            if [ $j = b ]; then break 2; fi
            echo "$i$j"
          done
        done
        echo done
      `);
      expect(result.stdout).toBe("1a\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should break single level with break 1", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          if [ $i -eq 2 ]; then break 1; fi
          echo $i
        done
        echo done
      `);
      expect(result.stdout).toBe("1\ndone\n");
    });

    it("should handle break with level exceeding loop depth", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2; do
          break 10
          echo $i
        done
        echo done
      `);
      // break 10 in a single loop should just break out
      expect(result.stdout).toBe("done\n");
    });
  });

  describe("error cases", () => {
    it("should silently do nothing when not in loop", async () => {
      const env = new Bash();
      const result = await env.exec("break");
      // In bash, break outside a loop silently does nothing
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should error on invalid argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          break abc
        done
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(128); // bash returns 128 for invalid break args
    });

    it("should error on zero argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          break 0
        done
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(128); // bash returns 128 for invalid break args
    });

    it("should error on negative argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          break -1
        done
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(128); // bash returns 128 for invalid break args
    });

    it("should error on too many arguments (bash behavior)", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for x in a b c; do
          echo $x
          break 1 2 3
        done
        echo --
      `);
      // bash errors on too many args and exits with code 1
      expect(result.stdout).toBe("a\n");
      expect(result.stderr).toContain("too many arguments");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("break in nested constructs", () => {
    it("should work with case statements inside loops", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for x in a b c; do
          case $x in
            b) break ;;
          esac
          echo $x
        done
        echo done
      `);
      expect(result.stdout).toBe("a\ndone\n");
    });

    it("should work with if statements inside loops", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -gt 2 ]; then
            break
          fi
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n2\n");
    });

    it("should work in function inside loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        check() {
          if [ $1 -eq 3 ]; then
            break
          fi
        }
        for i in 1 2 3 4 5; do
          check $i
          echo $i
        done
        echo done
      `);
      // break inside function should break the outer loop
      expect(result.stdout).toBe("1\n2\ndone\n");
    });
  });
});
