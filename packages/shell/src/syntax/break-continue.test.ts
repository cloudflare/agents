import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - break and continue", () => {
  describe("break", () => {
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
  });

  describe("continue", () => {
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

    it("should silently do nothing when not in loop", async () => {
      const env = new Bash();
      const result = await env.exec("continue");
      // In bash, continue outside a loop silently does nothing
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nested control flow", () => {
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

    it("should work with subshells", async () => {
      // break inside subshell should exit the subshell (no loop context)
      // bash outputs: 1\n3\ndone\n (break exits subshell on i=2, no echo)
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          (
            if [ $i -eq 2 ]; then break; fi
            echo $i
          )
        done
        echo done
      `);
      // break inside subshell only breaks out of that iteration's subshell
      // but the subshell exit code doesn't stop the outer loop
      expect(result.stdout).toBe("1\n3\ndone\n");
    });
  });
});
