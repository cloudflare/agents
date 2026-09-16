// Heap profiling for the stress worker under `wrangler dev`.
//
// Connects to workerd's inspector over the Chrome DevTools Protocol, reports
// V8 heap usage, and optionally takes a heap snapshot and aggregates retained
// size by constructor so the biggest holders are visible without DevTools.
//
//   node scripts/heap.mjs usage   [inspectorPort]
//   node scripts/heap.mjs snapshot [inspectorPort] [topN]

import { createRequire } from "node:module";

const [mode = "usage", portArg = "9250", topArg = "25"] = process.argv.slice(2);
const port = Number(portArg);
// wrangler's inspector proxy insists on an Origin header, which the built-in
// WebSocket cannot set; the repo's `ws` package can.
const { WebSocket: WsSocket } = createRequire(import.meta.url)("ws");

async function inspectorTarget() {
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const target =
    targets.find((t) => String(t.id).includes("user")) ?? targets[0];
  if (!target) throw new Error("no inspector targets");
  return target.webSocketDebuggerUrl;
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WsSocket(url, { headers: { Origin: "http://localhost" } });
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject })
    );
  }
  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }
  close() {
    this.#ws.close();
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Aggregate a V8 heap snapshot by node name: count, self size, and share. */
function aggregate(snapshot, topN) {
  const meta = snapshot.snapshot.meta;
  const fields = meta.node_fields;
  const typeIndex = fields.indexOf("type");
  const nameIndex = fields.indexOf("name");
  const sizeIndex = fields.indexOf("self_size");
  const types = meta.node_types[typeIndex];
  const stride = fields.length;
  const { nodes, strings } = snapshot;
  const byName = new Map();
  let total = 0;
  for (let i = 0; i < nodes.length; i += stride) {
    const type = types[nodes[i + typeIndex]];
    const name = strings[nodes[i + nameIndex]];
    const size = nodes[i + sizeIndex];
    total += size;
    const key = type === "object" || type === "closure" ? name : `(${type})`;
    const entry = byName.get(key) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += size;
    byName.set(key, entry);
  }
  const rows = [...byName.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, topN);
  return { total, rows };
}

const cdp = await Cdp.connect(await inspectorTarget());
setTimeout(() => {
  console.error("inspector did not answer in time");
  process.exit(2);
}, 120_000).unref();
// The proxy does not answer collectGarbage; send it and move on.
void cdp.send("HeapProfiler.collectGarbage");
await new Promise((resolve) => setTimeout(resolve, 500));
const usage = await cdp.send("Runtime.getHeapUsage");
console.log(
  `JS heap used ${mb(usage.usedSize)} of ${mb(usage.totalSize)}; backing store (ArrayBuffers, Wasm memory) ${mb(usage.backingStorageSize ?? 0)}`
);

if (mode === "snapshot") {
  // wrangler's proxy never answers the takeHeapSnapshot command itself, so
  // completion is detected from the progress events and a quiet period.
  const chunks = [];
  let finished = false;
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) =>
    chunks.push(chunk)
  );
  cdp.on("HeapProfiler.reportHeapSnapshotProgress", (params) => {
    if (params.finished) finished = true;
  });
  void cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: true });
  let settled = 0;
  while (settled < 4) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const count = chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    settled = finished && chunks.length === count ? settled + 1 : 0;
  }
  const snapshot = JSON.parse(chunks.join(""));
  const { total, rows } = aggregate(snapshot, Number(topArg));
  console.log(
    `snapshot: ${snapshot.nodes.length / snapshot.snapshot.meta.node_fields.length} nodes, ${mb(total)} self size`
  );
  console.log("top holders by self size:");
  for (const [name, { count, size }] of rows) {
    console.log(
      `  ${mb(size).padStart(10)}  ${String(count).padStart(8)}×  ${name.slice(0, 70)}`
    );
  }
}
cdp.close();
