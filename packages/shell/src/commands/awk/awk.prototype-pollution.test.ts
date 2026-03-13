import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

/**
 * Tests for AWK prototype pollution defense.
 *
 * AWK has several attack vectors:
 * 1. ENVIRON array - populated from shell environment
 * 2. User-defined variables - can have any name
 * 3. User-defined arrays - can have any key
 * 4. Field variables ($1, $2, etc.) - from user input
 */

const DANGEROUS_KEYWORDS = [
  "constructor",
  "__proto__",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__"
];

describe("AWK prototype pollution defense", () => {
  describe("ENVIRON with dangerous keywords", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 4)) {
      it(`should access ENVIRON["${keyword}"] safely`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `export ${keyword}=env_value; echo | awk 'BEGIN { print ENVIRON["${keyword}"] }'`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("env_value\n");
      });
    }

    it("should access ENVIRON with constructor key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `export constructor=ctor_val; echo | awk 'BEGIN { print ENVIRON["constructor"] }'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ctor_val\n");
    });
  });

  describe("AWK variables with dangerous names", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should allow variable named '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `echo | awk 'BEGIN { ${keyword} = "test_value"; print ${keyword} }'`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("test_value\n");
      });
    }

    it("should handle multiple dangerous keyword variables", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN {
          __proto__ = "a"
          constructor = "b"
          prototype = "c"
          print __proto__, constructor, prototype
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("AWK arrays with dangerous keys", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 4)) {
      it(`should allow array key '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `echo | awk 'BEGIN { arr["${keyword}"] = "value"; print arr["${keyword}"] }'`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("value\n");
      });
    }

    it("should iterate array with dangerous keys", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN {
          arr["__proto__"] = 1
          arr["constructor"] = 2
          arr["prototype"] = 3
          for (k in arr) print k, arr[k]
        }' | sort
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("__proto__ 1");
      expect(result.stdout).toContain("constructor 2");
      expect(result.stdout).toContain("prototype 3");
    });

    it("should handle 'in' operator with dangerous keys", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN {
          arr["__proto__"] = 1
          if ("__proto__" in arr) print "found"
          if ("constructor" in arr) print "not found"
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("found\n");
    });

    it("should delete array element with dangerous key", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN {
          arr["__proto__"] = 1
          delete arr["__proto__"]
          if ("__proto__" in arr) print "still there"
          else print "deleted"
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("deleted\n");
    });
  });

  describe("AWK -v with dangerous keywords", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 4)) {
      it(`should handle -v ${keyword}=value`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `echo | awk -v ${keyword}=injected 'BEGIN { print ${keyword} }'`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("injected\n");
      });
    }
  });

  describe("AWK field data with dangerous keywords", () => {
    it("should handle input containing __proto__", async () => {
      const env = new Bash();
      const result = await env.exec(`echo '__proto__' | awk '{ print $1 }'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });

    it("should handle input containing constructor", async () => {
      const env = new Bash();
      const result = await env.exec(`echo 'constructor' | awk '{ print $1 }'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });

    it("should handle CSV-like data with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo '__proto__,constructor,prototype' | awk -F, '{ print $1, $2, $3 }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__ constructor prototype\n");
    });

    it("should use dangerous keyword as field value in array", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo '__proto__ value1
constructor value2' | awk '{ data[$1] = $2 } END { print data["__proto__"], data["constructor"] }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("value1 value2\n");
    });
  });

  describe("AWK string functions with dangerous keywords", () => {
    it("should handle gsub with dangerous keyword pattern", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo '__proto__ test __proto__' | awk '{ gsub(/__proto__/, "replaced"); print }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("replaced test replaced\n");
    });

    it("should handle split with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN {
          str = "__proto__:constructor:prototype"
          n = split(str, arr, ":")
          print arr[1], arr[2], arr[3]
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__ constructor prototype\n");
    });

    it("should handle match with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo '__proto__' | awk '{ if (match($0, /__proto__/)) print "matched" }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("matched\n");
    });
  });

  describe("AWK printf with dangerous keywords", () => {
    it("should printf dangerous keywords safely", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN { printf "%s %s\\n", "__proto__", "constructor" }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__ constructor\n");
    });

    it("should sprintf dangerous keywords safely", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk 'BEGIN {
          s = sprintf("%s", "__proto__")
          print s
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });
  });

  describe("AWK user-defined functions with dangerous names", () => {
    it("should allow function named with prefix of dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk '
          function proto_func() { return "__proto__" }
          BEGIN { print proto_func() }
        '
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });

    it("should pass dangerous keyword as function argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo | awk '
          function echo_val(v) { return v }
          BEGIN { print echo_val("__proto__") }
        '
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });
  });

  describe("AWK special variables with dangerous content", () => {
    it("should handle FS as dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo 'a__proto__b' | awk -F '__proto__' '{ print $1, $2 }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b\n");
    });

    it("should handle RS containing dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo 'a b' | awk 'BEGIN { RS="__proto__" } { print $0 }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("a b");
    });

    it("should handle OFS as dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo 'a b' | awk 'BEGIN { OFS="__proto__" } { print $1, $2 }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a__proto__b\n");
    });
  });

  describe("AWK does not pollute JavaScript prototype", () => {
    it("should not pollute Object.prototype via ENVIRON", async () => {
      const env = new Bash();
      await env.exec(`
        export __proto__=polluted
        echo | awk 'BEGIN { print ENVIRON["__proto__"] }'
      `);

      // Verify JavaScript Object.prototype is not affected
      const testObj: Record<string, unknown> = {};
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(testObj.__proto__).toBe(Object.prototype);
    });

    it("should not pollute Object.prototype via AWK arrays", async () => {
      const env = new Bash();
      await env.exec(`
        echo | awk 'BEGIN {
          arr["__proto__"] = "polluted"
          arr["constructor"] = "hacked"
        }'
      `);

      // Verify JavaScript Object.prototype is not affected
      const testObj: Record<string, unknown> = {};
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(typeof testObj.constructor).toBe("function");
    });
  });
});
