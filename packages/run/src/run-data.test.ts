import { RpcTarget } from "cloudflare:workers";
import { expect, it } from "vitest";
import { run } from "./index";
import { LOCAL_DYNAMIC_WORKER_LOADER } from "./run-test-worker-loader";

interface AcceptedRunData {
  array: Array<string | undefined>;
  bigint: bigint;
  buffer: ArrayBuffer;
  dataView: DataView;
  date: Date;
  infinity: number;
  map: Map<object, unknown>;
  nan: number;
  negativeInfinity: number;
  negativeZero: number;
  nullValue: null;
  regex: RegExp;
  repeated: object;
  repeatedAgain: object;
  self: AcceptedRunData;
  set: Set<object>;
  text: string;
  typedArray: Uint16Array;
  bigintTypedArray: BigInt64Array;
  undefinedValue: undefined;
}

function createAcceptedRunData(): AcceptedRunData {
  const shared = { value: 42 };
  const sparseArray: Array<string | undefined> = [];
  sparseArray[2] = "third";
  const buffer = new Uint8Array([7, 9]).buffer;
  // SAFETY: The complete AcceptedRunData shape is assigned immediately below.
  const result = Object.create(null) as AcceptedRunData;
  Object.assign(result, {
    array: sparseArray,
    bigint: 42n,
    buffer,
    dataView: new DataView(buffer, 1, 1),
    date: new Date("2026-08-27T12:00:00.000Z"),
    infinity: Infinity,
    map: new Map(),
    nan: NaN,
    negativeInfinity: -Infinity,
    negativeZero: -0,
    nullValue: null,
    regex: /run/gi,
    repeated: shared,
    repeatedAgain: shared,
    set: new Set([shared]),
    text: "value",
    typedArray: new Uint16Array([10, 20]),
    bigintTypedArray: new BigInt64Array([30n]),
    undefinedValue: undefined
  });
  result.self = result;
  result.map.set(shared, result);
  return result;
}

const ACCEPTED_RUN_DATA_SOURCE = `
const shared = { value: 42 };
const array = [];
array[2] = "third";
const buffer = new Uint8Array([7, 9]).buffer;
const result = Object.create(null);
Object.assign(result, {
  array,
  bigint: 42n,
  buffer,
  dataView: new DataView(buffer, 1, 1),
  date: new Date("2026-08-27T12:00:00.000Z"),
  infinity: Infinity,
  map: new Map(),
  nan: NaN,
  negativeInfinity: -Infinity,
  negativeZero: -0,
  nullValue: null,
  regex: /run/gi,
  repeated: shared,
  repeatedAgain: shared,
  set: new Set([shared]),
  text: "value",
  typedArray: new Uint16Array([10, 20]),
  bigintTypedArray: new BigInt64Array([30n]),
  undefinedValue: undefined
});
result.self = result;
result.map.set(shared, result);
`;

function expectAcceptedRunData(value: AcceptedRunData): void {
  expect(value.text).toBe("value");
  expect(value.bigint).toBe(42n);
  expect(value.nullValue).toBeNull();
  expect(value.undefinedValue).toBeUndefined();
  expect(Number.isNaN(value.nan)).toBe(true);
  expect(value.infinity).toBe(Infinity);
  expect(value.negativeInfinity).toBe(-Infinity);
  expect(Object.is(value.negativeZero, -0)).toBe(true);
  expect(0 in value.array).toBe(false);
  expect(1 in value.array).toBe(false);
  expect(value.array[2]).toBe("third");
  expect(value.self).toBe(value);
  expect(value.repeatedAgain).toBe(value.repeated);
  expect(value.map.get(value.repeated)).toBe(value);
  expect(value.set.has(value.repeated)).toBe(true);
  expect(value.date.toISOString()).toBe("2026-08-27T12:00:00.000Z");
  expect(value.regex.source).toBe("run");
  expect(value.regex.flags).toBe("gi");
  expect([...new Uint8Array(value.buffer)]).toEqual([7, 9]);
  expect(value.dataView.getUint8(0)).toBe(9);
  expect(value.dataView.buffer).toBe(value.buffer);
  expect([...value.typedArray]).toEqual([10, 20]);
  expect([...value.bigintTypedArray]).toEqual([30n]);
}

