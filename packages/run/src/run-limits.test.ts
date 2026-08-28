import { expect, it } from "vitest";
import { run } from "./index";
import { parseRunLimits } from "./run-limits";
import { createRecordingLoader } from "./run-test-recording-loader";
import type { RunLimits } from "./run-types";

const RUN_LIMIT_BOUNDS: ReadonlyArray<
  readonly [keyof RunLimits, number, number]
> = [
  ["timeoutMs", 1, 300_000],
  ["cpuMs", 1, 300_000],
  ["subRequests", 1, 10_000],
  ["maxSourceBytes", 1, 1_048_576],
  ["maxLogBytes", 25, 1_048_576],
  ["maxHostFunctionCalls", 1, 4_096],
  ["maxConcurrentHostFunctionCalls", 1, 32]
];

it("loads the exact default child limits", async () => {
  const recording = createRecordingLoader();

  await run({ loader: recording.loader, source: "return 42;" });

  expect(recording.loadedCode[0]?.limits).toEqual({
    cpuMs: 5_000,
    subRequests: 256
  });
});

it("passes configured cpu and subrequest overrides to the Loader", async () => {
  const recording = createRecordingLoader();

  await run({
    loader: recording.loader,
    source: "return 42;",
    limits: { cpuMs: 123, subRequests: 45 }
  });

  expect(recording.loadedCode[0]?.limits).toEqual({
    cpuMs: 123,
    subRequests: 45
  });
});

it.each(RUN_LIMIT_BOUNDS)(
  "accepts %s at its exact minimum and hard maximum",
  async (limit, minimum, maximum) => {
    for (const value of [minimum, maximum]) {
      const recording = createRecordingLoader();
      await expect(
        run({
          loader: recording.loader,
          source: "1",
          limits: { [limit]: value }
        })
      ).resolves.toMatchObject({ status: "completed" });
      expect(recording.loadedCode).toHaveLength(1);
    }
  }
);

it.each(RUN_LIMIT_BOUNDS)(
  "rejects %s one over its hard maximum before Loader use",
  async (limit, _minimum, maximum) => {
    const recording = createRecordingLoader();

    await expect(
      run({
        loader: recording.loader,
        source: "1",
        limits: { [limit]: maximum + 1 }
      })
    ).rejects.toMatchObject({
      name: "RunError",
      code: "RUN_INVALID_INPUT",
      details: { path: `limits.${limit}`, limit }
    });
    expect(recording.loadedCode).toEqual([]);
  }
);

it.each(RUN_LIMIT_BOUNDS)(
  "rejects %s one under its minimum before Loader use",
  async (limit, minimum) => {
    const recording = createRecordingLoader();

    await expect(
      run({
        loader: recording.loader,
        source: "1",
        limits: { [limit]: minimum - 1 }
      })
    ).rejects.toMatchObject({
      name: "RunError",
      code: "RUN_INVALID_INPUT",
      details: { path: `limits.${limit}`, limit }
    });
    expect(recording.loadedCode).toEqual([]);
  }
);

it.each([
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["negative", -1],
  ["unsafe integer", 2 ** 53],
  ["numeric string", "100"],
  ["bigint", 100n],
  ["null", null]
] as const)(
  "rejects a %s limit override before Loader use",
  async (_name, value) => {
    const recording = createRecordingLoader();

    await expect(
      run({
        loader: recording.loader,
        source: "return 42;",
        // SAFETY: Deliberately violates RunLimits to prove runtime override validation.
        limits: { timeoutMs: value as number }
      })
    ).rejects.toMatchObject({
      name: "RunError",
      code: "RUN_INVALID_INPUT",
      details: { path: "limits.timeoutMs", limit: "timeoutMs" }
    });
    expect(recording.loadedCode).toEqual([]);
  }
);

