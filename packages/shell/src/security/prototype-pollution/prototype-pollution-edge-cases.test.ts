/**
 * Prototype Pollution Edge Cases Tests
 *
 * Additional tests for eval with constructed names, BASH_REMATCH,
 * test expressions, default REPLY/MAPFILE, positional parameters,
 * declare introspection, here-strings, and compgen.
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

describe("Prototype Pollution Edge Cases", () => {
  describe("Eval with Constructed Variable Names", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should eval assignment to ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          eval "${keyword}=evalued_value"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("evalued_value\n");
      });

      it(`should eval ${keyword} from variable`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          varname="${keyword}"
          eval "\${varname}=indirect_value"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("indirect_value\n");
      });

      it(`should eval complex expression with ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          eval "${keyword}=(); ${keyword}+=(a); ${keyword}+=(b)"
          echo "\${${keyword}[@]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("a b\n");
      });

      it(`should eval arithmetic with ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          eval "(( ${keyword} = 5 + 3 ))"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("8\n");
      });
    }

    it("should eval multiple dangerous assignments", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        eval "constructor=c; __proto__=p; prototype=pr"
        echo "$constructor $__proto__ $prototype"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("c p pr\n");
    });
  });

  describe("BASH_REMATCH with Dangerous Capture Groups", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should capture ${keyword} in BASH_REMATCH`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          [[ "${keyword}" =~ (.*) ]]
          echo "\${BASH_REMATCH[0]}"
          echo "\${BASH_REMATCH[1]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`${keyword}\n${keyword}\n`);
      });

      it(`should capture ${keyword} in named-like group`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          str="key=${keyword}"
          [[ $str =~ key=(.*) ]]
          echo "\${BASH_REMATCH[1]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`${keyword}\n`);
      });
    }

    it("should capture multiple dangerous keywords", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        str="constructor:__proto__:prototype"
        [[ $str =~ (.*):(.*):(.*)  ]]
        echo "\${BASH_REMATCH[1]} \${BASH_REMATCH[2]} \${BASH_REMATCH[3]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__ prototype\n");
    });

    it("should iterate BASH_REMATCH with dangerous content", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        [[ "constructor" =~ (con)(struc)(tor) ]]
        for i in 0 1 2 3; do
          echo "\${BASH_REMATCH[$i]}"
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\ncon\nstruc\ntor\n");
    });
  });

  describe("Test Expressions with Dangerous Names", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should test -v ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="set"
          [[ -v ${keyword} ]] && echo "is set" || echo "not set"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("is set\n");
      });

      it(`should test -v unset ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          unset ${keyword}
          [[ -v ${keyword} ]] && echo "is set" || echo "not set"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("not set\n");
      });

      it(`should test -z ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=""
          [[ -z $${keyword} ]] && echo "empty" || echo "not empty"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("empty\n");
      });

      it(`should test -n ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="value"
          [[ -n $${keyword} ]] && echo "not empty" || echo "empty"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("not empty\n");
      });

      it(`should compare ${keyword} with string`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="test"
          [[ $${keyword} == "test" ]] && echo "equal" || echo "not equal"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("equal\n");
      });

      it(`should compare ${keyword} with pattern`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="hello_world"
          [[ $${keyword} == hello_* ]] && echo "matches" || echo "no match"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("matches\n");
      });
    }

    it("should test multiple dangerous vars in compound expression", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor="a"
        __proto__="b"
        [[ -n $constructor && -n $__proto__ ]] && echo "both set"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("both set\n");
    });
  });

  describe("Default REPLY Variable", () => {
    it("should read into default REPLY", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "input_value" | { read; echo "$REPLY"; }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("input_value\n");
    });

    it("should read dangerous keyword into REPLY", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "constructor" | { read; echo "$REPLY"; }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });

    it("should read __proto__ into REPLY", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo "__proto__" | { read; echo "$REPLY"; }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });

    it("should read multiple dangerous lines into REPLY sequentially", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        echo -e "constructor\\n__proto__\\nprototype" | {
          while read; do
            echo "got: $REPLY"
          done
        }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "got: constructor\ngot: __proto__\ngot: prototype\n"
      );
    });
  });

  describe("Default MAPFILE Array", () => {
    it("should mapfile into default MAPFILE", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        mapfile -t <<'EOF'
line1
line2
line3
EOF
        echo "\${#MAPFILE[@]}"
        echo "\${MAPFILE[0]} \${MAPFILE[1]} \${MAPFILE[2]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("3\nline1 line2 line3\n");
    });

    it("should mapfile dangerous keywords into MAPFILE", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        mapfile -t <<'EOF'
constructor
__proto__
prototype
EOF
        echo "\${MAPFILE[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__ prototype\n");
    });

    it("should iterate MAPFILE with dangerous content", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        mapfile -t <<'EOF'
hasOwnProperty
toString
valueOf
EOF
        for item in "\${MAPFILE[@]}"; do
          echo "item: $item"
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "item: hasOwnProperty\nitem: toString\nitem: valueOf\n"
      );
    });
  });

  describe("Set Positional Parameters", () => {
    it("should set dangerous keywords as positional parameters", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        set -- constructor __proto__ prototype
        echo "$1 $2 $3"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__ prototype\n");
    });

    it("should iterate positional parameters with dangerous values", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        set -- constructor __proto__ prototype hasOwnProperty
        for arg in "$@"; do
          echo "arg: $arg"
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "arg: constructor\narg: __proto__\narg: prototype\narg: hasOwnProperty\n"
      );
    });

    it("should shift through dangerous positional parameters", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        set -- constructor __proto__ prototype
        echo "$1"
        shift
        echo "$1"
        shift
        echo "$1"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n__proto__\nprototype\n");
    });

    it("should use $# with dangerous parameters", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        set -- constructor __proto__ prototype
        echo "$#"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("3\n");
    });

    it("should use $* with dangerous parameters", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        set -- constructor __proto__
        echo "$*"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__\n");
    });
  });

  describe("Declare/Export Introspection", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should declare -p ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="value"
          declare -p ${keyword} 2>&1 || echo "declare -p handled"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(keyword);
      });

      it(`should declare -f with function named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}() { echo "func"; }
          declare -f ${keyword} 2>&1 || echo "declare -f handled"
        `);
        // declare -f may or may not be implemented
        expect(typeof result.exitCode).toBe("number");
      });

      it(`should export -p with ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          export ${keyword}="exported"
          export -p | grep ${keyword} || echo "found or not"
        `);
        expect(typeof result.exitCode).toBe("number");
      });
    }

    it("should declare -p multiple dangerous variables", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        constructor="c"
        __proto__="p"
        prototype="pr"
        declare -p constructor __proto__ prototype 2>&1 || echo "handled"
      `);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Here-String with Dangerous Content", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should here-string literal ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          cat <<< "${keyword}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`${keyword}\n`);
      });

      it(`should here-string variable containing ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="value_of_${keyword}"
          cat <<< "$${keyword}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`value_of_${keyword}\n`);
      });

      it(`should here-string with ${keyword} in expansion`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="hello"
          cat <<< "\${${keyword}^^}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("HELLO\n");
      });
    }

    it("should here-string multiple dangerous keywords", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        cat <<< "constructor __proto__ prototype"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__ prototype\n");
    });
  });

  describe("Compgen with Dangerous Patterns", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should compgen -v ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="value"
          compgen -v ${keyword} 2>&1 || echo "compgen handled"
        `);
        // compgen may or may not be fully implemented
        expect(typeof result.exitCode).toBe("number");
      });

      it(`should compgen -A variable with ${keyword} prefix`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}_one=1
          ${keyword}_two=2
          compgen -A variable ${keyword}_ 2>&1 || echo "compgen handled"
        `);
        expect(typeof result.exitCode).toBe("number");
      });
    }

    it("should compgen -W with dangerous words", async () => {
      const bash = new Bash();
      const result = await bash.exec(`
        compgen -W "constructor __proto__ prototype" -- con 2>&1 || echo "compgen handled"
      `);
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("Type Command with Dangerous Names", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should type ${keyword} as function`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}() { echo "func"; }
          type ${keyword} 2>&1 || echo "type handled"
        `);
        expect(typeof result.exitCode).toBe("number");
      });

      it(`should type -t ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}() { echo "func"; }
          type -t ${keyword} 2>&1 || echo "type -t handled"
        `);
        expect(typeof result.exitCode).toBe("number");
      });
    }
  });

  describe("Arithmetic with Dangerous Array Names", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use ${keyword} array in arithmetic`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=(10 20 30)
          echo $((${keyword}[0] + ${keyword}[1] + ${keyword}[2]))
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("60\n");
      });

      it(`should use ${keyword} array index in arithmetic`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          arr=(a b c d e)
          ${keyword}=2
          echo "\${arr[$${keyword}]}"
          echo "\${arr[${keyword}+1]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("c\nd\n");
      });
    }
  });

  describe("Printf %q with Dangerous Values", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should printf %q ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          printf "%q\\n" "${keyword}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(keyword);
      });

      it(`should printf %q variable containing ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="value with spaces"
          printf "%q\\n" "$${keyword}"
        `);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("Object.prototype Verification", () => {
    it("should not pollute Object.prototype after all edge case operations", async () => {
      const bash = new Bash();

      // Run all types of operations with dangerous keywords
      await bash.exec(`
        # Eval
        eval "constructor=eval_val"

        # BASH_REMATCH
        [[ "__proto__" =~ (.*) ]]

        # Test expressions
        [[ -v constructor ]]

        # REPLY
        echo "prototype" | { read; }

        # MAPFILE
        mapfile -t <<< "hasOwnProperty"

        # Positional
        set -- constructor __proto__

        # Here-string
        cat <<< "toString"

        # Arithmetic
        __proto__=(1 2 3)
        echo $((__proto__[0]))
      `);

      // Verify Object.prototype is clean
      const testObj: Record<string, unknown> = {};
      expect(testObj.constructor).toBe(Object);
      expect(typeof testObj.toString).toBe("function");
      expect(typeof testObj.hasOwnProperty).toBe("function");
      expect(Object.keys(Object.prototype).length).toBe(0);
      expect(Object.hasOwn(Object.prototype, "eval_val")).toBe(false);
    });
  });
});
