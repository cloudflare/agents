#!/usr/bin/env node
// Stress test for the agents-sessions-slam worker.
//
//   node slam.mjs <base-url> <sessionName> [--quick] [--ref-32mib]
//
// Runs the scenarios in order against one named Durable Object and prints a
// markdown table: scenario, server ms, client ms, rows written, key result.
// Exits non-zero when any check fails. Node 22, no dependencies.

import { createHash, randomBytes } from "node:crypto";

const KIB = 1024;
const MIB = 1024 * 1024;
const POINTER_PREFIX = "attachment:sha256:";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [baseArg, sessionName] = args.filter((a) => !a.startsWith("--"));
if (!baseArg || !sessionName) {
  console.error(
    "usage: node slam.mjs <base-url> <sessionName> [--quick] [--ref-32mib]"
  );
  process.exit(2);
}
const quick = flags.has("--quick");
const base = `${baseArg.replace(/\/+$/, "")}/${encodeURIComponent(sessionName)}`;

const UPLOAD_SIZES = quick
  ? [1 * KIB, 100 * KIB, 1_572_865]
  : [
      1 * KIB,
      100 * KIB,
      1_499_999,
      1_500_000,
      1_572_864,
      1_572_865,
      8 * MIB,
      32 * MIB
    ];
const TEXT_APPENDS = quick ? 50 : 500;
const BIG_TEXT_APPENDS = quick ? 2 : 20;
const BIG_TEXT_BYTES = Math.floor(1.4 * MIB);
const HYDRATE_BUDGET = 32 * MIB;
const HYDRATE_MIN_RECENT = 4;

const rows = [];
let failures = 0;

function human(n) {
  if (n >= MIB) return `${(n / MIB).toFixed(n % MIB ? 2 : 0)} MiB`;
  if (n >= KIB) return `${(n / KIB).toFixed(n % KIB ? 1 : 0)} KiB`;
  return `${n} B`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function chunked(buffer, chunkSize = 64 * KIB) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buffer.length) {
        controller.close();
        return;
      }
      controller.enqueue(buffer.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }
  });
}

async function call(method, path, { body, stream } = {}) {
  const started = performance.now();
  const init = { method };
  if (body !== undefined) {
    init.body = stream ? chunked(body) : body;
    if (stream) init.duplex = "half";
    init.headers = { "content-type": "application/octet-stream" };
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  const clientMs = Math.round(performance.now() - started);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: { name: "NonJsonResponse", message: text.slice(0, 200) } };
  }
  return { status: response.status, json, clientMs };
}

/** Record one scenario row. `fn` returns { json, clientMs, result, checks }. */
async function scenario(name, fn) {
  process.stderr.write(`… ${name}\n`);
  const started = performance.now();
  try {
    const out = await fn();
    const failed = (out.checks ?? []).filter((c) => !c.ok);
    if (failed.length > 0) failures += 1;
    rows.push({
      name,
      ms: out.json?.ms ?? "",
      clientMs: out.clientMs ?? Math.round(performance.now() - started),
      rowsWritten: out.json?.rowsWritten ?? "",
      result: out.result ?? "",
      ok:
        failed.length === 0
          ? "ok"
          : `FAIL: ${failed.map((c) => c.what).join("; ")}`
    });
  } catch (error) {
    failures += 1;
    rows.push({
      name,
      ms: "",
      clientMs: Math.round(performance.now() - started),
      rowsWritten: "",
      result: error instanceof Error ? error.message : String(error),
      ok: "FAIL: threw"
    });
  }
}

function check(what, ok) {
  return { what, ok: Boolean(ok) };
}

function errorText(json) {
  return json?.error ? `${json.error.name}: ${json.error.message}` : "";
}

function expectOk(status, json) {
  return check(`HTTP ${status} ${errorText(json)}`.trim(), status < 400);
}

// ── Scenarios ──────────────────────────────────────────────────────────────

const uploads = new Map(); // size → hash (declared-length upload)

