import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq", () => {
  describe("raw output (-r)", () => {
    it("should output strings without quotes with -r", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"name\":\"test\"}' | jq -r '.name'"
      );
      expect(result.stdout).toBe("test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with --raw-output", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"msg\":\"hello\"}' | jq --raw-output '.msg'"
      );
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("compact output (-c)", () => {
    it("should output compact JSON with -c", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1,\"b\":2}' | jq -c '.'");
      expect(result.stdout).toBe('{"a":1,"b":2}\n');
      expect(result.exitCode).toBe(0);
    });

    it("should output compact arrays", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq -c '.'");
      expect(result.stdout).toBe("[1,2,3]\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("null input (-n)", () => {
    it("should work with null input", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'empty'");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("slurp (-s)", () => {
    it("should slurp multiple JSON values into array", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1\n2\n3' | jq -s '.'");
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3\n]\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sort keys (-S)", () => {
    it("should sort object keys with -S", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"z\":1,\"a\":2}' | jq -S '.'");
      expect(result.stdout).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("file input", () => {
    it("should read from file", async () => {
      const env = new Bash({
        files: { "/data.json": '{"value":123}' }
      });
      const result = await env.exec("jq '.value' /data.json");
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("multi-file input", () => {
    it("should process multiple files", async () => {
      const env = new Bash({
        files: {
          "/a.json": '{"name":"alice"}',
          "/b.json": '{"name":"bob"}',
          "/c.json": '{"name":"charlie"}'
        }
      });
      const result = await env.exec("jq '.name' /a.json /b.json /c.json");
      expect(result.stdout).toBe('"alice"\n"bob"\n"charlie"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should process many files in parallel", async () => {
      // Create 10 files to test batched parallel reading
      const files: Record<string, string> = {};
      for (let i = 0; i < 10; i++) {
        files[`/data/file${i}.json`] = JSON.stringify({ id: i, value: i * 10 });
      }
      const env = new Bash({ files });

      const filePaths = Object.keys(files).join(" ");
      const result = await env.exec(`jq '.id' ${filePaths}`);
      expect(result.stdout).toBe("0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n");
      expect(result.exitCode).toBe(0);
    });

    it("should error on first missing file", async () => {
      const env = new Bash({
        files: {
          "/a.json": '{"x":1}',
          "/c.json": '{"x":3}'
        }
      });
      const result = await env.exec("jq '.x' /a.json /missing.json /c.json");
      expect(result.stderr).toBe(
        "jq: /missing.json: No such file or directory\n"
      );
      expect(result.exitCode).toBe(2);
    });

    it("should handle files with different JSON structures", async () => {
      const env = new Bash({
        files: {
          "/obj.json": '{"type":"object","value":42}',
          "/arr.json": "[1,2,3]",
          "/str.json": '"hello"'
        }
      });
      const result = await env.exec("jq 'type' /obj.json /arr.json /str.json");
      expect(result.stdout).toBe('"object"\n"array"\n"string"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should handle NDJSON files with multiple JSON values per file", async () => {
      const env = new Bash({
        files: {
          "/file1.ndjson": '{"id":1}\n{"id":2}',
          "/file2.ndjson": '{"id":3}\n{"id":4}'
        }
      });
      const result = await env.exec("jq '.id' /file1.ndjson /file2.ndjson");
      expect(result.stdout).toBe("1\n2\n3\n4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -r flag across multiple files", async () => {
      const env = new Bash({
        files: {
          "/a.json": '{"msg":"hello"}',
          "/b.json": '{"msg":"world"}'
        }
      });
      const result = await env.exec("jq -r '.msg' /a.json /b.json");
      expect(result.stdout).toBe("hello\nworld\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -c flag across multiple files", async () => {
      const env = new Bash({
        files: {
          "/a.json": '{"x":1,"y":2}',
          "/b.json": '{"a":"b","c":"d"}'
        }
      });
      const result = await env.exec("jq -c '.' /a.json /b.json");
      expect(result.stdout).toBe('{"x":1,"y":2}\n{"a":"b","c":"d"}\n');
      expect(result.exitCode).toBe(0);
    });

    it("should work with filter that produces multiple outputs per file", async () => {
      const env = new Bash({
        files: {
          "/a.json": '{"items":["x","y"]}',
          "/b.json": '{"items":["z"]}'
        }
      });
      const result = await env.exec("jq '.items[]' /a.json /b.json");
      expect(result.stdout).toBe('"x"\n"y"\n"z"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should handle stdin marker with other files", async () => {
      const env = new Bash({
        files: {
          "/file.json": '{"from":"file"}'
        }
      });
      const result = await env.exec(
        'echo \'{"from":"stdin"}\' | jq ".from" - /file.json'
      );
      expect(result.stdout).toBe('"stdin"\n"file"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should work with glob patterns via shell expansion", async () => {
      const env = new Bash({
        files: {
          "/data/a.json": '{"n":1}',
          "/data/b.json": '{"n":2}',
          "/data/c.json": '{"n":3}'
        }
      });
      const result = await env.exec("jq '.n' /data/*.json");
      // Files are processed in glob order (usually alphabetical)
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with find | xargs pattern", async () => {
      const env = new Bash({
        files: {
          "/repo/issues/1.json": '{"author":"alice"}',
          "/repo/issues/2.json": '{"author":"bob"}',
          "/repo/pulls/1.json": '{"author":"charlie"}'
        }
      });
      const result = await env.exec(
        "find /repo -name '*.json' | sort | xargs jq -r '.author'"
      );
      expect(result.stdout).toBe("alice\nbob\ncharlie\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty files gracefully", async () => {
      const env = new Bash({
        files: {
          "/a.json": '{"x":1}',
          "/empty.json": "",
          "/b.json": '{"x":2}'
        }
      });
      // Empty files should be skipped (no output, no error)
      const result = await env.exec("jq '.x' /a.json /empty.json /b.json");
      expect(result.stdout).toBe("1\n2\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("JSON stream parsing (concatenated JSON)", () => {
    it("should handle concatenated pretty-printed JSON objects with -s", async () => {
      const env = new Bash({
        files: {
          "/file1.json": '{\n  "id": 1,\n  "merged": true\n}',
          "/file2.json": '{\n  "id": 2,\n  "merged": false\n}',
          "/file3.json": '{\n  "id": 3,\n  "merged": true\n}'
        }
      });
      // This simulates: cat file1.json file2.json file3.json | jq -s 'group_by(.merged)'
      const result = await env.exec(
        "cat /file1.json /file2.json /file3.json | jq -s 'group_by(.merged) | map({merged: .[0].merged, count: length})'"
      );
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      // group_by sorts by key: false < true (alphabetically)
      expect(output).toEqual([
        { merged: true, count: 2 },
        { merged: false, count: 1 }
      ]);
    });

    it("should handle concatenated compact JSON objects without -s", async () => {
      const env = new Bash({
        files: {
          "/data.json": '{"a":1}{"b":2}{"c":3}'
        }
      });
      const result = await env.exec("cat /data.json | jq '.'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '{\n  "a": 1\n}\n{\n  "b": 2\n}\n{\n  "c": 3\n}\n'
      );
    });

    it("should handle mixed JSON values in stream", async () => {
      const env = new Bash({
        files: {
          "/mixed.json": '{"obj":true}\n[1,2,3]\n"string"\n42\ntrue\nnull'
        }
      });
      const result = await env.exec("cat /mixed.json | jq -c '.'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '{"obj":true}\n[1,2,3]\n"string"\n42\ntrue\nnull\n'
      );
    });

    it("should slurp concatenated JSON into array", async () => {
      const env = new Bash({
        files: {
          "/stream.json": '{"x":1}\n{"x":2}\n{"x":3}'
        }
      });
      const result = await env.exec("cat /stream.json | jq -s 'length'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("3\n");
    });
  });

  describe("error handling", () => {
    it("should error on invalid JSON", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'not json' | jq '.'");
      expect(result.stderr).toBe(
        "jq: parse error: Invalid JSON at position 0: unexpected 'not'\n"
      );
      expect(result.exitCode).toBe(5);
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("jq . /missing.json");
      expect(result.stderr).toBe(
        "jq: /missing.json: No such file or directory\n"
      );
      expect(result.exitCode).toBe(2);
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await env.exec("jq --unknown '.'");
      expect(result.stderr).toBe("jq: unrecognized option '--unknown'\n");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown short option", async () => {
      const env = new Bash();
      const result = await env.exec("jq -x '.'");
      expect(result.stderr).toBe("jq: invalid option -- 'x'\n");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("help", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("jq --help");
      expect(result.stdout).toMatch(/jq.*JSON/);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exit status (-e)", () => {
    it("should exit 1 for null with -e", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1}' | jq -e '.missing'");
      expect(result.stdout).toBe("null\n");
      expect(result.exitCode).toBe(1);
    });

    it("should exit 1 for false with -e", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'false' | jq -e '.'");
      expect(result.stdout).toBe("false\n");
      expect(result.exitCode).toBe(1);
    });

    it("should exit 0 for truthy value with -e", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1}' | jq -e '.a'");
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("join output (-j)", () => {
    it("should not print newlines with -j", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq -j '.[]'");
      expect(result.stdout).toBe("123");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tab indentation (--tab)", () => {
    it("should use tabs for indentation with --tab", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1}' | jq --tab '.'");
      expect(result.stdout).toBe('{\n\t"a": 1\n}\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined flags", () => {
    it("should combine -rc flags", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"name\":\"test\"}' | jq -rc '.name'"
      );
      expect(result.stdout).toBe("test\n");
    });
  });
});
