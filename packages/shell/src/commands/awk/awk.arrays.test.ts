import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk associative arrays", () => {
  describe("basic array operations", () => {
    it("should create and access array elements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["foo"] = 42; print a["foo"] }'`
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support numeric indices", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1] = "one"; a[2] = "two"; print a[1], a[2] }'`
      );
      expect(result.stdout).toBe("one two\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return empty string for uninitialized element", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "[" a["missing"] "]" }'`
      );
      expect(result.stdout).toBe("[]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should overwrite existing array elements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 1; a["x"] = 2; print a["x"] }'`
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support expressions as indices", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=5; a[i*2] = "ten"; print a[10] }'`
      );
      expect(result.stdout).toBe("ten\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support string concatenation as index", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["key" "1"] = "value"; print a["key1"] }'`
      );
      expect(result.stdout).toBe("value\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("in operator", () => {
    it("should return true for existing key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 1; if ("x" in a) print "found" }'`
      );
      expect(result.stdout).toBe("found\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return false for missing key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 1; if ("y" in a) print "found"; else print "not found" }'`
      );
      expect(result.stdout).toBe("not found\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with numeric keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[42] = "answer"; print (42 in a), (99 in a) }'`
      );
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not create element when checking with in", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if ("x" in a) print "yes"; for (k in a) print k }'`
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("delete statement", () => {
    it("should delete array element", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 1; delete a["x"]; print ("x" in a) }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not error when deleting non-existent element", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { delete a["missing"]; print "ok" }'`
      );
      expect(result.stdout).toBe("ok\n");
      expect(result.exitCode).toBe(0);
    });

    it("should delete entire array", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1]=1; a[2]=2; a[3]=3; delete a; for(k in a) count++; print count+0 }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("for-in loops", () => {
    it("should iterate over array keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["a"]=1; a["b"]=2; a["c"]=3; for (k in a) count++; print count }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access values via key in loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1]=10; a[2]=20; a[3]=30; sum=0; for (k in a) sum += a[k]; print sum }'`
      );
      expect(result.stdout).toBe("60\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty array", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for (k in a) print k; print "done" }'`
      );
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("split() function with arrays", () => {
    it("should split string into array", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { n = split("a:b:c", arr, ":"); print n, arr[1], arr[2], arr[3] }'`
      );
      expect(result.stdout).toBe("3 a b c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return count of elements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { n = split("one,two,three,four", arr, ","); print n }'`
      );
      expect(result.stdout).toBe("4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should split on whitespace by default", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { n = split("a b c", arr); print n, arr[1], arr[2], arr[3] }'`
      );
      expect(result.stdout).toBe("3 a b c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should clear existing array before split", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { arr[5]="old"; split("a:b", arr, ":"); print (5 in arr), arr[1], arr[2] }'`
      );
      expect(result.stdout).toBe("0 a b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("counting with arrays", () => {
    it("should count occurrences", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\napple\ncherry\napple\n" }
      });
      const result = await env.exec(
        `awk '{ count[$1]++ } END { print count["apple"] }' /data.txt`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should count unique values", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\na\nc\nb\na\n" }
      });
      const result = await env.exec(
        `awk '{ seen[$1]++ } END { for (k in seen) n++; print n }' /data.txt`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should sum values by category", async () => {
      const env = new Bash({
        files: { "/data.csv": "fruit,10\nveg,20\nfruit,15\nveg,5\n" }
      });
      const result = await env.exec(
        `awk -F, '{ sum[$1]+=$2 } END { print sum["fruit"], sum["veg"] }' /data.csv`
      );
      expect(result.stdout).toBe("25 25\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("multi-dimensional arrays (SUBSEP)", () => {
    it("should simulate 2D array with SUBSEP", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1,2] = "val"; print a[1,2] }'`
      );
      expect(result.stdout).toBe("val\n");
      expect(result.exitCode).toBe(0);
    });

    it("should store matrix values", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a[0,0]=1; a[0,1]=2;
          a[1,0]=3; a[1,1]=4;
          print a[0,0], a[0,1], a[1,0], a[1,1]
        }'`
      );
      expect(result.stdout).toBe("1 2 3 4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should check multi-dimensional key with in", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1,2] = "x"; print ((1,2) in a), ((1,3) in a) }'`
      );
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("arrays with field data", () => {
    it("should use field value as key", async () => {
      const env = new Bash({
        files: { "/data.txt": "alice 100\nbob 200\nalice 50\n" }
      });
      const result = await env.exec(
        `awk '{ totals[$1] += $2 } END { print totals["alice"], totals["bob"] }' /data.txt`
      );
      expect(result.stdout).toBe("150 200\n");
      expect(result.exitCode).toBe(0);
    });

    it("should store lines by field", async () => {
      const env = new Bash({
        files: { "/data.txt": "1 first\n2 second\n3 third\n" }
      });
      const result = await env.exec(
        `awk '{ lines[$1] = $2 } END { print lines[2] }' /data.txt`
      );
      expect(result.stdout).toBe("second\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array increment patterns", () => {
    it("should pre-increment array element", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 5; print ++a["x"], a["x"] }'`
      );
      expect(result.stdout).toBe("6 6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should post-increment array element", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 5; print a["x"]++, a["x"] }'`
      );
      expect(result.stdout).toBe("5 6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compound assign to array element", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["x"] = 10; a["x"] += 5; a["x"] *= 2; print a["x"] }'`
      );
      expect(result.stdout).toBe("30\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
