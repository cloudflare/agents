import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk field handling", () => {
  describe("field access", () => {
    it("should access $0 as entire line", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b c" | awk '{ print $0 }'`);
      expect(result.stdout).toBe("a b c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access individual fields", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c d e" | awk '{ print $1, $3, $5 }'`
      );
      expect(result.stdout).toBe("a c e\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return empty for non-existent field", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b" | awk '{ print "[" $10 "]" }'`);
      expect(result.stdout).toBe("[]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access last field with $NF", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "first second last" | awk '{ print $NF }'`
      );
      expect(result.stdout).toBe("last\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access second-to-last with $(NF-1)", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b c d" | awk '{ print $(NF-1) }'`);
      expect(result.stdout).toBe("c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use variable for field index", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b c d" | awk '{ i=3; print $i }'`);
      expect(result.stdout).toBe("c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use expression for field index", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b c d" | awk '{ print $(1+2) }'`);
      expect(result.stdout).toBe("c\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field modification", () => {
    it("should modify specific field", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b c" | awk '{ $2 = "X"; print }'`);
      expect(result.stdout).toBe("a X c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should update $0 when field is modified", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "one two three" | awk '{ $2 = "TWO"; print $0 }'`
      );
      expect(result.stdout).toBe("one TWO three\n");
      expect(result.exitCode).toBe(0);
    });

    it("should extend fields when assigning beyond NF", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b" | awk '{ $5 = "e"; print NF, $0 }'`
      );
      expect(result.stdout).toBe("5 a b   e\n");
      expect(result.exitCode).toBe(0);
    });

    it("should modify first field", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ $1 = "HELLO"; print }'`
      );
      expect(result.stdout).toBe("HELLO world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should modify last field", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk '{ $NF = "C"; print }'`
      );
      expect(result.stdout).toBe("a b C\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("NF (Number of Fields)", () => {
    it("should report correct number of fields", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a b c d e" | awk '{ print NF }'`);
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should report 0 for empty line", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk '{ print NF }'`);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should report 1 for single field", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "hello" | awk '{ print NF }'`);
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should update when field is added", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b" | awk '{ $4 = "d"; print NF }'`
      );
      expect(result.stdout).toBe("4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should truncate fields when NF is reduced", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c d e" | awk '{ NF = 2; print $0 }'`
      );
      expect(result.stdout).toBe("a b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("OFS (Output Field Separator)", () => {
    it("should use OFS between fields in print", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN{OFS=","} { print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a,b,c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use OFS when rebuilding $0", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN{OFS=":"} { $1 = $1; print }'`
      );
      expect(result.stdout).toBe("a:b:c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use OFS when field is modified", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN{OFS="-"} { $2 = "X"; print $0 }'`
      );
      expect(result.stdout).toBe("a-X-c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should allow multi-character OFS", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN{OFS=" | "} { print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a | b | c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should change OFS mid-program", async () => {
      const env = new Bash({
        files: { "/data.txt": "1 2 3\n4 5 6\n" }
      });
      const result = await env.exec(
        `awk 'NR==1{OFS=","} { $1=$1; print }' /data.txt`
      );
      expect(result.stdout).toBe("1,2,3\n4,5,6\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ORS (Output Record Separator)", () => {
    it("should use ORS after each print", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec(`awk 'BEGIN{ORS=";"} { print }' /data.txt`);
      expect(result.stdout).toBe("line1;line2;line3;");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty ORS", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(`awk 'BEGIN{ORS=""} { print }' /data.txt`);
      expect(result.stdout).toBe("abc");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multi-character ORS", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\n" }
      });
      const result = await env.exec(
        `awk 'BEGIN{ORS="\\n---\\n"} { print }' /data.txt`
      );
      expect(result.stdout).toBe("a\n---\nb\n---\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("FS (Field Separator)", () => {
    it("should split on whitespace by default", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a    b     c" | awk '{ print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a b c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use -F option for field separator", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a:b:c" | awk -F: '{ print $2 }'`);
      expect(result.stdout).toBe("b\n");
      expect(result.exitCode).toBe(0);
    });

    it("should set FS in BEGIN block", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a,b,c" | awk 'BEGIN{FS=","} { print $2 }'`
      );
      expect(result.stdout).toBe("b\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle tab as separator", async () => {
      const env = new Bash();
      const result = await env.exec(
        `printf "a\\tb\\tc" | awk -F'\\t' '{ print $2 }'`
      );
      expect(result.stdout).toBe("b\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle regex as separator", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a1b2c3d" | awk -F'[0-9]' '{ print $1, $2, $3, $4 }'`
      );
      expect(result.stdout).toBe("a b c d\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty fields with single char FS", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a::c" | awk -F: '{ print NF, "[" $2 "]" }'`
      );
      expect(result.stdout).toBe("3 []\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field assignment with arithmetic", () => {
    it("should perform arithmetic on fields", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "10 20 30" | awk '{ print $1 + $2 + $3 }'`
      );
      expect(result.stdout).toBe("60\n");
      expect(result.exitCode).toBe(0);
    });

    it("should multiply fields", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "5 6" | awk '{ print $1 * $2 }'`);
      expect(result.stdout).toBe("30\n");
      expect(result.exitCode).toBe(0);
    });

    it("should modify field with arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "10 20" | awk '{ $1 = $1 * 2; print }'`
      );
      expect(result.stdout).toBe("20 20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should add new computed field", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "10 20" | awk '{ $(NF+1) = $1 + $2; print }'`
      );
      expect(result.stdout).toBe("10 20 30\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field iteration", () => {
    it("should iterate over all fields", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk '{ for(i=1; i<=NF; i++) print i, $i }'`
      );
      expect(result.stdout).toBe("1 a\n2 b\n3 c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate in reverse", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk '{ for(i=NF; i>=1; i--) printf $i " "; print "" }'`
      );
      expect(result.stdout).toBe("c b a \n");
      expect(result.exitCode).toBe(0);
    });

    it("should sum all fields", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "1 2 3 4 5" | awk '{ sum=0; for(i=1; i<=NF; i++) sum+=$i; print sum }'`
      );
      expect(result.stdout).toBe("15\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("special field cases", () => {
    it("should handle $0 assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "old" | awk '{ $0 = "new line here"; print NF, $2 }'`
      );
      expect(result.stdout).toBe("3 line\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle leading whitespace", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "   a b c" | awk '{ print NF, $1 }'`);
      expect(result.stdout).toBe("3 a\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle trailing whitespace", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c   " | awk '{ print NF, $NF }'`
      );
      expect(result.stdout).toBe("3 c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple consecutive delimiters", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a     b     c" | awk '{ print NF }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field-based filtering", () => {
    it("should filter by field value", async () => {
      const env = new Bash({
        files: { "/data.txt": "alice 25\nbob 30\ncharlie 25\n" }
      });
      const result = await env.exec(`awk '$2 == 25 { print $1 }' /data.txt`);
      expect(result.stdout).toBe("alice\ncharlie\n");
      expect(result.exitCode).toBe(0);
    });

    it("should filter by field regex", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple red\nbanana yellow\napricot orange\n" }
      });
      const result = await env.exec(`awk '$1 ~ /^a/ { print }' /data.txt`);
      expect(result.stdout).toBe("apple red\napricot orange\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine field conditions", async () => {
      const env = new Bash({
        files: { "/data.txt": "a 10 x\nb 20 x\nc 10 y\nd 20 y\n" }
      });
      const result = await env.exec(
        `awk '$2 == 10 && $3 == "x" { print $1 }' /data.txt`
      );
      expect(result.stdout).toBe("a\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