it("keeps data parsing stable when generated code changes WeakSet globals", async () => {
  const result = await run<{ value: number }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const OriginalWeakSet = WeakSet;
OriginalWeakSet.prototype.add = () => { throw new Error("changed add"); };
OriginalWeakSet.prototype.has = () => { throw new Error("changed has"); };
globalThis.WeakSet = class ChangedWeakSet {};
return { value: 42 };
`
  });

  expect(result.value).toEqual({ value: 42 });
});

it("returns every permitted ordinary-data category", async () => {
  const result = await run<AcceptedRunData>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `${ACCEPTED_RUN_DATA_SOURCE}\nreturn result;`
  });

  expectAcceptedRunData(result.value);
});

it("passes every permitted ordinary-data category to a host function", async () => {
  const result = await run<{
    cycle: boolean;
    mapCycle: boolean;
    repeated: boolean;
    sparse: boolean;
    typed: number;
  }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `${ACCEPTED_RUN_DATA_SOURCE}\nreturn await tools.inspect(result);`,
    hostFunctions: {
      tools: {
        inspect(value: AcceptedRunData) {
          return {
            cycle: value.self === value,
            mapCycle: value.map.get(value.repeated) === value,
            repeated: value.repeated === value.repeatedAgain,
            sparse: !(0 in value.array) && value.array[2] === "third",
            typed: value.typedArray[1]
          };
        }
      }
    }
  });

  expect(result.value).toEqual({
    cycle: true,
    mapCycle: true,
    repeated: true,
    sparse: true,
    typed: 20
  });
});

it("receives every permitted ordinary-data category from a host function", async () => {
  const result = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const value = await tools.read();
return {
  nullPrototypeValue: value.text,
  cycle: value.self === value,
  mapCycle: value.map.get(value.repeated) === value,
  repeated: value.repeated === value.repeatedAgain,
  sparse: !(0 in value.array) && value.array[2] === "third",
  date: value.date.toISOString(),
  regex: value.regex.source + ":" + value.regex.flags,
  buffer: [...new Uint8Array(value.buffer)].join(","),
  dataView: value.dataView.getUint8(0),
  sharedBuffer: value.dataView.buffer === value.buffer,
  typed: value.typedArray[1],
  bigintTyped: value.bigintTypedArray[0],
  specialNumbers:
    Number.isNaN(value.nan) &&
    value.infinity === Infinity &&
    value.negativeInfinity === -Infinity &&
    Object.is(value.negativeZero, -0)
};
`,
    hostFunctions: { tools: { read: createAcceptedRunData } }
  });

  expect(result.value).toEqual({
    nullPrototypeValue: "value",
    cycle: true,
    mapCycle: true,
    repeated: true,
    sparse: true,
    date: "2026-08-27T12:00:00.000Z",
    regex: "run:gi",
    buffer: "7,9",
    dataView: 9,
    sharedBuffer: true,
    typed: 20,
    bigintTyped: 30n,
    specialNumbers: true
  });
});

it("accepts Float16Array in every transfer direction when available", async () => {
  const Float16ArrayConstructor = Reflect.get(globalThis, "Float16Array");
  if (typeof Float16ArrayConstructor !== "function") return;

  const returned = await run<ArrayLike<number>>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return new Float16Array([1.5, 2.25]);"
  });
  expect(Array.from(returned.value)).toEqual([1.5, 2.25]);

  let receivedHostArgument = false;
  await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.accept(new Float16Array([3.5]));",
    hostFunctions: {
      tools: {
        accept(value: unknown) {
          receivedHostArgument =
            typeof value === "object" &&
            value !== null &&
            Reflect.getPrototypeOf(value) ===
              Reflect.get(Float16ArrayConstructor, "prototype");
        }
      }
    }
  });
  expect(receivedHostArgument).toBe(true);

  const hostValue = Reflect.construct(Float16ArrayConstructor, [[4.5, 5.25]]);
  const returnedHostValue = await run<ArrayLike<number>>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.read();",
    hostFunctions: { tools: { read: () => hostValue } }
  });
  expect(Array.from(returnedHostValue.value)).toEqual([4.5, 5.25]);
});

class TestRunRpcTarget extends RpcTarget {
  readonly value = 1;
}

const REJECTED_RUN_DATA: ReadonlyArray<
  readonly [string, string, () => unknown]
