/**
 * DoS Prevention - Execution Limits
 *
 * Tests to prevent resource exhaustion attacks through various
 * execution limit mechanisms.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { Lexer } from "../../parser/lexer";
import { Parser, parse } from "../../parser/parser";

describe("DoS Prevention - Execution Limits", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
  });

  describe("Brace Expansion", () => {
    it("should limit brace expansion with hardcoded internal limit", async () => {
      // Brace expansion has hardcoded limit of 10000 results
      // {a..z}{a..z} = 676 items, which is within limit
      const result = await bash.exec("arr=({a..z}{a..z}); echo ${#arr[@]}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("676\n");
    });

    it("should handle very large brace expansion gracefully", async () => {
      // {1..10000} is at the hardcoded limit boundary
      const result = await bash.exec("arr=({1..10001}); echo ${#arr[@]}");
      // Should either succeed or fail gracefully, not crash
      expect(typeof result.exitCode).toBe("number");
    });

    it("should allow brace expansion within limits", async () => {
      const result = await bash.exec("echo {1..10}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 2 3 4 5 6 7 8 9 10\n");
    });

    it("should handle nested brace expansion", async () => {
      const result = await bash.exec("echo {a,b}{c,d}{e,f}");
      expect(result.exitCode).toBe(0);
      // 2*2*2 = 8 combinations
      expect(result.stdout).toBe("ace acf ade adf bce bcf bde bdf\n");
    });
  });

  describe("Loop Limits", () => {
    it("should enforce maxLoopIterations in while", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 10 }
      });

      const result = await limitedBash.exec(`
        i=0
        while true; do
          echo $i
          ((i++))
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("while loop: too many iterations");
    });

    it("should enforce maxLoopIterations in for", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 5 }
      });

      const result = await limitedBash.exec(`
        for i in {1..100}; do
          echo $i
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("for loop: too many iterations");
    });

    it("should enforce maxLoopIterations in until", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 5 }
      });

      const result = await limitedBash.exec(`
        i=0
        until false; do
          echo $i
          ((i++))
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("until loop: too many iterations");
    });

    it("should enforce limits in nested loops (inner loop)", async () => {
      // Each loop has its own iteration counter
      // Set a low limit to trigger on the inner loop
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 5 }
      });

      const result = await limitedBash.exec(`
        for i in 1 2 3; do
          for j in 1 2 3 4 5 6 7 8 9 10; do
            echo "$i,$j"
          done
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many iterations");
    });

    it("should count iterations across loop types", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 15 }
      });

      const result = await limitedBash.exec(`
        for i in 1 2 3 4 5; do
          echo "for: $i"
        done
        j=0
        while [ $j -lt 20 ]; do
          echo "while: $j"
          ((j++))
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many iterations");
    });

    it("should allow loops within limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 100 }
      });

      const result = await limitedBash.exec(`
        for i in 1 2 3 4 5; do
          echo $i
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n3\n4\n5\n");
    });
  });

  describe("Command Count", () => {
    it("should enforce maxCommandCount", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCommandCount: 5 }
      });

      const result = await limitedBash.exec(`
        echo 1
        echo 2
        echo 3
        echo 4
        echo 5
        echo 6
        echo 7
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many commands executed");
    });

    it("should count commands in subshells", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCommandCount: 5 }
      });

      const result = await limitedBash.exec(`
        echo 1
        (echo 2; echo 3; echo 4)
        echo 5
        echo 6
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many commands executed");
    });

    it("should count commands in pipelines", async () => {
      // Pipeline commands may be executed concurrently, so need more commands
      const limitedBash = new Bash({
        executionLimits: { maxCommandCount: 2 }
      });

      // Execute multiple independent pipelines to accumulate command count
      const result = await limitedBash.exec(`
        echo a | cat
        echo b | cat
        echo c | cat
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many commands executed");
    });

    it("should count commands in eval", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCommandCount: 5 }
      });

      const result = await limitedBash.exec(`
        eval 'echo 1; echo 2; echo 3; echo 4; echo 5; echo 6'
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many commands executed");
    });

    it("should allow commands within limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCommandCount: 10 }
      });

      const result = await limitedBash.exec(`
        echo 1
        echo 2
        echo 3
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n3\n");
    });
  });

  describe("Recursion", () => {
    it("should enforce maxCallDepth for functions", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCallDepth: 5 }
      });

      const result = await limitedBash.exec(`
        recurse() {
          echo "depth: $1"
          recurse $(($1 + 1))
        }
        recurse 1
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("maximum recursion depth");
    });

    it("should enforce maxCallDepth with mutual recursion", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCallDepth: 10 }
      });

      const result = await limitedBash.exec(`
        func_a() {
          echo "a: $1"
          func_b $(($1 + 1))
        }
        func_b() {
          echo "b: $1"
          func_a $(($1 + 1))
        }
        func_a 1
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("maximum recursion depth");
    });

    it("should enforce substitution depth limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxSubstitutionDepth: 3 }
      });

      const result = await limitedBash.exec(
        "echo $(echo $(echo $(echo $(echo too-deep))))"
      );
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain(
        "Command substitution nesting limit exceeded"
      );
    });

    it("should allow recursion within limit", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCallDepth: 10 }
      });

      const result = await limitedBash.exec(`
        countdown() {
          if [ $1 -le 0 ]; then
            echo "done"
            return
          fi
          echo $1
          countdown $(($1 - 1))
        }
        countdown 5
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("5\n4\n3\n2\n1\ndone\n");
    });
  });

  describe("C-style For Loop", () => {
    it("should enforce loop limit in C-style for", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 10 }
      });

      const result = await limitedBash.exec(`
        for ((i=0; i<1000; i++)); do
          echo $i
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("for loop: too many iterations");
    });

    it("should handle infinite C-style for loop", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 5 }
      });

      const result = await limitedBash.exec(`
        for ((;;)); do
          echo "infinite"
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("for loop: too many iterations");
    });
  });

  describe("Combined Attack Vectors", () => {
    it("should handle loop with command substitution bomb", async () => {
      const limitedBash = new Bash({
        executionLimits: {
          maxLoopIterations: 10,
          maxCommandCount: 50
        }
      });

      const result = await limitedBash.exec(`
        for i in {1..100}; do
          echo $(echo $(echo $i))
        done
      `);
      expect(result.exitCode).toBe(126);
      // Should hit either loop or command limit
      expect(result.stderr).toMatch(/too many|maximum/i);
    });

    it("should handle recursive function with loops", async () => {
      const limitedBash = new Bash({
        executionLimits: {
          maxCallDepth: 5,
          maxLoopIterations: 50
        }
      });

      const result = await limitedBash.exec(`
        bomb() {
          for i in 1 2 3 4 5; do
            echo "$1: $i"
          done
          bomb $(($1 + 1))
        }
        bomb 1
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toMatch(/too many|maximum recursion/i);
    });

    it("should handle eval in loop", async () => {
      const limitedBash = new Bash({
        executionLimits: {
          maxLoopIterations: 5,
          maxCommandCount: 20
        }
      });

      const result = await limitedBash.exec(`
        for i in {1..100}; do
          eval "echo iteration $i"
        done
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toMatch(/too many|maximum/i);
    });
  });

  describe("Arithmetic Expansion Bomb", () => {
    it("should handle deeply nested arithmetic", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxSubstitutionDepth: 10 }
      });

      // Create deeply nested arithmetic expression
      const result = await limitedBash.exec(
        "echo $((1+$((2+$((3+$((4+$((5+$((6+$((7+$((8+$((9+$((10+$((11))))))))))))))))))))))"
      );
      // Should either succeed or fail gracefully, not crash
      expect(typeof result.exitCode).toBe("number");
    });

    it("should handle recursive variable expansion in arithmetic", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCallDepth: 10 }
      });

      // This tests arithmetic variable chains
      const result = await limitedBash.exec(`
        a=1
        b='a+1'
        c='b+1'
        d='c+1'
        echo $((d))
      `);
      // Should succeed with chain evaluation or fail gracefully
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("Default Limits", () => {
    it("should have reasonable defaults that prevent runaway scripts", async () => {
      // Default limits should prevent infinite loops
      // Both loop iteration (10000) and command count (10000) limits apply
      const defaultBash = new Bash();

      const result = await defaultBash.exec(`
        i=0
        while true; do
          ((i++))
          if [ $i -ge 100000 ]; then
            break
          fi
        done
        echo "stopped at $i"
      `);
      // Should hit one of the default limits (commands or iterations)
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toMatch(/too many (iterations|commands)/);
    });

    it("should allow normal scripts to run with defaults", async () => {
      const defaultBash = new Bash();

      const result = await defaultBash.exec(`
        sum=0
        for i in {1..100}; do
          sum=$((sum + i))
        done
        echo "sum: $sum"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("sum: 5050\n");
    });
  });

  describe("Edge Cases", () => {
    it("should handle break in infinite loop", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 100 }
      });

      const result = await limitedBash.exec(`
        i=0
        while true; do
          ((i++))
          if [ $i -eq 5 ]; then
            break
          fi
          echo $i
        done
        echo "done"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n3\n4\ndone\n");
    });

    it("should handle continue in loop", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 100 }
      });

      const result = await limitedBash.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -eq 3 ]; then
            continue
          fi
          echo $i
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n4\n5\n");
    });

    it("should handle return from function inside loop", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 100 }
      });

      const result = await limitedBash.exec(`
        find_three() {
          for i in 1 2 3 4 5; do
            if [ $i -eq 3 ]; then
              echo "found: $i"
              return 0
            fi
          done
          return 1
        }
        find_three
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("found: 3\n");
    });

    it("should handle exit inside loop", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxLoopIterations: 100 }
      });

      const result = await limitedBash.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -eq 3 ]; then
            exit 42
          fi
          echo $i
        done
      `);
      expect(result.exitCode).toBe(42);
      expect(result.stdout).toBe("1\n2\n");
    });
  });

  describe("Parser Depth Limits", () => {
    it("should reject deeply nested if statements", () => {
      // Build a script with 300 nested if-then-fi blocks
      const depth = 300;
      let script = "";
      for (let i = 0; i < depth; i++) {
        script += "if true; then\n";
      }
      script += "echo deep\n";
      for (let i = 0; i < depth; i++) {
        script += "fi\n";
      }

      expect(() => parse(script)).toThrow(
        /Maximum parser nesting depth exceeded/
      );
    });

    it("should reject deeply nested subshells", () => {
      const depth = 300;
      let script = "";
      for (let i = 0; i < depth; i++) {
        script += "( ";
      }
      script += "echo deep";
      for (let i = 0; i < depth; i++) {
        script += " )";
      }

      expect(() => parse(script)).toThrow(
        /Maximum parser nesting depth exceeded/
      );
    });

    it("should reject deeply nested while loops", () => {
      const depth = 300;
      let script = "";
      for (let i = 0; i < depth; i++) {
        script += "while true; do\n";
      }
      script += "echo deep\n";
      for (let i = 0; i < depth; i++) {
        script += "done\n";
      }

      expect(() => parse(script)).toThrow(
        /Maximum parser nesting depth exceeded/
      );
    });

    it("should allow moderately nested constructs", () => {
      // 10 levels of nesting should be fine
      const depth = 10;
      let script = "";
      for (let i = 0; i < depth; i++) {
        script += "if true; then\n";
      }
      script += "echo ok\n";
      for (let i = 0; i < depth; i++) {
        script += "fi\n";
      }

      expect(() => parse(script)).not.toThrow();
    });

    it("should reset depth when reusing Parser via parseTokens", () => {
      const parser = new Parser();

      // First parse: deeply nested script that triggers the limit
      const depth = 300;
      let deepScript = "";
      for (let i = 0; i < depth; i++) {
        deepScript += "if true; then\n";
      }
      deepScript += "echo deep\n";
      for (let i = 0; i < depth; i++) {
        deepScript += "fi\n";
      }
      expect(() => parser.parse(deepScript)).toThrow(
        /Maximum parser nesting depth exceeded/
      );

      // Second parse on the same instance: simple script via parseTokens
      // This must succeed — counters should be reset
      const simpleTokens = new Lexer("echo hello").tokenize();
      expect(() => parser.parseTokens(simpleTokens)).not.toThrow();
    });

    it("should reset iteration count when reusing Parser via parseTokens", () => {
      const parser = new Parser();

      // First parse: a valid script
      const first = parser.parse("echo first");
      expect(first.statements.length).toBe(1);

      // Second parse via parseTokens: should work without hitting
      // a stale iteration count from the first parse
      const tokens = new Lexer("echo second").tokenize();
      const second = parser.parseTokens(tokens);
      expect(second.statements.length).toBe(1);
    });
  });
});
