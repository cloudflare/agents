import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Syntax Feature Composition", () => {
  describe("If statements with other features", () => {
    it("should use command substitution in if condition", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if [[ $(echo hello) == "hello" ]]; then
          echo "matched"
        fi
      `);
      expect(result.stdout).toBe("matched\n");
    });

    it("should use arithmetic in if condition", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export X=5
        if [[ $((X + 3)) -eq 8 ]]; then
          echo "math works"
        fi
      `);
      expect(result.stdout).toBe("math works\n");
    });

    it("should use here document inside if block", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if [[ 1 -eq 1 ]]; then
          cat <<EOF
hello from if
EOF
        fi
      `);
      expect(result.stdout).toBe("hello from if\n");
    });

    it("should use case statement inside if block", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export VAR=apple
        if [[ -n "$VAR" ]]; then
          case $VAR in
            apple) echo "it's an apple";;
            *) echo "unknown";;
          esac
        fi
      `);
      expect(result.stdout).toBe("it's an apple\n");
    });

    it("should use pipes inside if block", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if [[ 1 -eq 1 ]]; then
          echo -e "line1\\nline2\\nline3" | grep line2
        fi
      `);
      expect(result.stdout).toBe("line2\n");
    });
  });

  describe("Here documents with pipes and commands", () => {
    it("should pipe here document through multiple commands", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF | grep hello | wc -l
hello world
goodbye world
hello again
EOF`);
      expect(result.stdout.trim()).toBe("2");
    });

    it("should use variable expansion in here doc piped to grep", async () => {
      const env = new Bash({ env: { PATTERN: "world" } });
      const result = await env.exec(`cat <<EOF | grep $PATTERN
hello world
goodbye moon
EOF`);
      expect(result.stdout).toBe("hello world\n");
    });

    it("should use command substitution in here document", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF
The answer is $(echo 42)
EOF`);
      expect(result.stdout).toBe("The answer is 42\n");
    });

    it("should use arithmetic expansion in here document", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF
5 + 3 = $((5 + 3))
EOF`);
      expect(result.stdout).toBe("5 + 3 = 8\n");
    });

    it("should combine here doc with sort and uniq", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF | sort | uniq
banana
apple
banana
cherry
apple
EOF`);
      expect(result.stdout).toBe("apple\nbanana\ncherry\n");
    });
  });

  describe("Case statements with other features", () => {
    it("should use command substitution as case word", async () => {
      const env = new Bash();
      const result = await env.exec(`
        case $(echo test) in
          test) echo "matched command output";;
          *) echo "no match";;
        esac
      `);
      expect(result.stdout).toBe("matched command output\n");
    });

    it("should use arithmetic result as case word", async () => {
      const env = new Bash();
      const result = await env.exec(`
        case $((2 + 3)) in
          5) echo "five";;
          *) echo "other";;
        esac
      `);
      expect(result.stdout).toBe("five\n");
    });

    it("should use pipes inside case branch", async () => {
      const env = new Bash();
      const result = await env.exec(`
        case "process" in
          process)
            echo -e "a\\nb\\nc" | wc -l
            ;;
        esac
      `);
      expect(result.stdout.trim()).toBe("3");
    });

    it("should use here document inside case branch", async () => {
      const env = new Bash();
      const result = await env.exec(`
        case "heredoc" in
          heredoc)
            cat <<EOF