> = [
  ["function", "() => 1", () => () => 1],
  ["symbol", 'Symbol("private-symbol")', () => Symbol("private-symbol")],
  [
    "nested promise",
    "{ value: Promise.resolve(1) }",
    () => ({ value: Promise.resolve(1) })
  ],
  [
    "nested thenable",
    "{ value: { then() {} } }",
    () => ({ value: { then() {} } })
  ],
  ["weak map", "new WeakMap()", () => new WeakMap()],
  ["weak set", "new WeakSet()", () => new WeakSet()],
  ["weak reference", "new WeakRef({})", () => new WeakRef({})],
  ["readable stream", "new ReadableStream()", () => new ReadableStream()],
  ["writable stream", "new WritableStream()", () => new WritableStream()],
  [
    "request",
    'new Request("https://example.com")',
    () => new Request("https://example.com")
  ],
  [
    "response",
    'new Response("private-response")',
    () => new Response("private-response")
  ],
  ["live capability", "new WebSocketPair()[0]", () => new TestRunRpcTarget()],
  [
    "custom instance",
    "new (class PrivateClass {})()",
    () => new (class PrivateClass {})()
  ],
  [
    "spoofed date",
    "Object.create(Date.prototype)",
    () => Object.create(Date.prototype)
  ],
  [
    "spoofed regular expression",
    "Object.create(RegExp.prototype)",
    () => Object.create(RegExp.prototype)
  ],
  [
    "spoofed array buffer",
    "Object.create(ArrayBuffer.prototype)",
    () => Object.create(ArrayBuffer.prototype)
  ],
  ["boxed primitive", "new Number(1)", () => new Number(1)],
  [
    "error as data",
    'new Error("private-error")',
    () => new Error("private-error")
  ],
  [
    "accessor",
    'Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("private-getter"); } })',
    () =>
      Object.defineProperty({}, "secret", {
        enumerable: true,
        get() {
          throw new Error("private-getter");
        }
      })
  ],
  [
    "non-enumerable field",
    'Object.defineProperty({}, "secret", { value: "private-value" })',
    () => Object.defineProperty({}, "secret", { value: "private-value" })
  ],
  [
    "symbol field",
    'Object.defineProperty({}, Symbol("private-key"), { enumerable: true, value: 1 })',
    () =>
      Object.defineProperty({}, Symbol("private-key"), {
        enumerable: true,
        value: 1
      })
  ],
  [
    "enumerable inherited symbol",
    '(() => { Object.defineProperty(Object.prototype, Symbol("private-key"), { enumerable: true, value: 1 }); return {}; })()',
    () =>
      Object.create(
        Object.defineProperty({}, Symbol("private-key"), {
          enumerable: true,
          value: 1
        })
      )
  ],
  [
    "custom built-in field",
    "Object.assign(new Date(), { extra: 1 })",
    () => Object.assign(new Date(), { extra: 1 })
  ],
  [
    "reflection failure",
    'new Proxy({}, { ownKeys() { throw new Error("private-proxy"); } })',
    () =>
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("private-proxy");
          }
        }
      )
  ]
];

it.each(REJECTED_RUN_DATA)(
  "rejects a final %s as ordinary data",
  async (_name, expression) => {
    const failure = await run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: `return ${expression};`
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      name: "RunError",
      code: "RUN_SERIALIZATION_ERROR",
      message: "Run data could not be serialized.",
      details: { path: "result" }
    });
    expect(String(failure)).not.toMatch(/private-/u);
  }
);

it.each(REJECTED_RUN_DATA)(
  "rejects a host-function argument containing a %s",
  async (_name, expression) => {
    let invocationCount = 0;
    const failure = await run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: `return await tools.accept(${expression});`,
      hostFunctions: {
        tools: {
          accept() {
            invocationCount++;
            return true;
          }
        }
      }
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      name: "RunError",
      code: "RUN_SERIALIZATION_ERROR",
      message: "Run data could not be serialized.",
      details: {
        path: "hostFunction.arguments",
        hostFunction: "tools.accept"
      }
    });
    expect(String(failure)).not.toMatch(/private-/u);
    expect(invocationCount).toBe(0);
  }
);

it.each(REJECTED_RUN_DATA)(
  "rejects a host-function result containing a %s",
  async (_name, _expression, createValue) => {
    const failure = await run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: "return await tools.read();",
      hostFunctions: { tools: { read: createValue } }
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      name: "RunError",
      code: "RUN_SERIALIZATION_ERROR",
      message: "Run data could not be serialized.",
      details: {
        path: "hostFunction.result",
        hostFunction: "tools.read"
      }
    });
    expect(String(failure)).not.toMatch(/private-/u);
  }
);
