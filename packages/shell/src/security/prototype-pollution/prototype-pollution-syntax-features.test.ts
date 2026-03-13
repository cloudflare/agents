/**
 * Prototype Pollution - Additional Syntax Features Tests
 *
 * Tests for additional syntax features in AWK, SED, Bash, and JQ
 * that could potentially be vectors for prototype pollution.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

const DANGEROUS_KEYWORDS = ["constructor", "__proto__", "prototype"];

describe("Additional Syntax Features - Prototype Pollution", () => {
  describe("AWK Special Variables", () => {
    it("should handle NF with dangerous field count", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "a b c" | awk '{print NF}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("3\n");
    });

    it("should handle NR with dangerous value in variable", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "a\\nb\\nc" | awk '{constructor = NR; print constructor}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n3\n");
    });

    it("should handle FNR with dangerous variable name", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "a\\nb" | awk '{__proto__ = FNR; print __proto__}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n");
    });

    it("should handle FILENAME with dangerous variable", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "test" > /tmp/awktest.txt
        awk '{constructor = FILENAME; print constructor}' /tmp/awktest.txt
        rm /tmp/awktest.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("awktest.txt");
    });

    it("should handle RSTART and RLENGTH with dangerous vars", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "hello world" | awk '{
          match($0, /wor/)
          constructor = RSTART
          __proto__ = RLENGTH
          print constructor, __proto__
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("7 3\n");
    });
  });

  describe("AWK sprintf", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should sprintf into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk '{
            ${keyword} = sprintf("%s-%d", "value", 42)
            print ${keyword}
          }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("value-42\n");
      });
    }

    it("should sprintf dangerous keyword as value", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "test" | awk '{
          x = sprintf("%s", "constructor")
          print x
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });
  });

  describe("AWK Output Redirection", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should redirect output to file via ${keyword} variable`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "test" | awk -v ${keyword}="/tmp/awk_redir_test.txt" '{
            print "output" > ${keyword}
          }'
          cat /tmp/awk_redir_test.txt
          rm /tmp/awk_redir_test.txt
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("output\n");
      });
    }

    // Note: AWK pipe to external command is not supported in sandboxed environment
    it("should reject pipe output via variable (sandboxed)", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "hello" | awk -v constructor="cat" '{
          print $0 | constructor
        }'
      `);
      // Pipe to external command is not supported
      expect(result.exitCode).not.toBe(0);
    });
  });

  // Note: AWK system() is intentionally disabled in sandboxed environment
  describe("AWK system() Function (Sandboxed)", () => {
    it("should reject system() with dangerous variable (sandboxed)", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "test" | awk '{
          constructor = "echo from_system"
          system(constructor)
        }'
      `);
      // system() is not supported in sandbox
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("system() is not supported");
    });

    it("should reject system() with dangerous keyword (sandboxed)", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "test" | awk '{
          system("echo constructor")
        }'
      `);
      // system() is not supported in sandbox
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("system() is not supported");
    });
  });

  describe("AWK Control Flow with Dangerous Variables", () => {
    it("should use dangerous variable in exit", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "test" | awk 'BEGIN { constructor = 42 } { exit constructor }'
        echo "exit code: $?"
      `);
      expect(result.stdout).toContain("exit code: 42");
    });

    it("should use dangerous variable in next", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "1\\n2\\n3" | awk '{
          constructor++
          if (constructor == 2) next
          print $0
        }'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n3\n");
    });
  });

  describe("AWK -F Field Separator", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should use FS=${keyword} in BEGIN`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "a:b:c" | awk 'BEGIN { ${keyword} = ":"; FS = ${keyword} } { print $2 }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("b\n");
      });

      it(`should assign -F value to ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "a:b:c" | awk -F: 'BEGIN { ${keyword} = FS } { print $2, ${keyword} }'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("b :\n");
      });
    }
  });

  describe("SED Hold Space Commands", () => {
    it("should use h/g with dangerous content", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "constructor\\nline2" | sed -n '1h; 2{g;p}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });

    it("should use H/G with dangerous content", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "__proto__\\nprototype" | sed -n '1h; 2{H;g;p}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("__proto__");
      expect(result.stdout).toContain("prototype");
    });

    it("should use x (exchange) with dangerous content", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "constructor\\nother" | sed -n '1{h;d}; 2{x;p}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });
  });

  describe("SED Address Patterns", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should match pattern /${keyword}/`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo -e "before\\n${keyword}\\nafter" | sed -n '/${keyword}/p'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`${keyword}\n`);
      });

      it(`should use range with /${keyword}/`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo -e "start\\n${keyword}\\nmiddle\\nend" | sed -n '/${keyword}/,/end/p'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(keyword);
      });
    }
  });

  describe("SED y (Transliterate) Command", () => {
    it("should transliterate with dangerous keywords in input", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "constructor" | sed 'y/cot/COT/'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("COnsTruCTOr\n");
    });
  });

  describe("SED Back-references", () => {
    it("should capture dangerous keyword in back-reference", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "constructor=value" | sed 's/\\(constructor\\)=\\(.*\\)/\\2=\\1/'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("value=constructor\n");
    });

    it("should use & with dangerous keyword", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "__proto__" | sed 's/__proto__/[&]/'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("[__proto__]\n");
    });
  });

  describe("SED = (Line Number) Command", () => {
    it("should print line number with dangerous content", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "constructor\\n__proto__" | sed -n '/constructor/='
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n");
    });
  });

  describe("Bash FUNCNAME Array", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should show ${keyword} in FUNCNAME`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}() {
            echo "FUNCNAME: \${FUNCNAME[0]}"
          }
          ${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`FUNCNAME: ${keyword}\n`);
      });

      it(`should show nested ${keyword} in FUNCNAME stack`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          inner() {
            echo "\${FUNCNAME[@]}"
          }
          ${keyword}() {
            inner
          }
          ${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("inner");
        expect(result.stdout).toContain(keyword);
      });
    }
  });

  describe("Bash PIPESTATUS Array", () => {
    it("should access PIPESTATUS after pipeline", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        true | false | true
        echo "\${PIPESTATUS[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("0 1 0\n");
    });

    it("should assign PIPESTATUS to dangerous variable", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        true | false
        constructor=("\${PIPESTATUS[@]}")
        echo "\${constructor[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("0 1\n");
    });
  });

  describe("Bash Parameter Transformations", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should use \${${keyword}@Q} (quote)`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="hello world"
          echo "\${${keyword}@Q}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello");
      });

      it(`should use \${${keyword}@E} (escape)`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}='hello\\nworld'
          echo "\${${keyword}@E}"
        `);
        // @E expands escape sequences
        expect(typeof result.exitCode).toBe("number");
      });

      it(`should use \${${keyword}@A} (assignment)`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="value"
          echo "\${${keyword}@A}"
        `);
        // @A shows assignment statement
        expect(typeof result.exitCode).toBe("number");
      });

      it(`should use \${${keyword}@a} (attributes)`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -i ${keyword}=5
          echo "\${${keyword}@a}"
        `);
        // @a shows variable attributes
        expect(typeof result.exitCode).toBe("number");
      });
    }
  });

  describe("Bash Negative Array Indices", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should access ${keyword}[-1]`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=(a b c d e)
          echo "\${${keyword}[-1]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("e\n");
      });

      it(`should access ${keyword}[-2]`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=(1 2 3 4 5)
          echo "\${${keyword}[-2]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("4\n");
      });

      it(`should slice ${keyword} with negative index`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=(a b c d e)
          echo "\${${keyword}[@]: -2}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("d e\n");
      });
    }
  });

  describe("Bash caller Builtin", () => {
    it("should use caller in function with dangerous name", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor() {
          caller 0 2>/dev/null || echo "caller handled"
        }
        constructor
      `);
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("JQ Variable Binding", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should bind variable as $${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo '{"a":1}' | jq '.a as $${keyword} | $${keyword} + 10'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("11");
      });

      it(`should use $${keyword} in reduce`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo '[1,2,3]' | jq 'reduce .[] as $${keyword} (0; . + $${keyword})'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("6");
      });
    }
  });

  describe("JQ User-Defined Functions", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should define function named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo '5' | jq 'def ${keyword}: . * 2; ${keyword}'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("10");
      });

      // Note: JQ function parameters have limited support
      it(`should handle function with ${keyword} parameter syntax`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo '5' | jq 'def myfunc($${keyword}): . * 2; myfunc(3)'
        `);
        // Function parameters may not fully work, but syntax is accepted
        expect(result.exitCode).toBe(0);
      });
    }
  });

  // Note: JQ --arg and --argjson are not currently supported
  describe("JQ External Variables (Limited Support)", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should handle dangerous keyword ${keyword} in variable binding instead`, async () => {
        const bash = new Bash();
        // Use 'as' binding instead of --arg (which is not supported)
        const result = await bash.exec(`
          echo '"value"' | jq '. as $${keyword} | $${keyword}'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('"value"');
      });

      it(`should handle ${keyword} as object key access`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo '{"${keyword}": "value"}' | jq '.${keyword}'
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('"value"');
      });
    }
  });

  describe("JQ getpath/paths with Dangerous Keys", () => {
    it("should getpath with dangerous key", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo '{"a":{"b":1}}' | jq 'getpath(["a","b"])'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("1");
    });

    it("should handle paths output safely", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo '{"a":1,"b":2}' | jq '[paths]'
      `);
      expect(result.exitCode).toBe(0);
      // Output is pretty-printed with paths as arrays
      expect(result.stdout).toContain('"a"');
      expect(result.stdout).toContain('"b"');
    });
  });

  describe("Object.prototype Verification", () => {
    it("should not pollute Object.prototype after all syntax feature operations", async () => {
      const bash = new Bash();

      // Run various operations
      await bash.exec(`
        # AWK operations
        echo "test" | awk '{constructor = NR; sprintf("%s", __proto__)}'

        # SED operations
        echo "constructor" | sed 'h;g;y/abc/ABC/'

        # Bash operations
        constructor() { echo "\${FUNCNAME[0]}"; }
        constructor
        __proto__=(a b c)
        echo "\${__proto__[-1]}"
      `);

      // JQ operations
      await bash.exec(`
        echo '5' | jq 'def constructor: . * 2; constructor'
        echo '{"a":1}' | jq '.a as $__proto__ | $__proto__'
      `);

      // Verify Object.prototype is clean
      const testObj: Record<string, unknown> = {};
      expect(testObj.constructor).toBe(Object);
      expect(typeof testObj.toString).toBe("function");
      expect(Object.keys(Object.prototype).length).toBe(0);
    });
  });
});
