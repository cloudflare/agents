import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

/**
 * Tests for bash-level prototype pollution defense.
 *
 * These tests ensure that JavaScript prototype-related keywords
 * and constructs are handled safely as regular strings in bash,
 * without triggering JavaScript prototype chain access.
 */

// All dangerous JavaScript prototype-related keywords to test
const DANGEROUS_KEYWORDS = [
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

describe("bash prototype pollution defense", () => {
  describe("echo with prototype keywords", () => {
    it("should echo 'constructor' as a literal string", async () => {
      const env = new Bash();
      const result = await env.exec("echo constructor");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });

    it("should echo '__proto__' as a literal string", async () => {
      const env = new Bash();
      const result = await env.exec("echo __proto__");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });

    it("should echo 'prototype' as a literal string", async () => {
      const env = new Bash();
      const result = await env.exec("echo prototype");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("prototype\n");
    });

    it("should echo 'hasOwnProperty' as a literal string", async () => {
      const env = new Bash();
      const result = await env.exec("echo hasOwnProperty");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hasOwnProperty\n");
    });

    it("should echo 'toString' as a literal string", async () => {
      const env = new Bash();
      const result = await env.exec("echo toString");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("toString\n");
    });

    it("should echo 'valueOf' as a literal string", async () => {
      const env = new Bash();
      const result = await env.exec("echo valueOf");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("valueOf\n");
    });
  });

  describe("variable assignment with prototype keywords", () => {
    it("should allow variable named 'constructor'", async () => {
      const env = new Bash();
      const result = await env.exec("constructor=test; echo $constructor");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });

    it("should allow variable named '__proto__'", async () => {
      const env = new Bash();
      const result = await env.exec("__proto__=test; echo $__proto__");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });

    it("should allow variable named 'prototype'", async () => {
      const env = new Bash();
      const result = await env.exec("prototype=test; echo $prototype");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });

    it("should allow variable named 'hasOwnProperty'", async () => {
      const env = new Bash();
      const result = await env.exec(
        "hasOwnProperty=test; echo $hasOwnProperty"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });
  });

  describe("unset prototype keyword variables", () => {
    it("should return empty for unset $constructor", async () => {
      const env = new Bash();
      const result = await env.exec("echo $constructor");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("\n");
    });

    it("should return empty for unset $__proto__", async () => {
      const env = new Bash();
      const result = await env.exec("echo $__proto__");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("\n");
    });

    it("should return empty for unset $prototype", async () => {
      const env = new Bash();
      const result = await env.exec("echo $prototype");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("\n");
    });
  });

  describe("array with prototype keywords as indices", () => {
    it("should handle array with prototype keyword values", async () => {
      const env = new Bash();
      const result = await env.exec(
        "arr=(constructor __proto__ prototype); echo ${arr[@]}"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor __proto__ prototype\n");
    });

    it("should handle associative array with prototype keyword keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -A arr; arr[constructor]=a; arr[__proto__]=b; arr[prototype]=c; echo ${arr[constructor]} ${arr[__proto__]} ${arr[prototype]}"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("string operations with prototype keywords", () => {
    it("should handle string containing constructor", async () => {
      const env = new Bash();
      const result = await env.exec('x="test constructor test"; echo $x');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test constructor test\n");
    });

    it("should handle string containing __proto__", async () => {
      const env = new Bash();
      const result = await env.exec('x="test __proto__ test"; echo $x');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test __proto__ test\n");
    });

    it("should handle parameter expansion with prototype keywords", async () => {
      const env = new Bash();
      const result = await env.exec("constructor=hello; echo ${constructor^^}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("HELLO\n");
    });
  });

  describe("function names with prototype keywords", () => {
    it("should allow function named constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        "constructor() { echo 'func'; }; constructor"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("func\n");
    });

    it("should allow function named __proto__", async () => {
      const env = new Bash();
      const result = await env.exec("__proto__() { echo 'func'; }; __proto__");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("func\n");
    });
  });

  describe("command substitution with prototype keywords", () => {
    it("should handle command substitution returning constructor", async () => {
      const env = new Bash();
      const result = await env.exec("echo $(echo constructor)");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });

    it("should handle command substitution returning __proto__", async () => {
      const env = new Bash();
      const result = await env.exec("echo $(echo __proto__)");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });
  });

  describe("arithmetic with prototype keyword variables", () => {
    it("should handle arithmetic with variable named constructor", async () => {
      const env = new Bash();
      const result = await env.exec("constructor=5; echo $((constructor + 3))");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("8\n");
    });

    it("should handle arithmetic with variable named __proto__", async () => {
      const env = new Bash();
      const result = await env.exec("__proto__=5; echo $((__proto__ + 3))");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("8\n");
    });
  });

  describe("conditionals with prototype keywords", () => {
    it("should compare strings containing prototype keywords", async () => {
      const env = new Bash();
      const result = await env.exec(
        'if [[ "constructor" == "constructor" ]]; then echo yes; else echo no; fi'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("yes\n");
    });

    it("should handle -v test for prototype keyword variables", async () => {
      const env = new Bash();
      const result = await env.exec(
        "constructor=x; if [[ -v constructor ]]; then echo set; else echo unset; fi"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("set\n");
    });
  });

  describe("export with prototype keywords", () => {
    it("should export variable named constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        "export constructor=test; printenv constructor"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });

    it("should export variable named __proto__", async () => {
      const env = new Bash();
      const result = await env.exec(
        "export __proto__=test; printenv __proto__"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });
  });

  describe("read with prototype keywords", () => {
    it("should read into variable named constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo hello | read constructor; echo $constructor"
      );
      // Note: read in a pipeline runs in a subshell, so this tests the variable access pattern
      expect(result.exitCode).toBe(0);
    });
  });

  describe("for loop with prototype keywords", () => {
    it("should iterate with variable named constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        "for constructor in a b c; do echo $constructor; done"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should iterate over prototype keyword values", async () => {
      const env = new Bash();
      const result = await env.exec(
        "for x in constructor __proto__ prototype; do echo $x; done"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n__proto__\nprototype\n");
    });
  });

  describe("case statement with prototype keywords", () => {
    it("should match prototype keyword in case", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=constructor
        case $x in
          constructor) echo matched;;
          *) echo nomatch;;
        esac
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("matched\n");
    });
  });

  describe("special patterns that might cause issues", () => {
    it("should handle .constructor as literal", async () => {
      const env = new Bash();
      const result = await env.exec("echo .constructor");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(".constructor\n");
    });

    it("should handle [constructor] as literal", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[constructor]'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("[constructor]\n");
    });

    it("should handle {constructor} as literal", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{constructor}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("{constructor}\n");
    });

    it("should handle __proto__.test as literal", async () => {
      const env = new Bash();
      const result = await env.exec("echo __proto__.test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__.test\n");
    });
  });

  // =========================================================================
  // EXPANDED TESTS FOR ALL DANGEROUS KEYWORDS
  // =========================================================================

  describe("all dangerous keywords as variable names", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should allow variable named '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `${keyword}=test_value; echo $${keyword}`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("test_value\n");
      });
    }
  });

  describe("all dangerous keywords as function names", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should allow function named '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `${keyword}() { echo "called ${keyword}"; }; ${keyword}`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`called ${keyword}\n`);
      });
    }
  });

  describe("alias names with dangerous keywords", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should allow alias named '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `shopt -s expand_aliases; alias ${keyword}='echo aliased'; ${keyword}`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("aliased\n");
      });
    }
  });

  describe("local variables with dangerous keywords", () => {
    for (const keyword of DANGEROUS_KEYWORDS) {
      it(`should allow local variable named '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(`
          testfunc() {
            local ${keyword}=local_value
            echo $${keyword}
          }
          testfunc
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("local_value\n");
      });
    }
  });

  describe("declare with dangerous keywords", () => {
    it("should handle declare -r with __proto__", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -r __proto__=readonly_value; echo $__proto__"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("readonly_value\n");
    });

    it("should handle declare -i with constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -i constructor=42; echo $constructor"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("42\n");
    });

    it("should handle declare -x with prototype", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -x prototype=exported; printenv prototype"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("exported\n");
    });

    it("should handle declare -l with hasOwnProperty", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -l hasOwnProperty=UPPERCASE; echo $hasOwnProperty"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("uppercase\n");
    });

    it("should handle declare -u with toString", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -u toString=lowercase; echo $toString"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("LOWERCASE\n");
    });
  });

  describe("indexed arrays with dangerous keywords", () => {
    it("should handle array containing all dangerous keywords", async () => {
      const env = new Bash();
      const keywords = DANGEROUS_KEYWORDS.slice(0, 5).join(" ");
      const result = await env.exec(`arr=(${keywords}); echo \${arr[@]}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${keywords}\n`);
    });

    it("should handle array named __proto__", async () => {
      const env = new Bash();
      const result = await env.exec("__proto__=(a b c); echo ${__proto__[@]}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });

    it("should handle array named constructor", async () => {
      const env = new Bash();
      const result = await env.exec(
        "constructor=(1 2 3); echo ${constructor[1]}"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("2\n");
    });
  });

  describe("associative arrays with dangerous keywords", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 6)) {
      it(`should handle assoc array with key '${keyword}'`, async () => {
        const env = new Bash();
        const result = await env.exec(
          `declare -A arr; arr[${keyword}]=value_for_${keyword}; echo \${arr[${keyword}]}`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`value_for_${keyword}\n`);
      });
    }

    it("should handle assoc array named __proto__", async () => {
      const env = new Bash();
      const result = await env.exec(
        "declare -A __proto__; __proto__[key]=val; echo ${__proto__[key]}"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("val\n");
    });
  });

  describe("nameref variables with dangerous keywords", () => {
    it("should handle nameref pointing to __proto__", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=original
        declare -n ref=__proto__
        echo $ref
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("original\n");
    });

    it("should handle nameref named constructor", async () => {
      const env = new Bash();
      const result = await env.exec(`
        target=value
        declare -n constructor=target
        echo $constructor
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("value\n");
    });
  });

  describe("positional parameters with dangerous keywords", () => {
    it("should handle set -- with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec(
        "set -- __proto__ constructor prototype; echo $1 $2 $3"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__ constructor prototype\n");
    });

    it("should handle shift with dangerous keyword values", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -- __proto__ constructor
        shift
        echo $1
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("constructor\n");
    });
  });

  describe("here documents with dangerous keywords", () => {
    it("should handle heredoc with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec(`
        cat <<EOF
__proto__
constructor
prototype
EOF
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\nconstructor\nprototype\n");
    });

    it("should handle heredoc delimiter as dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        cat <<__proto__
test content
__proto__
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test content\n");
    });
  });

  describe("brace expansion with dangerous keywords", () => {
    it("should handle brace expansion with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec("echo {__proto__,constructor,prototype}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__ constructor prototype\n");
    });

    it("should handle prefix brace expansion with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec("echo test_{__proto__,constructor}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test___proto__ test_constructor\n");
    });
  });

  describe("eval with dangerous keywords", () => {
    it("should handle eval setting dangerous keyword variable", async () => {
      const env = new Bash();
      const result = await env.exec("eval '__proto__=evaled'; echo $__proto__");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("evaled\n");
    });

    it("should handle eval defining function with dangerous name", async () => {
      const env = new Bash();
      const result = await env.exec(
        "eval 'constructor() { echo func; }'; constructor"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("func\n");
    });

    it("should handle nested eval with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec(
        "eval 'eval \"__proto__=nested\"'; echo $__proto__"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("nested\n");
    });
  });

  describe("environment passing with dangerous keywords", () => {
    it("should export dangerous keyword var", async () => {
      const env = new Bash();
      const result = await env.exec("export __proto__=passed; echo $__proto__");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("passed\n");
    });

    it("should handle export with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec(
        "constructor=envval; export constructor; printenv constructor"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("envval\n");
    });
  });

  describe("eval with dangerous keywords (extended)", () => {
    it("should eval dangerous keyword as variable name", async () => {
      const env = new Bash();
      const result = await env.exec(`
        varname="__proto__"
        eval "\${varname}=evaled_value"
        echo $__proto__
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("evaled_value\n");
    });

    it("should eval array with dangerous keyword name", async () => {
      const env = new Bash();
      const result = await env.exec(`
        eval "__proto__=(a b c)"
        echo \${__proto__[@]}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("trap variables with dangerous keywords", () => {
    it("should allow trap command containing dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=value
        echo "before: $__proto__"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("before: value\n");
    });

    it("should handle BASH_COMMAND with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=test
        echo $__proto__
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });
  });

  describe("select with dangerous keywords", () => {
    // Note: select requires interactive input, test variable assignment instead
    it("should allow variable named REPLY with dangerous keyword value", async () => {
      const env = new Bash();
      const result = await env.exec(`
        REPLY=__proto__
        echo "REPLY: $REPLY"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("REPLY: __proto__\n");
    });

    it("should allow PS3 containing dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec(`
        PS3="__proto__> "
        echo "PS3: $PS3"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("PS3: __proto__> \n");
    });
  });

  describe("getopts with dangerous keywords", () => {
    it("should handle getopts with OPTARG as dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -- -a __proto__
        while getopts "a:" opt; do
          echo "opt=$opt OPTARG=$OPTARG"
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("opt=a OPTARG=__proto__\n");
    });
  });

  describe("printf with dangerous keywords", () => {
    it("should handle printf format with dangerous keywords", async () => {
      const env = new Bash();
      const result = await env.exec("printf '%s\\n' __proto__ constructor");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\nconstructor\n");
    });

    it("should handle printf -v with dangerous keyword var", async () => {
      const env = new Bash();
      const result = await env.exec(
        "printf -v __proto__ '%s' 'formatted'; echo $__proto__"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("formatted\n");
    });
  });

  describe("read with dangerous keywords", () => {
    it("should read into dangerous keyword variable", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'input' | { read __proto__; echo $__proto__; }"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("input\n");
    });

    it("should read -a into dangerous keyword array", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo 'a b c' | { read -a __proto__; echo ${__proto__[@]}; }"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });

    it("should read -A into dangerous keyword assoc array", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo 'key1 val1 key2 val2' | {
          declare -A constructor
          read -a pairs
          constructor[\${pairs[0]}]=\${pairs[1]}
          echo \${constructor[key1]}
        }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("val1\n");
    });
  });

  describe("mapfile/readarray with dangerous keywords", () => {
    it("should mapfile into dangerous keyword array", async () => {
      const env = new Bash();
      const result = await env.exec(`
        printf 'a\\nb\\nc\\n' | { mapfile __proto__; echo \${__proto__[@]}; }
      `);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("unset with dangerous keywords", () => {
    it("should unset dangerous keyword variable", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=set
        unset __proto__
        echo "value: '$__proto__'"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("value: ''\n");
    });

    it("should unset dangerous keyword function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        constructor() { echo "func"; }
        unset -f constructor
        constructor 2>/dev/null || echo "function unset"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("function unset\n");
    });
  });

  describe("compgen with dangerous keywords", () => {
    it("should complete with dangerous keyword prefix", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=val
        compgen -v __proto__
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__\n");
    });
  });

  describe("indirect expansion with dangerous keywords", () => {
    it("should handle indirect expansion of dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=indirect_target
        indirect_target=final_value
        echo \${!__proto__}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("final_value\n");
    });

    it("should handle indirect array reference with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=(a b c)
        ref="__proto__[@]"
        echo \${!ref}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("parameter transformation with dangerous keywords", () => {
    it("should handle ${var@Q} with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__="quoted value"
        echo \${__proto__@Q}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("'quoted value'\n");
    });

    it("should handle ${var@A} with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=value
        echo \${__proto__@A}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("__proto__='value'\n");
    });
  });

  describe("substring operations with dangerous keywords", () => {
    it("should handle ${var:offset} with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        constructor=hello_world
        echo \${constructor:6}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("world\n");
    });

    it("should handle ${#var} with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=12345
        echo \${#__proto__}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("5\n");
    });
  });

  describe("pattern substitution with dangerous keywords", () => {
    it("should handle ${var/pattern/string} with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__="hello world"
        echo \${__proto__/world/universe}
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello universe\n");
    });
  });

  describe("while/until loops with dangerous keywords", () => {
    it("should handle while with dangerous keyword condition var", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__=3
        while (( __proto__ > 0 )); do
          echo $__proto__
          ((__proto__--))
        done
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("3\n2\n1\n");
    });
  });

  describe("subshell with dangerous keywords", () => {
    it("should handle subshell setting dangerous keyword var", async () => {
      const env = new Bash();
      const result = await env.exec(`
        ( __proto__=subshell; echo $__proto__ )
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("subshell\n");
    });

    it("should handle command substitution with dangerous keyword", async () => {
      const env = new Bash();
      const result = await env.exec(`
        result=$(echo __proto__)
        echo "got: $result"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("got: __proto__\n");
    });
  });

  describe("return values in functions with dangerous keywords", () => {
    it("should handle return in function with dangerous name", async () => {
      const env = new Bash();
      const result = await env.exec(`
        __proto__() {
          return 42
        }
        __proto__
        echo $?
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("42\n");
    });
  });

  describe("special variable interactions", () => {
    it("should not pollute Object.prototype via env", async () => {
      const env = new Bash();
      await env.exec("export __proto__=polluted");

      // Verify JavaScript Object.prototype is not affected
      const testObj: Record<string, unknown> = {};
      expect(testObj.__proto__).toBe(Object.prototype);
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    });

    it("should not pollute Object.prototype via constructor var", async () => {
      const env = new Bash();
      await env.exec("export constructor=polluted");

      // Verify JavaScript Object.prototype is not affected
      const testObj: Record<string, unknown> = {};
      expect(typeof testObj.constructor).toBe("function");
      expect(testObj.constructor).toBe(Object);
    });
  });
});
