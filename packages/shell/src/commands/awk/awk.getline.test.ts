import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk getline", () => {
  it("reads next line into $0", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `header
value1
value2
value3`
      }
    });
    const result = await env.exec(
      "awk '/header/ { getline; print }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("value1\n");
  });

  it("reads next line into variable", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `name: Alice
age: 30
name: Bob
age: 25`
      }
    });
    const result = await env.exec(
      "awk '/^name:/ { getline age_line; print $2, age_line }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Alice age: 30\nBob age: 25\n");
  });

  it("updates NR when reading next line", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `line1
line2
line3`
      }
    });
    const result = await env.exec(
      "awk '{ print NR; getline; print NR }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    // First iteration: NR=1, after getline NR=2
    // Second iteration: NR=3, after getline would go past end
    expect(result.stdout).toBe("1\n2\n3\n3\n");
  });

  it("skips lines when used in pattern match", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `header1
data1
header2
data2
header3
data3`
      }
    });
    const result = await env.exec(
      "awk '/^header/ { print; getline; print \"  ->\" $0 }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "header1\n  ->data1\nheader2\n  ->data2\nheader3\n  ->data3\n"
    );
  });

  it("handles getline at end of file gracefully", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `only line`
      }
    });
    const result = await env.exec(
      "awk '{ print $0; getline; print \"after: \" $0 }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    // getline at EOF doesn't change $0
    expect(result.stdout).toBe("only line\nafter: only line\n");
  });

  it("combines lines using getline", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `key1
value1
key2
value2`
      }
    });
    const result = await env.exec(
      "awk 'NR % 2 == 1 { key = $0; getline; print key \": \" $0 }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("key1: value1\nkey2: value2\n");
  });

  it("reads from external file with getline < file", async () => {
    const env = new Bash({
      files: {
        "/test/main.txt": `line1
line2`,
        "/test/other.txt": `external1
external2
external3`
      }
    });
    const result = await env.exec(
      `awk '{ getline ext < "/test/other.txt"; print $0, ext }' /test/main.txt`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("line1 external1\nline2 external2\n");
  });

  it("reads entire file line by line with getline < file", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `a
b
c`
      }
    });
    const result = await env.exec(
      `awk 'BEGIN { while ((getline line < "/test/data.txt") > 0) print "got:", line }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("got: a\ngot: b\ngot: c\n");
  });

  it("returns -1 for nonexistent file in getline", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN { ret = getline x < "/nonexistent"; print "ret:", ret }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ret: -1\n");
  });
});

describe("awk command pipe getline", () => {
  it("reads from command pipe into $0", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN { "echo hello" | getline; print }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("reads from command pipe into variable", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN { "echo world" | getline x; print "got:", x }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("got: world\n");
  });

  it("reads multiple lines from command pipe", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "line1\nline2\nline3" }
    });
    const result = await env.exec(
      `awk 'BEGIN { while (("cat /test/data.txt") | getline line) print "read:", line }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("read: line1\nread: line2\nread: line3\n");
  });

  it("updates fields after command pipe getline into $0", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN { FS=":"; "echo a:bc:def" | getline; print NF, $1, $2 }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("3 a bc\n");
  });

  it("returns 1 on success, 0 on EOF", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN {
        ret1 = ("echo single" | getline)
        ret2 = ("echo single" | getline)  # second call to same command returns EOF
        print ret1, ret2
      }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1 0\n");
  });
});

describe("awk print to file", () => {
  it("writes to file with print > file", async () => {
    const env = new Bash({
      files: {
        "/test/input.txt": `hello
world`
      }
    });
    const result = await env.exec(
      `awk '{ print $0 > "/test/output.txt" }' /test/input.txt`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    const output = await env.readFile("/test/output.txt");
    expect(output).toBe("hello\nworld\n");
  });

  it("overwrites then appends with > on same file", async () => {
    const env = new Bash({
      files: {
        "/test/input.txt": `line1
line2
line3`
      }
    });
    const result = await env.exec(
      `awk '{ print $0 > "/test/out.txt" }' /test/input.txt`
    );
    expect(result.exitCode).toBe(0);

    const output = await env.readFile("/test/out.txt");
    expect(output).toBe("line1\nline2\nline3\n");
  });

  it("appends with print >> file", async () => {
    const env = new Bash({
      files: {
        "/test/existing.txt": "existing\n",
        "/test/input.txt": `new1
new2`
      }
    });
    const result = await env.exec(
      `awk '{ print $0 >> "/test/existing.txt" }' /test/input.txt`
    );
    expect(result.exitCode).toBe(0);

    const output = await env.readFile("/test/existing.txt");
    expect(output).toBe("existing\nnew1\nnew2\n");
  });

  it("printf writes to file", async () => {
    const env = new Bash({
      files: {
        "/test/input.txt": `1
2
3`
      }
    });
    const result = await env.exec(
      `awk '{ printf "%03d\\n", $1 > "/test/out.txt" }' /test/input.txt`
    );
    expect(result.exitCode).toBe(0);

    const output = await env.readFile("/test/out.txt");
    expect(output).toBe("001\n002\n003\n");
  });
});

describe("awk getline return values", () => {
  it("returns 1 on successful read", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "line1\nline2" }
    });
    const result = await env.exec(
      `awk 'BEGIN { ret = (getline < "/test/data.txt"); print "ret:", ret }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ret: 1\n");
  });

  it("returns 0 on EOF", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "single" }
    });
    const result = await env.exec(
      `awk 'BEGIN {
        getline < "/test/data.txt"  # read first line
        ret = (getline < "/test/data.txt")  # EOF
        print "ret:", ret
      }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ret: 0\n");
  });

  it("returns -1 on error", async () => {
    const env = new Bash();
    const result = await env.exec(
      `awk 'BEGIN { ret = (getline < "/nonexistent/file"); print "ret:", ret }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ret: -1\n");
  });
});

describe("awk getline with field separator", () => {
  it("re-splits $0 after getline", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "a:b:c" }
    });
    const result = await env.exec(
      `awk 'BEGIN { FS=":"; getline < "/test/data.txt"; print $2 }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("b\n");
  });

  it("does not re-split when getline into variable", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "a:b:c" }
    });
    const result = await env.exec(
      `awk 'BEGIN { FS=":"; getline x < "/test/data.txt"; print x; print NF }'`
    );
    expect(result.exitCode).toBe(0);
    // x gets whole line, NF is still 0 (no main input)
    expect(result.stdout).toBe("a:b:c\n0\n");
  });
});

describe("awk getline in loop", () => {
  it("reads all lines in while loop", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "1\n2\n3\n4\n5" }
    });
    const result = await env.exec(
      `awk 'BEGIN { sum=0; while ((getline n < "/test/data.txt") > 0) sum += n; print sum }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("15\n");
  });

  it("counts lines with getline loop", async () => {
    const env = new Bash({
      files: { "/test/data.txt": "a\nb\nc\nd" }
    });
    const result = await env.exec(
      `awk 'BEGIN { count=0; while ((getline < "/test/data.txt") > 0) count++; print count }'`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4\n");
  });
});
