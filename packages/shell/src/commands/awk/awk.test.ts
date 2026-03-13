import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk escape sequences", () => {
  it("should handle hex escapes", async () => {
    const env = new Bash();
    const result = await env.exec(`awk 'BEGIN { print "H\\x49\\x4a\\x4BL" }'`);
    expect(result.stdout).toBe("HIJKL\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle octal escapes", async () => {
    const env = new Bash();
    const result = await env.exec(`awk 'BEGIN { print "0\\061\\62x\\0645" }'`);
    expect(result.stdout).toBe("012x45\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle special escapes (\\f\\r\\b\\v\\a)", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN { print "x\\f\\r\\b\\v\\a\\\\y" }'`
    );
    expect(result.stdout).toBe("x\f\r\b\v\x07\\y\n");
    expect(result.exitCode).toBe(0);
  });

  it("should print NF=0 for empty line", async () => {
    const env = new Bash();
    const result = await env.exec(`echo '' | awk '{ print NF }'`);
    expect(result.stdout).toBe("0\n");
    expect(result.exitCode).toBe(0);
  });

  it("should print NF=0 for tab-only line", async () => {
    const env = new Bash();
    const result = await env.exec(`echo $'\\t' | awk '{ print NF }'`);
    expect(result.stdout).toBe("0\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("awk command", () => {
  describe("basic field access", () => {
    it("should print entire line with $0", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\nfoo bar\n" }
      });
      const result = await env.exec("awk '{print $0}' /data.txt");
      expect(result.stdout).toBe("hello world\nfoo bar\n");
      expect(result.exitCode).toBe(0);
    });

    it("should print first field with $1", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\nfoo bar\n" }
      });
      const result = await env.exec("awk '{print $1}' /data.txt");
      expect(result.stdout).toBe("hello\nfoo\n");
      expect(result.exitCode).toBe(0);
    });

    it("should print multiple fields", async () => {
      const env = new Bash({
        files: { "/data.txt": "a b c\n1 2 3\n" }
      });
      const result = await env.exec("awk '{print $1, $3}' /data.txt");
      expect(result.stdout).toBe("a c\n1 3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle missing fields gracefully", async () => {
      const env = new Bash({
        files: { "/data.txt": "one\ntwo three\n" }
      });
      const result = await env.exec("awk '{print $2}' /data.txt");
      expect(result.stdout).toBe("\nthree\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field separator -F", () => {
    it("should use custom field separator", async () => {
      const env = new Bash({
        files: { "/data.csv": "a,b,c\n1,2,3\n" }
      });
      const result = await env.exec("awk -F',' '{print $2}' /data.csv");
      expect(result.stdout).toBe("b\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle -F without space", async () => {
      const env = new Bash({
        files: { "/data.csv": "a:b:c\n" }
      });
      const result = await env.exec("awk -F: '{print $2}' /data.csv");
      expect(result.stdout).toBe("b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("variable assignment -v", () => {
    it("should use -v assigned variable", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec(
        "awk -v name=World '{print \"Hello \" name}' /data.txt"
      );
      expect(result.stdout).toBe("Hello World\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("built-in variables", () => {
    it("should track NR (record number)", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec("awk '{print NR, $0}' /data.txt");
      expect(result.stdout).toBe("1 a\n2 b\n3 c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should track NF (number of fields)", async () => {
      const env = new Bash({
        files: { "/data.txt": "one\ntwo three\na b c d\n" }
      });
      const result = await env.exec("awk '{print NF}' /data.txt");
      expect(result.stdout).toBe("1\n2\n4\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("BEGIN and END blocks", () => {
    it("should execute BEGIN block before processing", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{print \"start\"}{print $0}' /data.txt"
      );
      expect(result.stdout).toBe("start\na\nb\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute END block after processing", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\n" }
      });
      const result = await env.exec(
        "awk '{print $0}END{print \"done\"}' /data.txt"
      );
      expect(result.stdout).toBe("a\nb\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute BEGIN even with no input", async () => {
      const env = new Bash({
        files: { "/empty.txt": "" }
      });
      const result = await env.exec("awk 'BEGIN{print \"hello\"}' /empty.txt");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("pattern matching", () => {
    it("should filter lines with regex pattern", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\ncherry\n" }
      });
      const result = await env.exec("awk '/^a/{print}' /data.txt");
      expect(result.stdout).toBe("apple\napricot\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with NR condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec("awk 'NR==2{print}' /data.txt");
      expect(result.stdout).toBe("line2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with NR > condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec("awk 'NR>1{print}' /data.txt");
      expect(result.stdout).toBe("line2\nline3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("printf", () => {
    it("should format with printf %s", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\n" }
      });
      const result = await env.exec("awk '{printf \"%s!\\n\", $1}' /data.txt");
      expect(result.stdout).toBe("hello!\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format with printf %d", async () => {
      const env = new Bash({
        files: { "/data.txt": "42\n" }
      });
      const result = await env.exec(
        "awk '{printf \"num: %d\\n\", $1}' /data.txt"
      );
      expect(result.stdout).toBe("num: 42\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("stdin input", () => {
    it("should read from piped stdin", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'a b c' | awk '{print $2}'");
      expect(result.stdout).toBe("b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error on missing program", async () => {
      const env = new Bash();
      const result = await env.exec("awk");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing program");
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("awk '{print}' /nonexistent.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file");
    });

    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("awk --help");
      expect(result.stdout).toContain("awk");
      expect(result.stdout).toContain("pattern scanning");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string concatenation", () => {
    it("should concatenate strings", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\n" }
      });
      const result = await env.exec("awk '{print $1 \"-\" $2}' /data.txt");
      expect(result.stdout).toBe("hello-world\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("arithmetic", () => {
    it("should perform addition", async () => {
      const env = new Bash({
        files: { "/data.txt": "10 20\n5 15\n" }
      });
      const result = await env.exec("awk '{print $1 + $2}' /data.txt");
      expect(result.stdout).toBe("30\n20\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("compound assignment operators", () => {
    it("should handle += operator", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n20\n30\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{sum=0}{sum+=$1}END{print sum}' /data.txt"
      );
      expect(result.stdout).toBe("60\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle -= operator", async () => {
      const env = new Bash({
        files: { "/data.txt": "5\n3\n2\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{val=100}{val-=$1}END{print val}' /data.txt"
      );
      expect(result.stdout).toBe("90\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle *= operator", async () => {
      const env = new Bash({
        files: { "/data.txt": "2\n3\n4\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{prod=1}{prod*=$1}END{print prod}' /data.txt"
      );
      expect(result.stdout).toBe("24\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle /= operator", async () => {
      const env = new Bash({
        files: { "/data.txt": "2\n5\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{val=100}{val/=$1}END{print val}' /data.txt"
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should accumulate with += across multiple lines", async () => {
      const env = new Bash({
        files: { "/sales.csv": "product,100\nservice,250\nsubscription,50\n" }
      });
      const result = await env.exec(
        "awk -F, '{total+=$2}END{print total}' /sales.csv"
      );
      expect(result.stdout).toBe("400\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("increment/decrement operators", () => {
    it("should handle var++ postfix increment", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{n=0}{n++}END{print n}' /data.txt"
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle var-- postfix decrement", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{n=10}{n--}END{print n}' /data.txt"
      );
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle ++var prefix increment", async () => {
      const env = new Bash({
        files: { "/data.txt": "x\ny\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{n=0}{++n}END{print n}' /data.txt"
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle --var prefix decrement", async () => {
      const env = new Bash({
        files: { "/data.txt": "x\ny\ny\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{n=5}{--n}END{print n}' /data.txt"
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("compound conditions (&&, ||)", () => {
    it("should handle && (AND) condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "1 10\n2 20\n3 30\n4 40\n5 50\n" }
      });
      const result = await env.exec("awk '$1>=2 && $1<=4{print}' /data.txt");
      expect(result.stdout).toBe("2 20\n3 30\n4 40\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle || (OR) condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "1 a\n2 b\n3 c\n4 d\n5 e\n" }
      });
      const result = await env.exec("awk '$1==1 || $1==5{print}' /data.txt");
      expect(result.stdout).toBe("1 a\n5 e\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle NR range with &&", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\nline3\nline4\nline5\n" }
      });
      const result = await env.exec("awk 'NR>=2 && NR<=4{print}' /data.txt");
      expect(result.stdout).toBe("line2\nline3\nline4\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("variable comparisons in conditions", () => {
    it("should compare field to user variable", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n25\n15\n30\n5\n" }
      });
      const result = await env.exec(
        "awk -v threshold=20 '$1>threshold{print}' /data.txt"
      );
      expect(result.stdout).toBe("25\n30\n");
      expect(result.exitCode).toBe(0);
    });

    it("should track max value", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n25\n15\n30\n5\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{max=0}$1>max{max=$1}END{print max}' /data.txt"
      );
      expect(result.stdout).toBe("30\n");
      expect(result.exitCode).toBe(0);
    });

    it("should track min value", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n25\n15\n30\n5\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{min=9999}$1<min{min=$1}END{print min}' /data.txt"
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle NF comparisons", async () => {
      const env = new Bash({
        files: { "/data.txt": "one\ntwo words\nthree word line\n" }
      });
      const result = await env.exec("awk 'NF>1{print}' /data.txt");
      expect(result.stdout).toBe("two words\nthree word line\n");
      expect(result.exitCode).toBe(0);
    });

    it("should filter CSV by numeric field comparison", async () => {
      const env = new Bash({
        files: {
          "/prices.csv": "apple,1.50\nbanana,0.75\norange,2.00\ngrape,3.50\n"
        }
      });
      const result = await env.exec("awk -F, '$2>=2{print $1}' /prices.csv");
      expect(result.stdout).toBe("orange\ngrape\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("match() function with RSTART/RLENGTH", () => {
    it("should return position and set RSTART/RLENGTH", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello foo world\n" }
      });
      const result = await env.exec(
        "awk '{print match($0, /foo/), RSTART, RLENGTH}' /data.txt"
      );
      expect(result.stdout).toBe("7 7 3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 when no match", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\n" }
      });
      const result = await env.exec(
        "awk '{print match($0, /foo/), RSTART, RLENGTH}' /data.txt"
      );
      expect(result.stdout).toBe("0 0 -1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("gensub() function", () => {
    it("should replace globally with g flag", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\n" }
      });
      const result = await env.exec(
        'awk \'{print gensub(/o/, "0", "g")}\' /data.txt'
      );
      expect(result.stdout).toBe("hell0 w0rld\n");
      expect(result.exitCode).toBe(0);
    });

    it("should replace Nth occurrence", async () => {
      const env = new Bash({
        files: { "/data.txt": "foo bar foo baz foo\n" }
      });
      const result = await env.exec(
        "awk '{print gensub(/foo/, \"XXX\", 2)}' /data.txt"
      );
      expect(result.stdout).toBe("foo bar XXX baz foo\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("power operator", () => {
    it("should compute power with ^", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec("awk '{print 2^3}' /data.txt");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute power with **", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec("awk '{print 3**2}' /data.txt");
      expect(result.stdout).toBe("9\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("FILENAME and FNR variables", () => {
    it("should track FILENAME", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\n" }
      });
      const result = await env.exec("awk '{print FILENAME, NR}' /data.txt");
      expect(result.stdout).toBe("/data.txt 1\n/data.txt 2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should reset FNR per file", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "a1\na2\n",
          "/b.txt": "b1\nb2\n"
        }
      });
      const result = await env.exec(
        "awk '{print FILENAME, FNR, NR}' /a.txt /b.txt"
      );
      expect(result.stdout).toBe(
        "/a.txt 1 1\n/a.txt 2 2\n/b.txt 1 3\n/b.txt 2 4\n"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exit and next statements", () => {
    it("should exit with code", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec("awk 'NR==2{exit 5}' /data.txt");
      expect(result.exitCode).toBe(5);
    });

    it("should skip to next line with next", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec("awk '/b/{next}{print}' /data.txt");
      expect(result.stdout).toBe("a\nc\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("do-while loops", () => {
    it("should execute do-while at least once", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{i=0; do{i++}while(i<3); print i}'"
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("break and continue", () => {
    it("should break out of loop", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{for(i=1;i<=10;i++){if(i==5)break; print i}}'"
      );
      expect(result.stdout).toBe("1\n2\n3\n4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should continue to next iteration", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec(
        "awk 'BEGIN{for(i=1;i<=5;i++){if(i==3)continue; print i}}'"
      );
      expect(result.stdout).toBe("1\n2\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("printf formats", () => {
    it("should format hex with %x", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec("awk 'BEGIN{printf \"%x\\n\", 255}'");
      expect(result.stdout).toBe("ff\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format octal with %o", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec("awk 'BEGIN{printf \"%o\\n\", 8}'");
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format char with %c", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec("awk 'BEGIN{printf \"%c\\n\", 65}'");
      expect(result.stdout).toBe("A\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format scientific with %e", async () => {
      const env = new Bash({
        files: { "/data.txt": "test\n" }
      });
      const result = await env.exec("awk 'BEGIN{printf \"%.2e\\n\", 1234}'");
      expect(result.stdout).toBe("1.23e+3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("regex field separator", () => {
    it("should split on regex pattern", async () => {
      const env = new Bash({
        files: { "/data.txt": "a1b2c\n" }
      });
      const result = await env.exec(
        "awk -F'[0-9]+' '{print $1, $2, $3}' /data.txt"
      );
      expect(result.stdout).toBe("a b c\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