async function upload(size, declared) {
  const data = randomBytes(size);
  const hash = sha256(data);
  const label = `upload ${human(size)} ${declared ? "declared" : "undeclared"}`;
  await scenario(label, async () => {
    const query = new URLSearchParams({
      bytes: String(size),
      declared: String(declared),
      mediaType: "application/octet-stream",
      filename: `slam-${size}-${declared ? "d" : "u"}.bin`
    });
    const { status, json, clientMs } = await call("POST", `/upload?${query}`, {
      body: data,
      stream: !declared
    });
    const checks = [expectOk(status, json)];
    let result = errorText(json);
    if (status < 400) {
      const attachment = json.attachment ?? {};
      checks.push(
        check("hash matches", attachment.hash === hash),
        check("bytes match", attachment.bytes === size),
        check("part url is pointer", json.part?.url === POINTER_PREFIX + hash)
      );
      const rt = performance.now();
      const response = await fetch(`${base}/attachment/${hash}`);
      const hasher = createHash("sha256");
      let received = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          hasher.update(chunk);
          received += chunk.length;
        }
      }
      const roundTripMs = Math.round(performance.now() - rt);
      checks.push(
        check(`GET /attachment ${response.status}`, response.status === 200),
        check("round-trip sha256", hasher.digest("hex") === hash),
        check("round-trip bytes", received === size)
      );
      if (declared) uploads.set(size, hash);
      // workerd drops content-length on a plain JS ReadableStream body, so a
      // missing header is reported rather than failed.
      const contentLength = response.headers.get("content-length");
      const lengthNote =
        contentLength === String(size)
          ? ""
          : `; no content-length (${contentLength})`;
      result = `backend ${json.backend ?? "n/a"}; round-trip ${roundTripMs} ms${lengthNote}`;
    }
    return { json, clientMs, result, checks };
  });
}

async function simple(name, method, path, describe, verify = () => []) {
  await scenario(name, async () => {
    const { status, json, clientMs } = await call(method, path);
    const checks = [expectOk(status, json)];
    let result = errorText(json);
    if (status < 400) {
      result = describe(json);
      checks.push(...verify(json));
    }
    return { json, clientMs, result, checks };
  });
}

const statsText = (s) =>
  s
    ? `path ${s.pathLength}, content ${human(s.totalContentBytes)}, attachments ${human(s.attachmentBytes)}, ~${s.tokenEstimate} tokens`
    : "";

