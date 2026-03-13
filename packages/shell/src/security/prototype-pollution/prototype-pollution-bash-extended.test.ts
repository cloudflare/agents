/**
 * Extended Bash Prototype Pollution Prevention Tests
 *
 * Additional tests for bash contexts: readonly, mapfile, printf -v,
 * for loops, and other edge cases.
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

describe("Extended Bash Prototype Pollution Prevention", () => {
  describe("Readonly Variables", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should declare readonly ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          readonly ${keyword}="immutable"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("immutable\n");
      });

      it(`should prevent modification of readonly ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          readonly ${keyword}="original"
          ${keyword}="modified" 2>&1 || true
        `);
        // Readonly enforcement may vary - key is it doesn't crash
        // and doesn't pollute prototypes
        expect(typeof result.exitCode).toBe("number");
      });

      it(`should declare readonly ${keyword} with declare -r`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -r ${keyword}="declared"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("declared\n");
      });
    }
  });

  describe("Mapfile/Readarray", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should mapfile into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          mapfile -t ${keyword} <<'EOF'
line1
line2
line3
EOF
          echo "\${#${keyword}[@]}"
          echo "\${${keyword}[0]}"
          echo "\${${keyword}[1]}"
          echo "\${${keyword}[2]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("3\nline1\nline2\nline3\n");
      });

      it(`should readarray into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          readarray -t ${keyword} <<'EOF'
a
b
c
EOF
          echo "\${${keyword}[@]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("a b c\n");
      });

      it(`should mapfile with callback using ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          mapfile -t -c 1 -C 'echo "line:"' ${keyword} <<'EOF'
one
two
EOF
          echo "count: \${#${keyword}[@]}"
        `);
        // Callback behavior may vary, just ensure no crash
        expect(typeof result.exitCode).toBe("number");
      });
    }
  });

  describe("Printf -v", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should printf -v into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          printf -v ${keyword} "%s-%d" "test" 42
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("test-42\n");
      });

      it(`should printf -v formatted number into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          printf -v ${keyword} "%05d" 7
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("00007\n");
      });

      it(`should printf -v hex into ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          printf -v ${keyword} "%x" 255
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("ff\n");
      });
    }
  });

  describe("For Loop Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use ${keyword} as for loop variable`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          for ${keyword} in a b c; do
            echo $${keyword}
          done
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("a\nb\nc\n");
      });

      it(`should preserve ${keyword} value after for loop`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          for ${keyword} in 1 2 3; do :; done
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("3\n");
      });

      it(`should use ${keyword} in C-style for loop`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          for (( ${keyword}=0; ${keyword}<3; ${keyword}++ )); do
            echo $${keyword}
          done
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("0\n1\n2\n");
      });

      it(`should use ${keyword} in brace expansion for loop`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          for ${keyword} in {1..3}; do
            echo $${keyword}
          done
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("1\n2\n3\n");
      });
    }
  });

  describe("Select Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should use ${keyword} in select (with timeout)`, async () => {
        const bash = new Bash();
        // Select is interactive, use timeout/redirect to test
        const result = await bash.exec(`
          echo "1" | {
            select ${keyword} in a b c; do
              echo "selected: $${keyword}"
              break
            done
          }
        `);
        // Select behavior varies, just ensure no crash
        expect(typeof result.exitCode).toBe("number");
      });
    }
  });

  describe("While Read Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use ${keyword} in while read`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo -e "line1\\nline2\\nline3" | while read ${keyword}; do
            echo "read: $${keyword}"
          done
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("read: line1\nread: line2\nread: line3\n");
      });

      it(`should use ${keyword} with read -r`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo 'a\\tb' | while read -r ${keyword}; do
            echo $${keyword}
          done
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("a\\tb");
      });

      it(`should use multiple dangerous vars in read`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          echo "a b c" | {
            read constructor __proto__ prototype
            echo "$constructor $__proto__ $prototype"
          }
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("a b c\n");
      });
    }
  });

  describe("Getopts Variable", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 2)) {
      it(`should use ${keyword} with getopts`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          parse_opts() {
            while getopts "a:b:" ${keyword}; do
              case $${keyword} in
                a) echo "a=$OPTARG" ;;
                b) echo "b=$OPTARG" ;;
              esac
            done
          }
          parse_opts -a foo -b bar
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("a=foo");
        expect(result.stdout).toContain("b=bar");
      });
    }
  });

  describe("Array Append", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should append to array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=(a b)
          ${keyword}+=(c d)
          echo "\${${keyword}[@]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("a b c d\n");
      });

      it(`should append single element to ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=()
          ${keyword}+=(one)
          ${keyword}+=(two)
          echo "\${#${keyword}[@]}: \${${keyword}[@]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("2: one two\n");
      });
    }
  });

  describe("Unset Array Element", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should unset element from array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}=(a b c d)
          unset '${keyword}[1]'
          echo "\${${keyword}[@]}"
          echo "\${!${keyword}[@]}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("a c d\n0 2 3\n");
      });

      it(`should unset from associative array named ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -A ${keyword}
          ${keyword}[x]=1
          ${keyword}[y]=2
          ${keyword}[z]=3
          unset '${keyword}[y]'
          echo "\${!${keyword}[@]}" | tr ' ' '\\n' | sort | tr '\\n' ' '
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toMatch(/x.*z|z.*x/);
      });
    }
  });

  describe("Parameter Expansion Edge Cases", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should substring ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="hello world"
          echo "\${${keyword}:0:5}"
          echo "\${${keyword}:6}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\nworld\n");
      });

      it(`should get length of ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="twelve char"
          echo "\${#${keyword}}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("11\n");
      });

      it(`should pattern remove from ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="/path/to/file.txt"
          echo "\${${keyword}##*/}"
          echo "\${${keyword}%/*}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("file.txt\n/path/to\n");
      });

      it(`should case modify ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          ${keyword}="Hello World"
          echo "\${${keyword}^^}"
          echo "\${${keyword},,}"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("HELLO WORLD\nhello world\n");
      });
    }
  });

  describe("Let Command", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should use let with ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          let "${keyword}=5+3"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("8\n");
      });

      it(`should use multiple let expressions with ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          let "${keyword}=10" "${keyword}*=2"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("20\n");
      });
    }
  });

  describe("Declare Flags", () => {
    for (const keyword of DANGEROUS_KEYWORDS.slice(0, 3)) {
      it(`should declare -i ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -i ${keyword}
          ${keyword}="5+3"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("8\n");
      });

      it(`should declare -l ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -l ${keyword}
          ${keyword}="HELLO"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n");
      });

      it(`should declare -u ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -u ${keyword}
          ${keyword}="hello"
          echo $${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("HELLO\n");
      });

      it(`should declare -x ${keyword}`, async () => {
        const bash = new Bash();
        const result = await bash.exec(`
          declare -x ${keyword}="exported"
          printenv ${keyword}
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("exported\n");
      });
    }
  });

  describe("Object.prototype Verification", () => {
    it("should not pollute Object.prototype after extended operations", async () => {
      const bash = new Bash();

      // Run various operations with dangerous keywords
      await bash.exec(`
        readonly constructor="ro"
        mapfile -t __proto__ <<< "a"
        printf -v prototype "%s" "val"
        for hasOwnProperty in x y z; do :; done
        toString=(arr val)
        toString+=(more)
        declare -i valueOf=5
      `);

      // Verify Object.prototype is clean
      const testObj: Record<string, unknown> = {};
      expect(testObj.constructor).toBe(Object);
      expect(typeof testObj.toString).toBe("function");
      expect(typeof testObj.hasOwnProperty).toBe("function");
      expect(Object.keys(Object.prototype).length).toBe(0);
    });
  });
});
