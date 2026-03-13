import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("continue builtin", () => {
  describe("basic continue", () => {
    it("should skip to next iteration in for loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -eq 3 ]; then continue; fi
          echo $i
        done
        echo done
      `);
      expect(result.stdout).toBe("1\n2\n4\n5\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should skip to next iteration in while loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=0
        while [ $x -lt 5 ]; do
          x=$((x + 1))
          if [ $x -eq 3 ]; then continue; fi
          echo $x
        done
        echo done
      `);
      expect(result.stdout).toBe("1\n2\n4\n5\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should skip to next iteration in until loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=0
        until [ $x -ge 5 ]; do
          x=$((x + 1))
          if [ $x -eq 3 ]; then continue; fi
          echo $x
        done
        echo done
      `);
      expect(result.stdout).toBe("1\n2\n4\n5\ndone\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("continue with level argument", () => {
    it("should continue multiple levels with continue n", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2; do
          for j in a b c; do
            if [ $j = b ]; then continue 2; fi
            echo "$i$j"
          done
          echo "end-$i"
        done
        echo done
      `);
      expect(result.stdout).toBe("1a\n2a\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should continue single level with continue 1", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          if [ $i -eq 2 ]; then continue 1; fi
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n3\n");
    });

    it("should handle continue with level exceeding loop depth", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          if [ $i -eq 2 ]; then continue 10; fi
          echo $i
        done
        echo done
      `);
      // continue 10 in a single loop should just continue to next iteration
      expect(result.stdout).toBe("1\n3\ndone\n");
    });
  });

  describe("error cases", () => {
    it("should silently do nothing when not in loop", async () => {
      const env = new Bash();
      const result = await env.exec("continue");
      // In bash, continue outside a loop silently does nothing
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should error on invalid argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          continue abc
        done
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(1);
    });

    it("should error on zero argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          continue 0
        done
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(1);
    });

    it("should error on negative argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          continue -1
        done
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(1);
    });

    it("should error on too many arguments (bash behavior)", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for x in a b c; do
          echo $x
          continue 1 2 3
        done
        echo --
      `);
      // bash errors on too many args and exits with code 1
      expect(result.stdout).toBe("a\n");
      expect(result.stderr).toContain("too many arguments");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("continue in nested constructs", () => {
    it("should work with case statements inside loops", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for x in a b c; do
          case $x in
            b) continue ;;
          esac
          echo $x
        done
      `);
      expect(result.stdout).toBe("a\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with if statements inside loops", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -eq 2 ] || [ $i -eq 4 ]; then
            continue
          fi
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n3\n5\n");
    });

    it("should work in function inside loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        skip_even() {
          if [ $(($1 % 2)) -eq 0 ]; then
            continue
          fi
        }
        for i in 1 2 3 4 5; do
          skip_even $i
          echo $i
        done
      `);
      // continue inside function should continue the outer loop
      expect(result.stdout).toBe("1\n3\n5\n");
    });
  });

  describe("continue in C-style for loop", () => {
    it("should continue in C-style for loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for ((i=1; i<=5; i++)); do
          if [ $i -eq 3 ]; then continue; fi
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n2\n4\n5\n");
    });

    it("should run update expression after continue", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for ((i=0; i<5; i++)); do
          if [ $i -lt 3 ]; then continue; fi
          echo $i
        done
      `);
      // i should still be incremented after continue
      expect(result.stdout).toBe("3\n4\n");
    });
  });
});
