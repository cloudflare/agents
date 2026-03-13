/**
 * AWK Prototype Pollution Prevention Tests
 *
 * Tests ensuring JavaScript prototype keywords are handled safely
 * in AWK contexts: arrays, for-in loops, function parameters, getline.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

const DANGEROUS_KEYWORDS = [
  "constructor",
  "__proto__",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf"
];

describe("AWK Prototype Pollution Prevention", () => {
  describe("Array with Dangerous Name", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should allow array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "a b c" | awk '{
            ${keyword}[1] = "first"
            ${keyword}[2] = "second"
            ${keyword}[3] = "third"
            print ${keyword}[1], ${keyword}[2], ${keyword}[3]
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("first second third\n");
      });

      it(`should iterate array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword}["a"] = 1
            ${keyword}["b"] = 2
            ${keyword}["c"] = 3
            for (k in ${keyword}) {
              print k, ${keyword}[k]
            }
          }' | sort
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("a 1");
        expect(result.stdout).toContain("b 2");
        expect(result.stdout).toContain("c 3");
      });

      it(`should delete from array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword}[1] = "val"
            delete ${keyword}[1]
            print (1 in ${keyword}) ? "exists" : "deleted"
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("deleted\n");
      });

      it(`should check membership in array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword}["key"] = "val"
            print ("key" in ${keyword}) ? "yes" : "no"
            print ("missing" in ${keyword}) ? "yes" : "no"
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("yes\nno\n");
      });
    }
  });

  describe("For-In Loop Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should use ${keyword} as for-in loop variable`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            arr["x"] = 1
            arr["y"] = 2
            arr["z"] = 3
            for (${keyword} in arr) {
              print ${keyword}, arr[${keyword}]
            }
          }' | sort
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("x 1");
        expect(result.stdout).toContain("y 2");
        expect(result.stdout).toContain("z 3");
      });

      it(`should preserve ${keyword} value after for-in`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            arr["only"] = 42
            for (${keyword} in arr) { }
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("only\n");
      });
    }
  });

  describe("Function Parameters", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use ${keyword} as function parameter`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '
            function myfunc(${keyword}) {
              return ${keyword} * 2
            }
            {
              print myfunc(21)
            }
          '
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("42\n");
      });

      it(`should use ${keyword} as local variable in function`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '
            function myfunc(    ${keyword}) {
              ${keyword} = "local"
              return ${keyword}
            }
            {
              print myfunc()
            }
          '
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("local\n");
      });

      it(`should isolate ${keyword} parameter from global`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '
            function myfunc(${keyword}) {
              ${keyword} = "modified"
            }
            BEGIN {
              ${keyword} = "global"
            }
            {
              myfunc("arg")
              print ${keyword}
            }
          '
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("global\n");
      });
    }

    it("should handle multiple dangerous parameters", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "test" | awk '
          function myfunc(constructor, __proto__, prototype) {
            return constructor + __proto__ + prototype
          }
          {
            print myfunc(1, 2, 3)
          }
        '
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("6\n");
    });
  });

  describe("Getline Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use ${keyword} with getline`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo -e "line1\\nline2" | awk '{
            if ((getline ${keyword}) > 0) {
              print "got:", ${keyword}
            }
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("got: line2\n");
      });

      it(`should use ${keyword} with getline from command`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            "echo hello" | getline ${keyword}
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n");
      });
    }
  });

  describe("Split with Dangerous Array Name", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should split into array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "a,b,c" | awk '{
            n = split($0, ${keyword}, ",")
            print n, ${keyword}[1], ${keyword}[2], ${keyword}[3]
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("3 a b c\n");
      });

      it(`should split with ${keyword} as separator variable`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "a:b:c" | awk -v ${keyword}=":" '{
            n = split($0, arr, ${keyword})
            print n, arr[1], arr[2], arr[3]
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("3 a b c\n");
      });
    }
  });

  describe("Sub/Gsub with Dangerous Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should gsub into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword} = "hello world"
            gsub(/o/, "0", ${keyword})
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hell0 w0rld\n");
      });

      it(`should sub into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword} = "hello world"
            sub(/o/, "0", ${keyword})
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hell0 world\n");
      });
    }
  });

  describe("Increment/Compound Assignment", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should increment ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword} = 5
            ${keyword}++
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("6\n");
      });

      it(`should compound assign to ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword} = 10
            ${keyword} += 5
            ${keyword} *= 2
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("30\n");
      });
    }
  });

  describe("Object.prototype Verification", () => {
    it("should not pollute Object.prototype after AWK operations", async () => {
      const bash = new Bash();

      // Run multiple AWK operations with dangerous keywords
      await bash.exec(`
        echo "test" | awk '{
          constructor = "value"
          __proto__ = "value"
          prototype = "value"
          arr["constructor"] = 1
          arr["__proto__"] = 2
          for (constructor in arr) { }
        }'
      `);

      // Verify Object.prototype is clean
      const testObj: Record<string, unknown> = {};
      expect(testObj.constructor).toBe(Object);
      expect(Object.hasOwn(Object.prototype, "value")).toBe(false);
      expect(Object.keys(Object.prototype).length).toBe(0);
    });
  });
});
