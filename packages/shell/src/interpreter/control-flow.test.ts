import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("control flow execution", () => {
  describe("if/elif/else", () => {
    it("should execute if branch when condition is true", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if true; then
          echo "yes"
        fi
      `);
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should skip if branch when condition is false", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if false; then
          echo "yes"
        fi
        echo "done"
      `);
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute else branch when condition is false", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if false; then
          echo "yes"
        else
          echo "no"
        fi
      `);
      expect(result.stdout).toBe("no\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate elif chain", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=2
        if [ $x -eq 1 ]; then
          echo "one"
        elif [ $x -eq 2 ]; then
          echo "two"
        elif [ $x -eq 3 ]; then
          echo "three"
        else
          echo "other"
        fi
      `);
      expect(result.stdout).toBe("two\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle complex conditions", async () => {
      const env = new Bash();
      const result = await env.exec(`
        a=5
        b=10
        if [ $a -lt $b ] && [ $b -gt 5 ]; then
          echo "both true"
        fi
      `);
      expect(result.stdout).toBe("both true\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle nested if statements", async () => {
      const env = new Bash();
      const result = await env.exec(`
        a=1
        b=2
        if [ $a -eq 1 ]; then
          if [ $b -eq 2 ]; then
            echo "nested"
          fi
        fi
      `);
      expect(result.stdout).toBe("nested\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("for loops", () => {
    it("should iterate over word list", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in a b c; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate over expanded variable", async () => {
      const env = new Bash();
      const result = await env.exec(`
        items="x y z"
        for i in $items; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("x\ny\nz\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle IFS splitting", async () => {
      const env = new Bash();
      const result = await env.exec(`
        IFS=:
        items="a:b:c"
        for i in $items; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate over empty list without body execution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in; do
          echo $i
        done
        echo "done"
      `);
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve loop variable after loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          :
        done
        echo $i
      `);
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate over positional parameters when no list given", async () => {
      const env = new Bash({
        env: { "@": "arg1 arg2 arg3" }
      });
      const result = await env.exec(`
        for i; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("arg1\narg2\narg3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle brace expansion", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in {1..3}; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should error on invalid variable name", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for 123 in a b c; do
          echo $i
        done
      `);
      expect(result.stderr).toContain("not a valid identifier");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("C-style for loops", () => {
    it("should execute basic C-style for", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for ((i=0; i<3; i++)); do
          echo $i
        done
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle complex expressions", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for ((i=10; i>=0; i-=3)); do
          echo $i
        done
      `);
      expect(result.stdout).toBe("10\n7\n4\n1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty init", async () => {
      const env = new Bash();
      const result = await env.exec(`
        i=0
        for ((; i<3; i++)); do
          echo $i
        done
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty condition (infinite loop with break)", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for ((i=0; ; i++)); do
          echo $i
          if [ $i -ge 2 ]; then break; fi
        done
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should run update on continue", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for ((i=0; i<5; i++)); do
          if [ $i -eq 2 ]; then continue; fi
          echo $i
        done
      `);
      expect(result.stdout).toBe("0\n1\n3\n4\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("while loops", () => {
    it("should execute while body while condition is true", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=0
        while [ $x -lt 3 ]; do
          echo $x
          x=$((x + 1))
        done
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not execute body if condition is initially false", async () => {
      const env = new Bash();
      const result = await env.exec(`
        while false; do
          echo "inside"
        done
        echo "done"
      `);
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle nested while loops", async () => {
      const env = new Bash();
      const result = await env.exec(`
        i=0
        while [ $i -lt 2 ]; do
          j=0
          while [ $j -lt 2 ]; do
            echo "$i,$j"
            j=$((j + 1))
          done
          i=$((i + 1))
        done
      `);
      expect(result.stdout).toBe("0,0\n0,1\n1,0\n1,1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("until loops", () => {
    it("should execute until body until condition is true", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=0
        until [ $x -ge 3 ]; do
          echo $x
          x=$((x + 1))
        done
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not execute body if condition is initially true", async () => {
      const env = new Bash();
      const result = await env.exec(`
        until true; do
          echo "inside"
        done
        echo "done"
      `);
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("break and continue", () => {
    it("should break out of for loop", async () => {
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

    it("should continue to next iteration", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3 4 5; do
          if [ $i -eq 3 ]; then continue; fi
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n2\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should break multiple levels", async () => {
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

    it("should continue multiple levels", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2; do
          for j in a b; do
            if [ $j = a ]; then continue 2; fi
            echo "$i$j"
          done
        done
        echo done
      `);
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("case statements", () => {
    it("should match literal pattern", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=hello
        case $x in
          hello) echo "matched hello" ;;
          world) echo "matched world" ;;
        esac
      `);
      expect(result.stdout).toBe("matched hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match glob pattern", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=hello
        case $x in
          h*) echo "starts with h" ;;
          *) echo "default" ;;
        esac
      `);
      expect(result.stdout).toBe("starts with h\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with multiple patterns", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=yes
        case $x in
          yes|y|Y) echo "affirmative" ;;
          no|n|N) echo "negative" ;;
        esac
      `);
      expect(result.stdout).toBe("affirmative\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use default pattern", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=unknown
        case $x in
          yes) echo "yes" ;;
          no) echo "no" ;;
          *) echo "default" ;;
        esac
      `);
      expect(result.stdout).toBe("default\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle fall-through with ;&", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=a
        case $x in
          a) echo "a" ;&
          b) echo "b" ;;
          c) echo "c" ;;
        esac
      `);
      expect(result.stdout).toBe("a\nb\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle continue-matching with ;;&", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=abc
        case $x in
          *a*) echo "has a" ;;&
          *b*) echo "has b" ;;&
          *c*) echo "has c" ;;
        esac
      `);
      expect(result.stdout).toBe("has a\nhas b\nhas c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle quoted patterns literally", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x='*'
        case $x in
          '*') echo "literal star" ;;
          *) echo "default" ;;
        esac
      `);
      expect(result.stdout).toBe("literal star\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nested control structures", () => {
    it("should handle if inside for", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          if [ $i -eq 2 ]; then
            echo "found two"
          fi
        done
      `);
      expect(result.stdout).toBe("found two\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle for inside if", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=1
        if [ $x -eq 1 ]; then
          for i in a b c; do
            echo $i
          done
        fi
      `);
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle case inside for", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for x in foo bar baz; do
          case $x in
            foo) echo "one" ;;
            bar) echo "two" ;;
            *) echo "other" ;;
          esac
        done
      `);
      expect(result.stdout).toBe("one\ntwo\nother\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle while inside case", async () => {
      const env = new Bash();
      const result = await env.exec(`
        action=count
        case $action in
          count)
            i=0
            while [ $i -lt 3 ]; do
              echo $i
              i=$((i + 1))
            done
            ;;
        esac
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
