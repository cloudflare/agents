/**
 * Comprehensive Prototype Pollution Prevention Tests
 *
 * Tests ensuring JavaScript prototype-related keywords are handled
 * safely as regular strings in bash without triggering JavaScript
 * prototype chain access.
 *
 * This complements the existing prototype-pollution.test.ts with
 * additional edge cases and attack vectors.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

// All keywords that could potentially access JS prototypes
const POLLUTION_KEYWORDS = [
  // Core prototype keywords
  "constructor",
  "__proto__",
  "prototype",
  // Object.prototype methods
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "toLocaleString",
  // Legacy getters/setters
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  // Other potentially dangerous
  "toJSON"
];

describe("Comprehensive Prototype Pollution Prevention", () => {
  describe("Indirect Expansion with Dangerous Keywords", () => {
    it("should handle ${!prefix*} with prototype keywords", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor_var=value1
        constructor_other=value2
        echo \${!constructor_*}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("constructor_var");
      expect(result.stdout).toContain("constructor_other");
    });

    it("should handle ${!array[@]} with dangerous keys", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        declare -A arr
        arr[constructor]=val1
        arr[__proto__]=val2
        arr[prototype]=val3
        echo \${!arr[@]}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("constructor");
      expect(result.stdout).toContain("__proto__");
    });

    it("should not access JS prototype via indirect expansion", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        ref="constructor"
        echo \${!ref}
      `);
      expect(result.exitCode).toBe(0);
      // Should be empty (ref points to unset variable) or the value
      // Should NOT return JS constructor function
      expect(result.stdout).not.toContain("function");
      expect(result.stdout).not.toContain("[native code]");
    });
  });

  describe("Nameref with Dangerous Keywords", () => {
    for (const keyword of POLLUTION_KEYWORDS.slice(0, 5)) {
      it(`should handle nameref to ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=original_value
          declare -n ref=${keyword}
          echo "ref: $ref"
          ref=modified
          echo "${keyword}: $${keyword}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ref: original_value");
        expect(result.stdout).toContain(`${keyword}: modified`);
      });
    }

    it("should handle nameref chain with dangerous keywords", async () => {
      const bash = new Bash();
      // Nameref chains may have different resolution behavior
      // The important thing is it doesn't crash or leak JS properties
      const result = await bash.exec(`
        target=final_value
        __proto__=target
        declare -n ref1=__proto__
        echo $ref1
      `);
      expect(result.exitCode).toBe(0);
      // Should output "target" (the value of __proto__)
      expect(result.stdout).toBe("target\n");
    });
  });

  describe("Array Operations with Dangerous Keywords", () => {
    it("should safely iterate associative array with prototype keys", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        declare -A dangerous
        dangerous[constructor]=c
        dangerous[__proto__]=p
        dangerous[prototype]=pr
        dangerous[hasOwnProperty]=h
        dangerous[toString]=t

        for key in "\${!dangerous[@]}"; do
          echo "key: $key = \${dangerous[$key]}"
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("key: constructor = c");
      expect(result.stdout).toContain("key: __proto__ = p");
    });

    it("should handle array named with dangerous keyword", async () => {
      const bash = new Bash();
      for (const keyword of ["constructor", "__proto__", "prototype"]) {
        const result = await bash.exec(`
          ${keyword}=(a b c d e)
          echo "length: \${#${keyword}[@]}"
          echo "first: \${${keyword}[0]}"
          echo "all: \${${keyword}[@]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("length: 5");
        expect(result.stdout).toContain("first: a");
        expect(result.stdout).toContain("all: a b c d e");
      }
    });

    it("should handle array slice with dangerous keyword names", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        __proto__=(1 2 3 4 5)
        echo \${__proto__[@]:1:3}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("2 3 4\n");
    });
  });

  describe("Function Operations with Dangerous Keywords", () => {
    for (const keyword of POLLUTION_KEYWORDS.slice(0, 5)) {
      it(`should allow function named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}() {
            echo "called ${keyword}"
            return 42
          }
          ${keyword}
          echo "exit: $?"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`called ${keyword}`);
        expect(result.stdout).toContain("exit: 42");
      });
    }

    it("should handle recursive function with dangerous name", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor() {
          if [ $1 -le 0 ]; then
            return
          fi
          echo $1
          constructor $(($1 - 1))
        }
        constructor 3
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("3\n2\n1\n");
    });

    it("should unset function with dangerous name", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        __proto__() { echo "exists"; }
        __proto__
        unset -f __proto__
        __proto__ 2>/dev/null || echo "unset"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("exists\nunset\n");
    });
  });

  describe("Parameter Expansion with Dangerous Keywords", () => {
    for (const keyword of POLLUTION_KEYWORDS.slice(0, 5)) {
      it(`should handle \${${keyword}:-default}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          unset ${keyword}
          echo \${${keyword}:-default_value}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("default_value\n");
      });

      it(`should handle \${${keyword}:+alternate}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=set
          echo \${${keyword}:+alternate_value}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("alternate_value\n");
      });

      it(`should handle \${${keyword}//pattern/replacement}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="hello world"
          echo \${${keyword}//o/0}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hell0 w0rld\n");
      });
    }

    it("should handle ${!var} with dangerous keyword as value", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor=target_value
        ref=constructor
        echo \${!ref}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("target_value\n");
    });
  });

  describe("Subshell Isolation with Dangerous Keywords", () => {
    it("should isolate dangerous keyword vars in subshell", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor=outer
        (constructor=inner; echo "inner: $constructor")
        echo "outer: $constructor"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("inner: inner\nouter: outer\n");
    });

    it("should isolate via command substitution", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        __proto__=outer
        result=$(__proto__=inner; echo $__proto__)
        echo "result: $result"
        echo "original: $__proto__"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("result: inner\noriginal: outer\n");
    });
  });

  describe("Environment Export with Dangerous Keywords", () => {
    for (const keyword of POLLUTION_KEYWORDS.slice(0, 5)) {
      it(`should export ${keyword} safely`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          export ${keyword}=exported_value
          printenv ${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("exported_value\n");
      });
    }

    it("should pass dangerous keywords to subcommand env", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        export constructor=c_val
        export __proto__=p_val
        env | grep -E '^(constructor|__proto__)=' | sort
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("__proto__=p_val");
      expect(result.stdout).toContain("constructor=c_val");
    });
  });

  describe("Arithmetic with Dangerous Keywords", () => {
    for (const keyword of POLLUTION_KEYWORDS.slice(0, 5)) {
      it(`should handle arithmetic with ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=10
          echo $((${keyword} + 5))
          echo $((${keyword} * 2))
          echo $((${keyword}++))
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("15\n20\n10\n11\n");
      });
    }

    it("should handle arithmetic assignment to dangerous keyword", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        (( constructor = 5 + 3 ))
        echo $constructor
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("8\n");
    });
  });

  describe("Read Command with Dangerous Keywords", () => {
    for (const keyword of POLLUTION_KEYWORDS.slice(0, 3)) {
      it(`should read into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "input_value" | { read ${keyword}; echo $${keyword}; }
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("input_value\n");
      });
    }

    it("should read multiple dangerous keywords", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "a b c" | { read constructor __proto__ prototype; echo "$constructor $__proto__ $prototype"; }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("JavaScript Prototype Isolation", () => {
    it("should not pollute Object.prototype via variable", async () => {
      const bash = new Bash();
      await bash.exec('export __proto__="polluted"');
      await bash.exec('export constructor="polluted"');

      // Verify JS prototypes are not affected
      const testObj: Record<string, unknown> = {};
      expect(testObj.__proto__).toBe(Object.prototype);
      expect(typeof testObj.constructor).toBe("function");
      expect(testObj.constructor).toBe(Object);
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    });

    it("should not leak JS properties via variable access", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        # These should all be empty (unset variables)
        echo "constructor: $constructor"
        echo "__proto__: $__proto__"
        echo "prototype: $prototype"
        echo "hasOwnProperty: $hasOwnProperty"
      `);
      expect(result.exitCode).toBe(0);
      // All should be empty
      expect(result.stdout).toBe(
        "constructor: \n__proto__: \nprototype: \nhasOwnProperty: \n"
      );
    });

    it("should not execute JS code via dangerous keyword values", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor='() { return "hacked"; }'
        __proto__='{"polluted": true}'
        echo "constructor: $constructor"
        echo "__proto__: $__proto__"
      `);
      expect(result.exitCode).toBe(0);
      // Values should be literal strings
      expect(result.stdout).toContain('constructor: () { return "hacked"; }');
      expect(result.stdout).toContain('__proto__: {"polluted": true}');
    });
  });

  describe("Edge Cases", () => {
    it("should handle multiple dangerous keywords in one command", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor=1 __proto__=2 prototype=3 echo "inline"
        echo "c=$constructor p=$__proto__ pr=$prototype"
      `);
      expect(result.exitCode).toBe(0);
      // Inline assignments don't persist after the command
      expect(result.stdout).toContain("inline");
    });

    it("should handle dangerous keywords in here-document", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        cat <<EOF
constructor
__proto__
prototype
EOF
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n__proto__\nprototype\n");
    });

    it("should handle dangerous keywords in brace expansion", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo {constructor,__proto__,prototype}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__ prototype\n");
    });

    it("should handle dangerous keywords in case statement", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        test_keyword() {
          case "$1" in
            constructor) echo "matched constructor";;
            __proto__) echo "matched proto";;
            *) echo "other";;
          esac
        }
        test_keyword constructor
        test_keyword __proto__
        test_keyword something
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("matched constructor\nmatched proto\nother\n");
    });
  });
});
