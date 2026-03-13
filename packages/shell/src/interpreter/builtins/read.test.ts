import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("read builtin", () => {
  describe("basic read", () => {
    it("should read from stdin into variable", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "hello" | { read VAR; echo "got: $VAR"; }
      `);
      expect(result.stdout).toBe("got: hello\n");
    });

    it("should read into REPLY when no variable given", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "test" | { read; echo "REPLY=$REPLY"; }
      `);
      expect(result.stdout).toBe("REPLY=test\n");
    });

    it("should read multiple words into multiple variables", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "one two three" | { read A B C; echo "A=$A B=$B C=$C"; }
      `);
      expect(result.stdout).toBe("A=one B=two C=three\n");
    });

    it("should put remaining words in last variable", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "one two three four" | { read A B; echo "A=$A B=$B"; }
      `);
      expect(result.stdout).toBe("A=one B=two three four\n");
    });
  });

  describe("read options", () => {
    it("should support -r to disable backslash escape", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo 'hello\\nworld' | { read -r VAR; echo "$VAR"; }
      `);
      expect(result.stdout).toBe("hello\\nworld\n");
    });

    it("should support -p for prompt (non-interactive)", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "test" | { read -p "Enter: " VAR; echo "$VAR"; }
      `);
      expect(result.stdout).toBe("test\n");
    });

    it("should support -a to read into array", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "a b c" | { read -a ARR; echo "\${ARR[0]} \${ARR[1]} \${ARR[2]}"; }
      `);
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("read with delimiters", () => {
    it("should support -d to set delimiter", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo -n "hello:world" | { read -d ":" VAR; echo "$VAR"; }
      `);
      expect(result.stdout).toBe("hello\n");
    });
  });

  describe("read exit codes", () => {
    it("should return 0 on successful read", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo "data" | { read VAR; echo $?; }
      `);
      expect(result.stdout).toBe("0\n");
    });

    it("should return 1 on EOF", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo -n "" | { read VAR; echo $?; }
      `);
      expect(result.stdout).toBe("1\n");
    });
  });

  describe("read in loops", () => {
    it("should read multiple lines in while loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo -e "line1\\nline2\\nline3" | while read LINE; do
          echo "got: $LINE"
        done
      `);
      expect(result.stdout).toBe("got: line1\ngot: line2\ngot: line3\n");
    });
  });

  describe("read -a with empty IFS", () => {
    it("should produce empty array for empty input with empty IFS", async () => {
      const env = new Bash();
      const result = await env.exec(`
        IFS=
        echo '' | (read -a a; echo "\${#a[@]}")
      `);
      // When IFS is empty and input is empty, read -a should produce an empty array (0 elements)
      expect(result.stdout).toBe("0\n");
    });

    it("should read entire non-empty input as single word with empty IFS", async () => {
      const env = new Bash();
      const result = await env.exec(`
        IFS=
        echo 'hello world' | (read -a a; echo "\${#a[@]}"; echo "\${a[0]}")
      `);
      // With empty IFS, no word splitting occurs, so the entire input is one word
      expect(result.stdout).toBe("1\nhello world\n");
    });
  });
});
