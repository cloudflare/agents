// Stress driver for the codex harness under `wrangler dev`.
//
//   wrangler dev --config src/stress/wrangler.jsonc --port 8790 --inspector-port 9250
//   node scripts/stress.mjs [baseUrl] [scenario...]
//
// Scenarios: baseline, deep, wide, big-tools, huge-prompt, many-ops, concurrent, all

const args = process.argv.slice(2);
const baseUrl = (
  args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8790"
).replace(/\/$/, "");
const selected = args.filter((a) => !a.startsWith("http"));
const wanted =
  selected.length === 0 || selected.includes("all") ? null : new Set(selected);

async function run(object, scenario, promptBytes = 64) {
  const response = await fetch(
    `${baseUrl}/run?object=${encodeURIComponent(object)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario, promptBytes })
    }
  );
  const body = await response.json();
  if (!response.ok) {
    // A rejected submission is a result too: report it and keep going.
    return {
      status: "rejected",
      wallMs: 0,
      kernelMs: 0,
      transitions: 0,
      checkpointBytes: 0,
      events: 0,
      error: body.error
    };
  }
  return body;
}

async function stats(object) {
  return (
    await fetch(`${baseUrl}/stats?object=${encodeURIComponent(object)}`)
  ).json();
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function describe(label, result) {
  const err = result.error ? `  ERROR: ${result.error.slice(0, 120)}` : "";
  console.log(
    `  ${label.padEnd(28)} ${result.status.padEnd(9)} wall ${String(result.wallMs).padStart(6)} ms  kernel ${String(result.kernelMs).padStart(8)} ms  ${String(result.transitions).padStart(3)} transitions  checkpoint ${kb(result.checkpointBytes).padStart(10)}  ${result.events} events${err}`
  );
}

function describeStats(label, s) {
  console.log(
    `  ${label.padEnd(28)} ops ${s.operations}  checkpoints ${kb(s.checkpointBytesTotal)} (max ${kb(s.checkpointBytesMax)})  events ${s.events} / ${kb(s.eventBytesTotal)}  chunks ${s.streamChunks}  db ${kb(s.databaseBytes)}  wasm memory ${kb(s.kernelMemoryBytes)}`
  );
}

const base = {
  rounds: 1,
  callsPerRound: 2,
  toolBytes: 256,
  answerBytes: 256,
  reasoningBytes: 64
};
const stamp = Date.now().toString(36);
const scenarios = {
  async baseline() {
    describe("3 transitions", await run(`baseline-${stamp}`, base));
  },
  async deep() {
    describe(
      "7 rounds x 2 calls",
      await run(`deep-${stamp}`, { ...base, rounds: 7 })
    );
    describe(
      "12 rounds x 2 calls",
      await run(`deep-${stamp}`, { ...base, rounds: 12 })
    );
    describe(
      "30 rounds (over round cap)",
      await run(`deep-${stamp}`, { ...base, rounds: 30 })
    );
  },
  async wide() {
    describe(
      "1 round x 14 calls",
      await run(`wide-${stamp}`, { ...base, callsPerRound: 14 })
    );
    describe(
      "1 round x 60 calls",
      await run(`wide-${stamp}`, { ...base, callsPerRound: 60 })
    );
  },
  async "big-tools"() {
    for (const toolBytes of [16 * 1024, 128 * 1024, 512 * 1024, 1024 * 1024]) {
      describe(
        `3 rounds, ${kb(toolBytes)} tools`,
        await run(`big-${stamp}`, { ...base, rounds: 3, toolBytes })
      );
    }
    describeStats("after big tools", await stats(`big-${stamp}`));
  },
  async "huge-prompt"() {
    for (const promptBytes of [
      64 * 1024,
      512 * 1024,
      1024 * 1024,
      1900 * 1024
    ]) {
      describe(
        `${kb(promptBytes)} prompt`,
        await run(`prompt-${stamp}`, base, promptBytes)
      );
    }
    describeStats("after huge prompts", await stats(`prompt-${stamp}`));
  },
  async "many-ops"() {
    const object = `many-${stamp}`;
    const started = performance.now();
    let kernel = 0;
    for (let i = 0; i < 200; i++) {
      const result = await run(object, { ...base, rounds: 2, toolBytes: 2048 });
      kernel += result.kernelMs;
      if (i === 0 || i === 49 || i === 199) describe(`op ${i + 1}`, result);
    }
    console.log(
      `  200 ops in ${Math.round(performance.now() - started)} ms, kernel total ${kernel.toFixed(1)} ms`
    );
    describeStats("after 200 ops", await stats(object));
  },
  async concurrent() {
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        run(`conc-${stamp}-${i}`, { ...base, rounds: 3, toolBytes: 8192 })
      )
    );
    const walls = results.map((r) => r.wallMs).sort((a, b) => a - b);
    console.log(
      `  32 objects x 3 rounds: total ${Math.round(performance.now() - started)} ms, wall p50 ${walls[16]} ms p95 ${walls[30]} ms max ${walls[31]} ms, failures ${results.filter((r) => r.status !== "completed").length}`
    );
  }
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (wanted && !wanted.has(name)) continue;
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (error) {
    console.log(`  FAILED: ${error.message}`);
  }
}