inside case
EOF
            ;;
        esac
      `);
      expect(result.stdout).toBe("inside case\n");
    });

    it("should nest case in case", async () => {
      const env = new Bash();
      const result = await env.exec(`
        case "outer" in
          outer)
            case "inner" in
              inner) echo "nested match";;
            esac
            ;;
        esac
      `);
      expect(result.stdout).toBe("nested match\n");
    });
  });

  describe("Test expressions with other features", () => {
    it("should test command substitution result", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if [[ $(echo "yes") == "yes" ]]; then
          echo "command output matched"
        fi
      `);
      expect(result.stdout).toBe("command output matched\n");
    });

    it("should test arithmetic result", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if [[ $((10 / 2)) -eq 5 ]]; then
          echo "arithmetic correct"
        fi
      `);
      expect(result.stdout).toBe("arithmetic correct\n");
    });

    it("should use test expression with file created by previous command", async () => {
      const env = new Bash();
      await env.exec("echo 'content' > /tmp/testfile.txt");
      const result = await env.exec(`
        if [[ -f /tmp/testfile.txt ]]; then
          echo "file exists"
        fi
      `);
      expect(result.stdout).toBe("file exists\n");
    });

    it("should combine multiple test conditions with command substitution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export COUNT=3
        if [[ $COUNT -gt 0 && $(echo "valid") == "valid" ]]; then
          echo "both conditions met"
        fi
      `);
      expect(result.stdout).toBe("both conditions met\n");
    });
  });

  describe("Loops with syntax features", () => {
    it("should use command substitution in for loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for item in $(echo "a b c"); do
          echo "item: $item"
        done
      `);
      expect(result.stdout).toBe("item: a\nitem: b\nitem: c\n");
    });

    it("should use arithmetic in while loop condition", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export I=0
        while [[ $I -lt 3 ]]; do
          echo "i=$I"
          export I=$((I + 1))
        done
      `);
      expect(result.stdout).toBe("i=0\ni=1\ni=2\n");
    });

    it("should use case statement inside loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for fruit in apple banana cherry; do
          case $fruit in
            apple) echo "red";;
            banana) echo "yellow";;
            cherry) echo "red";;
          esac
        done
      `);
      expect(result.stdout).toBe("red\nyellow\nred\n");
    });

    it("should use here document inside loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2; do
          cat <<EOF
iteration $i
EOF
        done
      `);
      expect(result.stdout).toBe("iteration 1\niteration 2\n");
    });

    it("should pipe loop output", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 3 1 2; do
          echo $i
        done | sort
      `);
      expect(result.stdout).toBe("1\n2\n3\n");
    });
  });

  describe("Functions with syntax features", () => {
    it("should use command substitution in function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        greet() {
          local name=$(echo "World")
          echo "Hello, $name!"
        }
        greet
      `);
      expect(result.stdout).toBe("Hello, World!\n");
    });

    it("should use arithmetic in function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        add() {
          echo $(($1 + $2))
        }
        add 5 3
      `);
      expect(result.stdout).toBe("8\n");
    });

    it("should use case statement in function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        get_color() {
          case $1 in
            apple) echo "red";;
            banana) echo "yellow";;
            *) echo "unknown";;
          esac
        }
        get_color apple
        get_color banana
        get_color grape
      `);
      expect(result.stdout).toBe("red\nyellow\nunknown\n");
    });

    it("should use test expression in function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        is_positive() {
          if [[ $1 -gt 0 ]]; then
            echo "yes"
          else
            echo "no"
          fi
        }
        is_positive 5
        is_positive -3
        is_positive 0
      `);
      expect(result.stdout).toBe("yes\nno\nno\n");
    });

    it("should use here document in function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        generate_config() {
          cat <<EOF
name=$1
value=$2
EOF
        }
        generate_config mykey myvalue
      `);
      expect(result.stdout).toBe("name=mykey\nvalue=myvalue\n");
    });

    it("should call function with command substitution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        double() {
          echo $(($1 * 2))
        }
        result=$(double 5)
        echo "Result: $result"
      `);
      expect(result.stdout).toBe("Result: 10\n");
    });
  });

  describe("Complex multi-feature compositions", () => {
    it("should combine if, case, and command substitution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export TYPE=$(echo "fruit")
        if [[ $TYPE == "fruit" ]]; then
          case $(echo apple) in
            apple) echo "it's an apple";;
            *) echo "unknown fruit";;
          esac
        fi
      `);
      expect(result.stdout).toBe("it's an apple\n");
    });

    it("should use here doc with command substitution and pipes", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export PREFIX=">>>"
        cat <<EOF | grep world
$PREFIX hello
$PREFIX world
$PREFIX $(echo "dynamic")
EOF`);
      expect(result.stdout).toBe(">>> world\n");
    });

    it("should nest loops with conditionals and arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          for j in 1 2; do
            if [[ $((i * j)) -gt 2 ]]; then
              echo "$i*$j=$((i * j))"
            fi
          done
        done
      `);
      expect(result.stdout).toBe("2*2=4\n3*1=3\n3*2=6\n");
    });

    it("should use function with loop, case, and arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec(`
        process_numbers() {
          local sum=0
          for n in $@; do
            case $n in
              [0-9]) sum=$((sum + n));;
              *) echo "skipping $n";;
            esac
          done
          echo "sum=$sum"
        }
        process_numbers 1 2 x 3 y 4
      `);
      expect(result.stdout).toBe("skipping x\nskipping y\nsum=10\n");
    });

    it("should pipe function output through multiple commands", async () => {
      const env = new Bash();
      const result = await env.exec(`
        generate_data() {
          for i in 3 1 4 1 5 9 2 6; do
            echo $i
          done
        }
        generate_data | sort -n | uniq | head -3
      `);
      expect(result.stdout).toBe("1\n2\n3\n");
    });

    it("should combine test expression with file operations and here doc", async () => {
      const env = new Bash();
      const result = await env.exec(`
        cat <<EOF > /tmp/data.txt
line1
line2
line3
EOF
        if [[ -f /tmp/data.txt ]]; then
          count=$(wc -l < /tmp/data.txt)
          echo "File has $count lines"
        fi
      `);
      expect(result.stdout.trim()).toContain("File has");
      expect(result.stdout.trim()).toContain("3");
    });

    it("should use nested command substitution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "Result: $(echo "inner: $(echo deep)")"
      `);
      expect(result.stdout).toBe("Result: inner: deep\n");
    });

    it("should combine arithmetic with comparison in loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        export N=1
        while [[ $((N * N)) -le 10 ]]; do
          echo "$N squared is $((N * N))"
          export N=$((N + 1))
        done
      `);
      expect(result.stdout).toBe(
        "1 squared is 1\n2 squared is 4\n3 squared is 9\n"
      );
    });
  });

  describe("Error handling in composed features", () => {
    it("should handle failed command in command substitution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        result=$(cat /nonexistent/file 2>/dev/null)
        if [[ -z "$result" ]]; then
          echo "no result"
        fi
      `);
      expect(result.stdout).toBe("no result\n");
    });

    it("should handle empty here document in pipe", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF | wc -l
EOF`);
      expect(result.stdout.trim()).toBe("0");
    });

    it("should handle case with no matching pattern", async () => {
      const env = new Bash();
      const result = await env.exec(`
        case "nomatch" in
          a) echo "a";;
          b) echo "b";;
        esac
        echo "done"
      `);
      expect(result.stdout).toBe("done\n");
    });
  });
});
