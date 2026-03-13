import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cut command", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/test/passwd.txt":
          "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:User:/home/user:/bin/zsh\n",
        "/test/csv.txt": "name,age,city\nJohn,25,NYC\nJane,30,LA\n",
        "/test/tabs.txt": "col1\tcol2\tcol3\nval1\tval2\tval3\n",
        "/test/text.txt": "hello world\nabcdefghij\n"
      },
      cwd: "/test"
    });

  it("should cut first field with colon delimiter", async () => {
    const env = createEnv();
    const result = await env.exec("cut -d: -f1 /test/passwd.txt");
    expect(result.stdout).toBe("root\nuser\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should cut multiple fields", async () => {
    const env = createEnv();
    const result = await env.exec("cut -d: -f1,3 /test/passwd.txt");
    expect(result.stdout).toBe("root:0\nuser:1000\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should cut range of fields", async () => {
    const env = createEnv();
    const result = await env.exec("cut -d: -f1-3 /test/passwd.txt");
    expect(result.stdout).toBe("root:x:0\nuser:x:1000\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle CSV with comma delimiter", async () => {
    const env = createEnv();
    const result = await env.exec("cut -d, -f1,2 /test/csv.txt");
    expect(result.stdout).toBe("name,age\nJohn,25\nJane,30\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should use tab as default delimiter", async () => {
    const env = createEnv();
    const result = await env.exec("cut -f2 /test/tabs.txt");
    expect(result.stdout).toBe("col2\nval2\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should cut characters with -c", async () => {
    const env = createEnv();
    const result = await env.exec("cut -c1-5 /test/text.txt");
    expect(result.stdout).toBe("hello\nabcde\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should cut specific characters", async () => {
    const env = createEnv();
    const result = await env.exec("cut -c1,3,5 /test/text.txt");
    expect(result.stdout).toBe("hlo\nace\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should read from stdin via pipe", async () => {
    const env = createEnv();
    const result = await env.exec("echo 'a:b:c' | cut -d: -f2");
    expect(result.stdout).toBe("b\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle field from end with open range", async () => {
    const env = createEnv();
    const result = await env.exec("cut -d: -f5- /test/passwd.txt");
    expect(result.stdout).toBe(
      "root:/root:/bin/bash\nUser:/home/user:/bin/zsh\n"
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return error for non-existent file", async () => {
    const env = createEnv();
    const result = await env.exec("cut -f1 /test/nonexistent.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "cut: /test/nonexistent.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return error when no field or char specified", async () => {
    const env = createEnv();
    const result = await env.exec("cut /test/text.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "cut: you must specify a list of bytes, characters, or fields\n"
    );
    expect(result.exitCode).toBe(1);
  });
});
