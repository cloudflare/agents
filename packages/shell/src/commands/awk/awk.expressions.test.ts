import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk complex expressions", () => {
  describe("nested arithmetic", () => {
    it("should evaluate deeply nested parentheses", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print ((((1 + 2) * 3) - 4) / 5) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle complex formula", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (2 + 3) * (4 - 1) / (6 - 3) }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate quadratic expression", async () => {
      const env = new Bash();
      // ax^2 + bx + c where a=1, b=2, c=1, x=3 => 1*9 + 2*3 + 1 = 16
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a=1; b=2; c=1; x=3; print a*x*x + b*x + c }'`
      );
      expect(result.stdout).toBe("16\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle mixed operations with power", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 2^3 + 4^2 - 3^2 }'`
      );
      // 8 + 16 - 9 = 15
      expect(result.stdout).toBe("15\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nested conditionals", () => {
    it("should handle if-else if-else chain", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          x = 15
          if (x < 10) print "small"
          else if (x < 20) print "medium"
          else print "large"
        }'`
      );
      expect(result.stdout).toBe("medium\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle nested if statements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          x = 5; y = 10
          if (x > 0)
            if (y > 0)
              print "both positive"
        }'`
      );
      expect(result.stdout).toBe("both positive\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle ternary in ternary", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          x = 50
          print x < 30 ? "low" : (x < 70 ? "medium" : "high")
        }'`
      );
      expect(result.stdout).toBe("medium\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle ternary with complex conditions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a = 5; b = 10
          print (a > 0 && b > 0) ? "both positive" : "not both positive"
        }'`
      );
      expect(result.stdout).toBe("both positive\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nested loops", () => {
    it("should handle nested for loops", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          for (i=1; i<=3; i++)
            for (j=1; j<=3; j++)
              printf "%d", i*j
          print ""
        }'`
      );
      expect(result.stdout).toBe("123246369\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle for-while nesting", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          for (i=1; i<=2; i++) {
            j = 1
            while (j <= 2) {
              printf "%d%d ", i, j
              j++
            }
          }
          print ""
        }'`
      );
      expect(result.stdout).toBe("11 12 21 22 \n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle break in inner loop only", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          for (i=1; i<=3; i++) {
            for (j=1; j<=3; j++) {
              if (j == 2) break
              printf "%d%d ", i, j
            }
          }
          print ""
        }'`
      );
      expect(result.stdout).toBe("11 21 31 \n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle continue in inner loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          for (i=1; i<=2; i++) {
            for (j=1; j<=3; j++) {
              if (j == 2) continue
              printf "%d%d ", i, j
            }
          }
          print ""
        }'`
      );
      expect(result.stdout).toBe("11 13 21 23 \n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("chained comparisons and logic", () => {
    it("should handle chained && operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 && 2 && 3 && 4) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle chained || operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (0 || 0 || 0 || 5) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle mixed && and ||", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 && 0 || 1) }'`
      );
      // (1 && 0) = 0, (0 || 1) = 1
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle complex boolean expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a=1; b=0; c=1; d=0
          print ((a && b) || (c && !d))
        }'`
      );
      // (1 && 0) = 0, !0 = 1, (1 && 1) = 1, (0 || 1) = 1
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("function calls in expressions", () => {
    it("should use function result in arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print length("hello") * 2 }'`
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should chain function calls", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print substr(toupper("hello world"), 1, 5) }'`
      );
      expect(result.stdout).toBe("HELLO\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use function in condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if (length("test") > 3) print "long" }'`
      );
      expect(result.stdout).toBe("long\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use function result as array index", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a[3] = "three"
          print a[int(3.7)]
        }'`
      );
      expect(result.stdout).toBe("three\n");
      expect(result.exitCode).toBe(0);
    });

    it("should nest function calls", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sqrt(sqrt(16)) }'`
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("complex field expressions", () => {
    it("should use computed field index", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c d e" | awk '{ i=2; print $(i+1) }'`
      );
      expect(result.stdout).toBe("c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use field in arithmetic expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "10 20 30" | awk '{ print ($1 + $2) * $3 / 100 }'`
      );
      expect(result.stdout).toBe("9\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use field value as index", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "2 a b c d" | awk '{ print $($1+1) }'`
      );
      // $1 is "2", $1+1 is 3, $(3) is "b"
      expect(result.stdout).toBe("b\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle NF in expressions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c d" | awk '{ print $(NF-1), $(NF/2) }'`
      );
      // NF=4, NF-1=3 ($3="c"), NF/2=2 ($2="b")
      expect(result.stdout).toBe("c b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string expression combinations", () => {
    it("should concatenate multiple expressions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "a" "b" 1+1 "c" length("dd") }'`
      );
      expect(result.stdout).toBe("ab2c2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use sprintf result in expressions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          s = sprintf("%03d", 42)
          print length(s), s
        }'`
      );
      expect(result.stdout).toBe("3 042\n");
      expect(result.exitCode).toBe(0);
    });

    it("should build string with loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          s = ""
          for (i=1; i<=5; i++) s = s i
          print s
        }'`
      );
      expect(result.stdout).toBe("12345\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array expressions", () => {
    it("should use expression as array key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a["key1"] = "v1"
          a["key2"] = "v2"
          i = 1
          print a["key" i], a["key" (i+1)]
        }'`
      );
      expect(result.stdout).toBe("v1 v2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute with array values", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a[1]=10; a[2]=20; a[3]=30
          print a[1] + a[2] + a[3]
        }'`
      );
      expect(result.stdout).toBe("60\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use nested array access", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a[1] = 2
          a[2] = 3
          print a[a[1]]
        }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("assignment expressions", () => {
    it("should use assignment result", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (x = 5) + (y = 3) }'`
      );
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should chain assignments", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a = b = c = 10; print a, b, c }'`
      );
      expect(result.stdout).toBe("10 10 10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use increment result in expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print x++ * 2, x }'`
      );
      // x++ returns 5, then x becomes 6; 5*2=10
      expect(result.stdout).toBe("10 6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use pre-increment in expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print ++x * 2, x }'`
      );
      // ++x returns 6, x is 6; 6*2=12
      expect(result.stdout).toBe("12 6\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("regex in expressions", () => {
    it("should use regex match result in arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ print ($0 ~ /hello/) * 100 }'`
      );
      expect(result.stdout).toBe("100\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use match() result in expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ pos = match($0, /world/); print pos > 0 ? "found at " pos : "not found" }'`
      );
      expect(result.stdout).toBe("found at 7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine regex matches with logic", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ print ($0 ~ /hello/ && $0 ~ /world/) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined complex examples", () => {
    it("should compute factorial iteratively", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          n = 5; fact = 1
          for (i = 2; i <= n; i++) fact *= i
          print fact
        }'`
      );
      expect(result.stdout).toBe("120\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute fibonacci", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          a = 0; b = 1
          for (i = 0; i < 10; i++) {
            printf "%d ", a
            t = a; a = b; b = t + b
          }
          print ""
        }'`
      );
      expect(result.stdout).toBe("0 1 1 2 3 5 8 13 21 34 \n");
      expect(result.exitCode).toBe(0);
    });

    it("should find max in data", async () => {
      const env = new Bash({
        files: { "/data.txt": "5\n12\n3\n9\n7\n" }
      });
      const result = await env.exec(
        `awk 'NR==1 || $1 > max { max = $1 } END { print max }' /data.txt`
      );
      expect(result.stdout).toBe("12\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute average", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n20\n30\n40\n" }
      });
      const result = await env.exec(
        `awk '{ sum += $1; count++ } END { print sum / count }' /data.txt`
      );
      expect(result.stdout).toBe("25\n");
      expect(result.exitCode).toBe(0);
    });

    it("should reverse string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {
          s = "hello"
          r = ""
          for (i = length(s); i > 0; i--) r = r substr(s, i, 1)
          print r
        }'`
      );
      expect(result.stdout).toBe("olleh\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
