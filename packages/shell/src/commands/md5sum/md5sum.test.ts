import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("md5sum", () => {
  describe("basic hashing", () => {
    it("should hash a simple string", async () => {
      const env = new Bash();
      const result = await env.exec("echo -n 'hello' | md5sum");
      // MD5 of "hello" is 5d41402abc4b2a76b9719d911017c592
      expect(result.stdout).toBe("5d41402abc4b2a76b9719d911017c592  -\n");
      expect(result.exitCode).toBe(0);
    });

    it("should hash empty input", async () => {
      const env = new Bash();
      const result = await env.exec("echo -n '' | md5sum");
      // MD5 of "" is d41d8cd98f00b204e9800998ecf8427e
      expect(result.stdout).toBe("d41d8cd98f00b204e9800998ecf8427e  -\n");
      expect(result.exitCode).toBe(0);
    });

    it("should hash a file", async () => {
      const env = new Bash();
      await env.exec("echo -n 'test' > /tmp/test.txt");
      const result = await env.exec("md5sum /tmp/test.txt");
      // MD5 of "test" is 098f6bcd4621d373cade4e832627b4f6
      expect(result.stdout).toBe(
        "098f6bcd4621d373cade4e832627b4f6  /tmp/test.txt\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should hash multiple files", async () => {
      const env = new Bash();
      await env.exec("echo -n 'a' > /tmp/a.txt");
      await env.exec("echo -n 'b' > /tmp/b.txt");
      const result = await env.exec("md5sum /tmp/a.txt /tmp/b.txt");
      expect(result.stdout).toContain(
        "0cc175b9c0f1b6a831c399e269772661  /tmp/a.txt"
      );
      expect(result.stdout).toContain(
        "92eb5ffee6ae2fec3ad71c777531578f  /tmp/b.txt"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("check mode", () => {
    it("should verify correct checksums", async () => {
      const env = new Bash();
      await env.exec("echo -n 'hello' > /tmp/hello.txt");
      await env.exec(
        "echo '5d41402abc4b2a76b9719d911017c592  /tmp/hello.txt' > /tmp/sums.txt"
      );
      const result = await env.exec("md5sum -c /tmp/sums.txt");
      expect(result.stdout).toContain("/tmp/hello.txt: OK");
      expect(result.exitCode).toBe(0);
    });

    it("should detect incorrect checksums", async () => {
      const env = new Bash();
      await env.exec("echo -n 'wrong' > /tmp/wrong.txt");
      await env.exec(
        "echo '5d41402abc4b2a76b9719d911017c592  /tmp/wrong.txt' > /tmp/sums.txt"
      );
      const result = await env.exec("md5sum -c /tmp/sums.txt");
      expect(result.stdout).toContain("/tmp/wrong.txt: FAILED");
      expect(result.stdout).toContain("WARNING");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("md5sum /tmp/nonexistent");
      expect(result.stdout).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--help", () => {
    it("should display help", async () => {
      const env = new Bash();
      const result = await env.exec("md5sum --help");
      expect(result.stdout).toContain("md5sum");
      expect(result.stdout).toContain("MD5");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("sha1sum", () => {
  it("should hash a simple string", async () => {
    const env = new Bash();
    const result = await env.exec("echo -n 'hello' | sha1sum");
    // SHA1 of "hello" is aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    expect(result.stdout).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d  -\n");
    expect(result.exitCode).toBe(0);
  });

  it("should hash empty input", async () => {
    const env = new Bash();
    const result = await env.exec("echo -n '' | sha1sum");
    // SHA1 of "" is da39a3ee5e6b4b0d3255bfef95601890afd80709
    expect(result.stdout).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709  -\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("binary files", () => {
  it("should hash binary file with invalid UTF-8 bytes correctly", async () => {
    // PNG magic bytes include 0x89 which is invalid UTF-8
    // If read as UTF-8, it would be corrupted and produce wrong hash
    const env = new Bash({
      files: {
        "/binary.dat": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
      }
    });
    const result = await env.exec("md5sum /binary.dat");
    // MD5 of bytes [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]
    expect(result.stdout).toBe(
      "8eece9cc616084e69299f7f1a53a6404  /binary.dat\n"
    );
    expect(result.exitCode).toBe(0);
  });

  it("should hash binary file with null bytes correctly", async () => {
    const env = new Bash({
      files: {
        "/nulls.dat": new Uint8Array([0x00, 0x00, 0x00, 0x00])
      }
    });
    const result = await env.exec("md5sum /nulls.dat");
    // MD5 of 4 null bytes
    expect(result.stdout).toBe(
      "f1d3ff8443297732862df21dc4e57262  /nulls.dat\n"
    );
    expect(result.exitCode).toBe(0);
  });

  it("should hash binary file with sha256sum correctly", async () => {
    const env = new Bash({
      files: {
        "/binary.dat": new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      }
    });
    const result = await env.exec("sha256sum /binary.dat");
    // SHA256 of bytes [0x89, 0x50, 0x4E, 0x47]
    expect(result.stdout).toBe(
      "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543  /binary.dat\n"
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("sha256sum", () => {
  it("should hash a simple string", async () => {
    const env = new Bash();
    const result = await env.exec("echo -n 'hello' | sha256sum");
    // SHA256 of "hello" is 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(result.stdout).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  -\n"
    );
    expect(result.exitCode).toBe(0);
  });

  it("should hash empty input", async () => {
    const env = new Bash();
    const result = await env.exec("echo -n '' | sha256sum");
    // SHA256 of "" is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(result.stdout).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  -\n"
    );
    expect(result.exitCode).toBe(0);
  });

  describe("--help", () => {
    it("should display help", async () => {
      const env = new Bash();
      const result = await env.exec("sha256sum --help");
      expect(result.stdout).toContain("sha256sum");
      expect(result.stdout).toContain("SHA256");
      expect(result.exitCode).toBe(0);
    });
  });
});
