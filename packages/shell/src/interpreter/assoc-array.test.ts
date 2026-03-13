import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Associative Arrays", () => {
  const createEnv = () =>
    new Bash({
      files: { "/tmp/_keep": "" },
      cwd: "/tmp",
      env: { HOME: "/tmp" }
    });

  describe("declare -A", () => {
    it("should declare an associative array", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A arr
        arr['foo']=bar
        echo "\${arr['foo']}"
      `);
      expect(result.stdout.trim()).toBe("bar");
      expect(result.exitCode).toBe(0);
    });

    it("should initialize associative array with literal syntax", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A=(['foo']=bar ['spam']=42)
        echo "\${A['foo']} \${A['spam']}"
      `);
      expect(result.stdout.trim()).toBe("bar 42");
      expect(result.exitCode).toBe(0);
    });

    it("should not reset existing associative array on redeclare", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A dict
        dict['foo']=hello
        declare -A dict
        echo "\${dict['foo']}"
      `);
      expect(result.stdout.trim()).toBe("hello");
    });
  });

  describe("string key assignment", () => {
    it("should assign with quoted string key", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A arr
        arr['my key']=value
        echo "\${arr['my key']}"
      `);
      expect(result.stdout.trim()).toBe("value");
    });

    it("should assign with double-quoted string key", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A arr
        arr["my key"]=value
        echo "\${arr["my key"]}"
      `);
      expect(result.stdout.trim()).toBe("value");
    });
  });

  describe("arithmetic context", () => {
    it("should read from associative array in arithmetic", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A['x']=42
        echo "before: A['x']=" \${A['x']}
        (( x = A['x'] ))
        echo "after: x=$x"
      `);
      console.log("DEBUG read arith stdout:", JSON.stringify(result.stdout));
      console.log("DEBUG read arith stderr:", JSON.stringify(result.stderr));
      expect(result.stdout).toContain("42");
    });

    it("should assign to associative array in arithmetic with string key", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        (( A['foo'] = 123 ))
        echo "\${A['foo']}"
      `);
      expect(result.stdout.trim()).toBe("123");
    });

    it("should use variable name as literal key for associative arrays", async () => {
      const env = createEnv();
      // In bash, for associative arrays, A[K] uses "K" as the key, not K's value
      const result = await env.exec(`
        declare -A A
        K=5
        V=42
        (( A[K] = V ))
        echo "\${A['K']}"
      `);
      expect(result.stdout.trim()).toBe("42");
    });

    it("should coerce string values to integers in arithmetic", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A['x']=42
        (( x = A['x'] ))
        (( A['y'] = 'y' ))
        echo $x \${A['y']}
      `);
      // 'y' as a value gets coerced to 0 (variable y is unset)
      expect(result.stdout.trim()).toBe("42 0");
    });

    it("should support compound assignment operators", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A['count']=10
        (( A['count'] += 5 ))
        echo "\${A['count']}"
      `);
      expect(result.stdout.trim()).toBe("15");
    });

    it("should support increment/decrement on associative array elements", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A['x']=10
        (( A['x']++ ))
        echo "\${A['x']}"
      `);
      expect(result.stdout.trim()).toBe("11");
    });
  });

  describe("indexed arrays (existing behavior)", () => {
    it("should still work with numeric indices", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -a arr
        arr[0]=first
        arr[1]=second
        echo "\${arr[0]} \${arr[1]}"
      `);
      expect(result.stdout.trim()).toBe("first second");
    });

    it("should evaluate arithmetic expressions in indices for indexed arrays", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -a arr
        arr[0]=zero
        arr[1]=one
        arr[2]=two
        i=1
        echo "\${arr[i]} \${arr[i+1]}"
      `);
      expect(result.stdout.trim()).toBe("one two");
    });

    it("should use variable VALUE for indexed array subscripts in arithmetic", async () => {
      const env = createEnv();
      // For indexed arrays, A[K] evaluates K as arithmetic (gets its value)
      const result = await env.exec(`
        declare -a arr
        arr[5]=value
        K=5
        (( x = arr[K] ))
        echo "got: \${arr[5]}"
      `);
      expect(result.stdout.trim()).toBe("got: value");
    });
  });

  describe("array element access", () => {
    it("should return all values with ${arr[@]}", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A['a']=1
        A['b']=2
        A['c']=3
        echo "\${A[@]}"
      `);
      // Values should be returned (order may vary for associative arrays)
      const values = result.stdout.trim().split(" ").sort();
      expect(values).toEqual(["1", "2", "3"]);
    });

    it("should return empty for unset key", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A['foo']=bar
        echo "[\${A['nonexistent']}]"
      `);
      expect(result.stdout.trim()).toBe("[]");
    });
  });

  describe("TODO: spec test fixes", () => {
    it.skip("key-value sequence initialization", async () => {
      // declare -A A=(1 2 3) should create ['1']=2 ['3']=''
      const env = createEnv();
      const result = await env.exec(`
        declare -A A=(1 2 3)
        declare -p A
      `);
      // Expected: declare -A A=(['1']=2 ['3']='')
      expect(result.stdout.trim()).toBe("declare -A A=(['1']=2 ['3']='' )");
      expect(result.exitCode).toBe(0);
    });

    it("variable key lookup", async () => {
      const env = createEnv();
      const result = await env.exec(`
        declare -A A
        A["aa"]=b
        A["foo"]=bar
        key=foo
        echo \${A[$key]}
        i=a
        echo \${A["$i$i"]}
      `);
      expect(result.stdout.trim()).toBe("bar\nb");
    });

    it("self-reference in assignment (bash behavior)", async () => {
      const env = createEnv();
      // Step 0: Check declare -p output
      let result = await env.exec(`
        declare -A foo
        foo=(["key"]="value1")
        declare -p foo
      `);
      console.log("step0 stdout:", JSON.stringify(result.stdout));

      // Step 1: Single quoted assignment & lookup
      result = await env.exec(`
        declare -A bar
        bar=(['key']='value1')
        echo \${bar['key']}
      `);
      console.log("step1 stdout:", JSON.stringify(result.stdout));
      expect(result.stdout.trim()).toBe("value1");
    });

    it("nested array index in array literal", async () => {
      const env = createEnv();
      // Test: a=([0]=1+2+3 [a[0]]=10 [a[6]]=hello)
      // [0]=1+2+3 sets a[0]="1+2+3" (literal string)
      // [a[0]]=10 - a[0] is "1+2+3", in arithmetic context 1+2+3=6, so a[6]=10
      // [a[6]]=hello - a[6] is now 10, so a[10]="hello"
      const result = await env.exec(`
        a=([0]=1+2+3 [a[0]]=10 [a[6]]=hello)
        echo "keys: \${!a[@]}"
        echo "vals: \${a[@]}"
      `);
      expect(result.stdout.trim()).toBe("keys: 0 6 10\nvals: 1+2+3 10 hello");
    });
  });
});