it("rejects a non-object limits container before Loader use", async () => {
  const recording = createRecordingLoader();

  await expect(
    run({
      loader: recording.loader,
      source: "return 42;",
      // SAFETY: Deliberately violates RunOptions to prove runtime container validation.
      limits: 100 as unknown as RunLimits
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_INVALID_INPUT",
    details: { path: "limits" }
  });
  expect(recording.loadedCode).toEqual([]);
});

it("rejects non-string source before Loader use", async () => {
  const recording = createRecordingLoader();

  await expect(
    run({
      loader: recording.loader,
      // SAFETY: Deliberately violates RunOptions to prove runtime source validation.
      source: 42 as unknown as string
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_INVALID_INPUT",
    details: { path: "source" }
  });
  expect(recording.loadedCode).toEqual([]);
});

it("accepts multibyte source at the exact configured byte boundary", async () => {
  const source = "return '🔥';";
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  const recording = createRecordingLoader();

  await expect(
    run({
      loader: recording.loader,
      source,
      limits: { maxSourceBytes: sourceBytes }
    })
  ).resolves.toMatchObject({ status: "completed" });
  expect(recording.loadedCode).toHaveLength(1);
});

it("rejects multibyte source one byte over the configured boundary", async () => {
  const source = "return '🔥';";
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  const recording = createRecordingLoader();

  await expect(
    run({
      loader: recording.loader,
      source,
      limits: { maxSourceBytes: sourceBytes - 1 }
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_SOURCE_TOO_LARGE",
    details: {
      limit: "maxSourceBytes",
      observed: sourceBytes,
      allowed: sourceBytes - 1
    }
  });
  expect(recording.loadedCode).toEqual([]);
});

it("passes exactly the child-enforced limits to the generated Worker", async () => {
  const recording = createRecordingLoader();

  await run({
    loader: recording.loader,
    source: "return 42;",
    limits: {
      maxLogBytes: 100,
      maxHostFunctionCalls: 3,
      maxConcurrentHostFunctionCalls: 2
    }
  });

  expect(recording.evaluateArgs[0]?.[2]).toEqual({
    maxLogBytes: 100,
    maxHostFunctionCalls: 3,
    maxConcurrentHostFunctionCalls: 2
  });
});

it("resolves the exact specification default for every limit", () => {
  expect(parseRunLimits(undefined)).toEqual({
    timeoutMs: 30_000,
    cpuMs: 5_000,
    subRequests: 256,
    maxSourceBytes: 262_144,
    maxLogBytes: 262_144,
    maxHostFunctionCalls: 256,
    maxConcurrentHostFunctionCalls: 8
  });
});

it("rejects every invalid numeric category for every limit", () => {
  const invalidValues = [
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    2 ** 53
  ];
  for (const [limit] of RUN_LIMIT_BOUNDS) {
    for (const value of invalidValues) {
      let caught: unknown;
      try {
        parseRunLimits({ [limit]: value });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught, `${limit} must reject ${value}`).toMatchObject({
        name: "RunError",
        code: "RUN_INVALID_INPUT",
        details: { path: `limits.${limit}`, limit }
      });
    }
  }
});

it("passes the exact child-enforced limit defaults to the generated Worker", async () => {
  const recording = createRecordingLoader();

  await run({ loader: recording.loader, source: "return 42;" });

  expect(recording.evaluateArgs[0]?.[2]).toEqual({
    maxLogBytes: 262_144,
    maxHostFunctionCalls: 256,
    maxConcurrentHostFunctionCalls: 8
  });
});

it("rejects malformed options with RUN_INVALID_INPUT before any Loader use", async () => {
  const recording = createRecordingLoader();
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [null, "options"],
    [{ source: "return 1;" }, "loader"],
    [{ loader: {}, source: "return 1;" }, "loader"],
    [{ loader: recording.loader, source: "return 1;", signal: {} }, "signal"],
    [
      {
        loader: recording.loader,
        source: "return 1;",
        // A forged prototype passes instanceof but fails the native brand.
        signal: Object.create(AbortSignal.prototype) as AbortSignal
      },
      "signal"
    ],
    [
      {
        loader: recording.loader,
        source: "return 1;",
        signal: new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("hostile prototype trap");
            }
          }
        )
      },
      "signal"
    ]
  ];

  for (const [options, path] of cases) {
    const failure = await run(
      // SAFETY: Deliberately violates RunOptions to prove runtime validation.
      options as unknown as Parameters<typeof run>[0]
    ).catch((cause: unknown) => cause);
    expect(failure, `path ${path}`).toMatchObject({
      name: "RunError",
      code: "RUN_INVALID_INPUT",
      details: { path }
    });
  }
  expect(recording.loadedCode).toEqual([]);
});