async function main() {
  console.error(`slam → ${base}${quick ? " (quick)" : ""}`);

  await simple("clear", "POST", "/clear", (j) => statsText(j.stats));
  await simple(
    "stats (initial)",
    "GET",
    "/stats",
    (j) =>
      `${statsText(j.stats)}; db ${human(j.databaseSize)}; tracked=${j.rowsWrittenTracked}`
  );

  for (const size of UPLOAD_SIZES) {
    await upload(size, true);
    await upload(size, false);
  }

  await simple(
    `append ${TEXT_APPENDS} × 2 KiB text`,
    "POST",
    `/append?count=${TEXT_APPENDS}&textBytes=2048`,
    (j) => statsText(j.stats)
  );

  const smallFile = uploads.get(100 * KIB);
  if (smallFile) {
    await simple(
      "append 10 × 2 KiB text + 100 KiB file pointer",
      "POST",
      `/append?count=10&textBytes=2048&file=${smallFile}`,
      (j) => statsText(j.stats)
    );
  }
  const largeFile = uploads.get(8 * MIB) ?? uploads.get(1_572_865);
  if (largeFile) {
    await simple(
      `append 2 × 256 B text + ${human(uploads.has(8 * MIB) ? 8 * MIB : 1_572_865)} file pointer`,
      "POST",
      `/append?count=2&textBytes=256&file=${largeFile}`,
      (j) => statsText(j.stats)
    );
  }
  if (flags.has("--ref-32mib") && uploads.has(32 * MIB)) {
    await simple(
      "append 1 × 256 B text + 32 MiB file pointer",
      "POST",
      `/append?count=1&textBytes=256&file=${uploads.get(32 * MIB)}`,
      (j) => statsText(j.stats)
    );
  }

  await simple(
    `append ${BIG_TEXT_APPENDS} × ${human(BIG_TEXT_BYTES)} text`,
    "POST",
    `/append?count=${BIG_TEXT_APPENDS}&textBytes=${BIG_TEXT_BYTES}`,
    (j) => statsText(j.stats)
  );

  for (const [bytes, expected] of [
    [1_000_000, "inline"],
    [1_600_000, "pointer"],
    [5_000_000, "pointer"]
  ]) {
    await simple(
      `append-large ${bytes.toLocaleString("en-US")} B text`,
      "POST",
      `/append-large?bytes=${bytes}`,
      (j) =>
        `${j.shape}; row ${human(j.rowBytes ?? 0)}; attachments ${j.attachments?.map((a) => human(a.bytes)).join(",") || "none"}`,
      (j) => [check(`shape ${expected}`, j.shape === expected)]
    );
  }

  await simple(
    "append-tool 3,000,000 B output",
    "POST",
    "/append-tool?bytes=3000000",
    (j) =>
      `${j.shape}; row ${human(j.rowBytes ?? 0)}; attachments ${j.attachments?.map((a) => human(a.bytes)).join(",") || "none"}`,
    (j) => [check("shape pointer", j.shape === "pointer")]
  );

  const before = await call("GET", "/stats");
  const pathLength = before.json?.stats?.pathLength ?? -1;

  for (const mode of ["inline", "pointer"]) {
    await simple(
      `hydrate ${human(HYDRATE_BUDGET)} min ${HYDRATE_MIN_RECENT} ${mode}`,
      "GET",
      `/hydrate?budget=${HYDRATE_BUDGET}&minRecent=${HYDRATE_MIN_RECENT}&mode=${mode}`,
      (j) =>
        `${j.messages}/${pathLength} msgs, truncated=${j.truncated}, hydrated ${human(j.hydratedBytes)} (${((100 * j.hydratedBytes) / HYDRATE_BUDGET).toFixed(0)}% of budget), stored ${human(j.totalContentBytes)}`,
      (j) => [check("messages ≥ minRecent", j.messages >= HYDRATE_MIN_RECENT)]
    );
  }

  for (const mode of ["inline", "pointer"]) {
    await scenario(`history stream ${mode}`, async () => {
      const started = performance.now();
      const response = await fetch(`${base}/history?mode=${mode}`);
      let bytes = 0;
      let lines = 0;
      let done = null;
      let firstByteMs = null;
      let tail = "";
      const decoder = new TextDecoder();
      const consume = (text) => {
        tail += text;
        let nl;
        while ((nl = tail.indexOf("\n")) >= 0) {
          const line = tail.slice(0, nl);
          tail = tail.slice(nl + 1);
          if (!line) continue;
          const parsed = JSON.parse(line);
          if (parsed.done) done = parsed;
          else lines++;
        }
      };
      if (response.body) {
        for await (const chunk of response.body) {
          if (firstByteMs === null) {
            firstByteMs = Math.round(performance.now() - started);
          }
          bytes += chunk.length;
          consume(decoder.decode(chunk, { stream: true }));
        }
        consume(decoder.decode());
      }
      const clientMs = Math.round(performance.now() - started);
      const checks = [
        check(`HTTP ${response.status}`, response.status === 200),
        check("done marker", done !== null),
        check(`count ${lines} = path ${pathLength}`, lines === pathLength)
      ];
      return {
        json: done ?? {},
        clientMs,
        result: `${lines} msgs, ${human(bytes)} NDJSON, first byte ${firstByteMs} ms`,
        checks
      };
    });
  }

  await simple(
    "fork",
    "POST",
    "/fork",
    (j) => `${j.sessionId}: ${statsText(j.forkStats)}`,
    (j) => [
      check(
        `fork path ${j.forkStats?.pathLength} = ${pathLength}`,
        j.forkStats?.pathLength === pathLength
      )
    ]
  );

  await simple(
    "compact",
    "POST",
    "/compact",
    (j) => `compacted=${j.compacted}; ${statsText(j.stats)}`,
    (j) => [check("compacted", j.compacted === true)]
  );

  await simple(
    "stats (final)",
    "GET",
    "/stats",
    (j) =>
      `${statsText(j.stats)}; db ${human(j.databaseSize)}; rows msgs=${j.tables?.messages} refs=${j.tables?.attachments} blobs=${j.tables?.blobs} chunks=${j.tables?.chunks}; total rows written ${j.rowsWrittenTotal}`
  );

  // ── Report ──────────────────────────────────────────────────────────────
  const header = [
    "#",
    "Scenario",
    "Server ms",
    "Client ms",
    "Rows written",
    "Result",
    "Check"
  ];
  const table = rows.map((r, i) => [
    String(i + 1),
    r.name,
    String(r.ms),
    String(r.clientMs),
    String(r.rowsWritten),
    String(r.result).replace(/\|/g, "\\|"),
    r.ok
  ]);
  const line = (cells) => `| ${cells.join(" | ")} |`;
  console.log(`\n## Sessions slam — ${base}\n`);
  console.log(line(header));
  console.log(line(header.map(() => "---")));
  for (const cells of table) console.log(line(cells));
  console.log(
    `\n${rows.length} scenarios, ${failures} failed${quick ? " (quick mode)" : ""}`
  );
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
