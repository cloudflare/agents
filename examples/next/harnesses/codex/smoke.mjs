const args = process.argv.slice(2).filter((arg) => arg !== "--");
const baseUrl = (args[0] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const concurrency = Number(args[1] ?? "1");
const probeId = crypto.randomUUID().slice(0, 8);

async function jsonFetch(path, init) {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", "OpenAI File Downloader, XaiImageApiFetch/1.0");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

async function run(index) {
  const session = `static-wasm-${probeId}-${index}`;
  const operationId = `static-wasm-${crypto.randomUUID()}`;
  const marker = `gateway-${probeId}-${index}`;
  const prompt =
    `Use workspace_write to write exactly ${marker} followed by a newline to ` +
    "/codex/result.txt. Then use workspace_read to verify it. Only finish " +
    "after both tool calls succeed.";
  const startedAt = performance.now();
  const receipt = await jsonFetch(`/sessions/${session}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId, prompt })
  });

  let snapshot;
  for (let attempt = 0; attempt < 600; attempt++) {
    snapshot = await jsonFetch(
      `/sessions/${session}/operations/${operationId}`
    );
    if (snapshot.status === "completed" || snapshot.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!snapshot || snapshot.status !== "completed") {
    throw new Error(
      `${operationId} did not complete: ${JSON.stringify(snapshot)}`
    );
  }

  const [events, file, duplicate] = await Promise.all([
    jsonFetch(`/sessions/${session}/events/${operationId}`),
    jsonFetch(`/sessions/${session}/file?path=/codex/result.txt`),
    jsonFetch(`/sessions/${session}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, prompt })
    })
  ]);
  if (!String(file.content).includes(marker)) {
    throw new Error(`${operationId} Workspace verification failed`);
  }
  if (duplicate.accepted !== false) {
    throw new Error(`${operationId} duplicate admission was not deduplicated`);
  }
  return {
    session,
    operationId,
    accepted: receipt.accepted,
    deduplicated: duplicate.accepted === false,
    wallMs: Number((performance.now() - startedAt).toFixed(2)),
    kernelMs: Number(snapshot.kernelMs.toFixed(3)),
    transitions: snapshot.transitions,
    eventCount: events.events.length,
    output: snapshot.output
  };
}

const health = await jsonFetch("/health");
const results = await Promise.all(
  Array.from({ length: concurrency }, (_, index) => run(index))
);

const recovery = [];
for (const result of results.filter((candidate) =>
  candidate.session.endsWith("-0")
)) {
  await jsonFetch(`/sessions/${result.session}/restart`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const snapshot = await jsonFetch(
    `/sessions/${result.session}/operations/${result.operationId}`
  );
  const file = await jsonFetch(
    `/sessions/${result.session}/file?path=/codex/result.txt`
  );
  recovery.push({
    statusAfterRestart: snapshot.status,
    fileSurvived: String(file.content).includes(`gateway-${probeId}-0`)
  });
}

const summary = {
  runs: results.length,
  meanWallMs: Number(
    (
      results.reduce((sum, result) => sum + result.wallMs, 0) / results.length
    ).toFixed(2)
  ),
  meanKernelMs: Number(
    (
      results.reduce((sum, result) => sum + result.kernelMs, 0) / results.length
    ).toFixed(3)
  )
};

console.log(
  JSON.stringify({ health, concurrency, summary, recovery, results }, null, 2)
);
