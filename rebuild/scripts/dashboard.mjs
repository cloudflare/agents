#!/usr/bin/env node
/**
 * Test-port dashboard generator. SINGLE SOURCE OF TRUTH: parses
 * test-workers/ported/COVERAGE.md (the ledger), ISSUES.md, and PROGRESS.md
 * at run time and emits a self-contained dashboard.html. Never edit the
 * HTML — edit the ledger and re-run:  npm run dashboard
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// Parse COVERAGE.md
// ---------------------------------------------------------------------------
const STATUS_RE =
  /^(?:\*\*)?(ported|rewritten|pending|blocked|quarry|dropped|native|claimed|n\/a)\b/i;

function stripMd(s) {
  return s.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function categorize(statusCell) {
  const s = stripMd(statusCell);
  const counts = s.match(/(?:ported|rewritten)\s+(\d+)\/(\d+)/i);
  if (counts) {
    const passed = Number(counts[1]);
    const total = Number(counts[2]);
    return { cat: passed >= total ? "green" : "partial", passed, total };
  }
  if (/^blocked/i.test(s)) {
    const issue = s.match(/ISSUE-(\d+)/)?.[1];
    return { cat: "blocked", issue };
  }
  if (/^(pending|claimed)/i.test(s)) return { cat: "pending" };
  if (/^quarry/i.test(s)) return { cat: "quarry" };
  if (/^(dropped|native|n\/a)/i.test(s)) return { cat: "dropped" };
  return { cat: "pending" };
}

function parseCoverage(md) {
  const sections = [];
  for (const block of md.split(/\n## /).slice(1)) {
    const heading = block.slice(0, block.indexOf("\n")).trim();
    const lines = block.split("\n").filter((l) => /^\|/.test(l.trim()));
    if (lines.length < 2) continue;
    const header = lines[0].split("|").map(stripMd);
    const isQuarryTable = header.some((h) => /maps to/i.test(h));
    const rows = [];
    for (const line of lines.slice(2)) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 2) continue;
      const name = stripMd(cells[0]);
      const testsCell = cells.find((c) => /^~?\d+$/.test(stripMd(c)));
      const tests = testsCell
        ? Number(stripMd(testsCell).replace("~", ""))
        : null;
      // Prefer a counted status (ported/rewritten n/m) over any bare status
      // word — defends against malformed rows carrying a stale extra cell.
      const statusCell = isQuarryTable
        ? "quarry"
        : (cells.find((c) => /(?:ported|rewritten)\s+\d+\/\d+/i.test(c)) ??
          cells.find((c) => STATUS_RE.test(stripMd(c))) ??
          "pending");
      let notes = stripMd(cells[cells.length - 1] ?? "");
      // Fidelity is a leading [fidelity:x] token in the notes cell — the
      // ledger stays the single source for both the status and fidelity axes.
      const fidMatch = notes.match(/^\[fidelity:(move|light|adapter|rewrite)\]\s*/i);
      const fidelity = fidMatch ? fidMatch[1].toLowerCase() : null;
      if (fidMatch) notes = notes.slice(fidMatch[0].length);
      const info = categorize(statusCell);
      rows.push({ name, tests, status: stripMd(statusCell), notes, fidelity, ...info });
    }
    if (rows.length > 0) sections.push({ heading, rows });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Parse ISSUES.md and PROGRESS.md
// ---------------------------------------------------------------------------
function parseIssues(md) {
  const issues = [];
  const re = /^## (ISSUE-\d+) — (.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const nextIssue = md.indexOf("\n## ISSUE-", re.lastIndex);
    const body = md
      .slice(re.lastIndex, nextIssue === -1 ? md.length : nextIssue)
      .replace(/\n---\s*$/, "")
      .trim();
    const status =
      body.match(/\*\*Status:\*\*\s*(resolved|open|in-progress)/i)?.[1] ??
      "open";
    issues.push({
      id: m[1],
      title: m[2].trim(),
      status: status.toLowerCase(),
      body
    });
  }
  return issues;
}

function parseLog(md, limit = 10) {
  const logIdx = md.indexOf("## Log");
  if (logIdx === -1) return [];
  return md
    .slice(logIdx)
    .split("\n")
    .filter((l) => /^- 20\d\d-\d\d-\d\d/.test(l))
    .slice(0, limit)
    .map((l) => {
      const date = l.slice(2, 12);
      const text = l.slice(14).trim();
      return { date, text };
    });
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------
const coverage = parseCoverage(read("test-workers/ported/COVERAGE.md"));
const issues = parseIssues(read("ISSUES.md"));
const log = parseLog(read("PROGRESS.md"));

const CATS = ["green", "partial", "pending", "blocked", "quarry", "dropped"];
const CAT_LABEL = {
  green: "Ported · all pass",
  partial: "Ported · some fail",
  pending: "Not ported · queued",
  blocked: "Not ported · blocked",
  quarry: "Won't port · checklist",
  dropped: "Won't port · native"
};
const CAT_DEF = {
  green: "Copied across and running; every assertion passes.",
  partial: "Copied across and running; some assertions fail — triaged (see notes), not port bugs.",
  pending: "Nothing blocks it — just not reached yet. The unclaimed backlog.",
  blocked: "Porting now would only re-confirm a named missing feature; ports for real when its ISSUE lands.",
  quarry: "Tests internals of the deleted architecture — never ported; read as a checklist to preserve behaviour in our native suite.",
  dropped: "Not ported because it would add nothing — the rebuild's native suite already covers it, or it's meaningless here (e.g. old-schema migration)."
};

// Fidelity: HOW faithfully a ported test tracks the original (orthogonal to
// pass/fail). Ordered most → least faithful.
const FIDS = ["move", "light", "adapter", "rewrite"];
const FID_LABEL = {
  move: "Pure move",
  light: "Light touch",
  adapter: "New adapter",
  rewrite: "Rewritten"
};
const FID_DEF = {
  move: "Imports re-pointed, nothing else — runs on generic scaffolding.",
  light: "Test body verbatim; only a shared harness swap or a minimal fixture.",
  adapter: "Test body verbatim, but a bespoke fixture agent + compat surface was built (the fixtures can't import the original Think).",
  rewrite: "Test logic re-authored against the rebuilt API — assertions' substance preserved."
};

function tally(rows) {
  const t = Object.fromEntries(CATS.map((c) => [c, { files: 0, tests: 0 }]));
  let boardPassed = 0;
  let boardTotal = 0;
  for (const r of rows) {
    t[r.cat].files += 1;
    t[r.cat].tests += r.tests ?? 0;
    if (r.passed !== undefined) {
      boardPassed += r.passed;
      boardTotal += r.total;
    }
  }
  return { ...t, boardPassed, boardTotal };
}

const allRows = coverage.flatMap((s) => s.rows);
const totals = tally(allRows);
const totalTests = allRows.reduce((n, r) => n + (r.tests ?? 0), 0);

// Fidelity tally over ported/rewritten rows (files, weighted by test count).
const fidTally = Object.fromEntries(FIDS.map((f) => [f, { files: 0, tests: 0 }]));
for (const r of allRows) {
  if (r.fidelity && fidTally[r.fidelity]) {
    fidTally[r.fidelity].files += 1;
    fidTally[r.fidelity].tests += r.tests ?? 0;
  }
}
const fidTotalTests = FIDS.reduce((n, f) => n + fidTally[f].tests, 0);
const fidTotalFiles = FIDS.reduce((n, f) => n + fidTally[f].files, 0);
const blockedTestsByIssue = new Map();
for (const row of allRows) {
  if (row.cat === "blocked" && row.issue) {
    const id = `ISSUE-${row.issue}`;
    blockedTestsByIssue.set(
      id,
      (blockedTestsByIssue.get(id) ?? 0) + (row.tests ?? 0)
    );
  }
}
for (const issue of issues)
  issue.blockedTests = blockedTestsByIssue.get(issue.id) ?? 0;
const openIssues = issues.filter((i) => i.status !== "resolved");
const gitInfo = (() => {
  try {
    return execSync(
      "git log -1 --format=%h·%cd --date=format:%Y-%m-%d\\ %H:%M",
      { cwd: root }
    )
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
})();

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function stackedBar(t, totalT) {
  const segs = CATS.filter((c) => t[c].tests > 0)
    .map((c) => {
      const pct = ((t[c].tests / totalT) * 100).toFixed(2);
      const label = `${CAT_LABEL[c]}: ${t[c].tests} tests (${t[c].files} files)`;
      return `<div class="seg seg-${c}" style="width:${pct}%" title="${esc(label)}"></div>`;
    })
    .join("");
  return `<div class="bar" role="img" aria-label="test status composition">${segs}</div>`;
}

function chip(row) {
  if (row.passed !== undefined) {
    return `<span class="chip chip-${row.cat}">${row.passed}/${row.total}</span>`;
  }
  if (row.cat === "blocked") {
    const id = row.issue ? `ISSUE-${row.issue}` : null;
    return id
      ? `<button class="chip chip-blocked issue-trigger" type="button" data-issue="${id}">${id}</button>`
      : `<span class="chip chip-blocked">ISSUE-?</span>`;
  }
  return `<span class="chip chip-${row.cat}">${esc(row.status.split(" ")[0])}</span>`;
}

function passBar(row) {
  if (row.passed === undefined || row.total === 0) return "";
  const pct = ((row.passed / row.total) * 100).toFixed(1);
  return `<div class="mini"><div class="mini-fill" style="width:${pct}%"></div></div>`;
}

function sectionCard(s) {
  const t = tally(s.rows);
  const sTests = s.rows.reduce((n, r) => n + (r.tests ?? 0), 0);
  const rows = s.rows
    .map(
      (r) => `<tr>
      <td class="file">${esc(r.name)}</td>
      <td class="num">${r.tests ?? "–"}</td>
      <td class="stat">${chip(r)}${passBar(r)}</td>
      <td class="fid">${r.fidelity ? `<span class="fchip fchip-${r.fidelity}" title="${esc(FID_DEF[r.fidelity])}">${FID_LABEL[r.fidelity]}</span>` : ""}</td>
      <td class="notes"><details><summary>notes</summary><p>${esc(r.notes)}</p></details></td>
    </tr>`
    )
    .join("\n");
  return `<section class="card">
    <header><h2>${esc(s.heading)}</h2><span class="muted">${s.rows.length} files · ${sTests} tests</span></header>
    ${stackedBar(t, Math.max(sTests, 1))}
    <div class="scroll"><table>
      <thead><tr><th>file</th><th class="num">tests</th><th>status</th><th>fidelity</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

const legend = CATS.map(
  (c) =>
    `<div class="glossg"><span class="lg"><i class="dot seg-${c}"></i><span class="lg-name">${CAT_LABEL[c]}</span> <b>${totals[c].tests}</b></span><span class="def">${CAT_DEF[c]}</span></div>`
).join("");

function fidBar() {
  const segs = FIDS.filter((f) => fidTally[f].tests > 0)
    .map((f) => {
      const pct = ((fidTally[f].tests / Math.max(fidTotalTests, 1)) * 100).toFixed(2);
      return `<div class="seg fseg-${f}" style="width:${pct}%" title="${esc(FID_LABEL[f])}: ${fidTally[f].tests} tests, ${fidTally[f].files} files"></div>`;
    })
    .join("");
  return `<div class="bar">${segs}</div>`;
}
const fidLegend = FIDS.map(
  (f) =>
    `<div class="glossg"><span class="lg"><i class="dot fseg-${f}"></i><span class="lg-name">${FID_LABEL[f]}</span> <b>${fidTally[f].files} files</b></span><span class="def">${FID_DEF[f]}</span></div>`
).join("");

const issueChips = issues
  .toSorted(
    (a, b) => b.blockedTests - a.blockedTests || a.id.localeCompare(b.id)
  )
  .map(
    (i) =>
      `<button class="ichip issue-trigger ${i.status === "resolved" ? "done" : "open"}" type="button" data-issue="${i.id}" title="${esc(i.title)}"><span>${i.id}</span><em>${esc(
        i.title.length > 46 ? i.title.slice(0, 44) + "…" : i.title
      )}</em><b>${i.blockedTests} tests blocked</b></button>`
  )
  .join("");

const issueDetails = Object.fromEntries(
  issues.map((i) => [
    i.id,
    { title: i.title, body: i.body, blockedTests: i.blockedTests }
  ])
);

const logItems = log
  .map((l) => `<li><time>${l.date}</time><p>${esc(l.text)}</p></li>`)
  .join("");

const passRate = totals.boardTotal
  ? ((totals.boardPassed / totals.boardTotal) * 100).toFixed(1)
  : "0";

const html = `<title>Rebuild test-port dashboard</title>
<style>
:root{
  --bg:#faf9f6; --card:#ffffff; --ink:#1c1a17; --ink-2:#5f5b53; --ink-3:#8a857a;
  --line:#e7e4dc; --accent:#0f766e;
  --c-green:#008300; --c-partial:#eda100; --c-pending:#1baf7a; --c-blocked:#4a3aa7; --c-quarry:#e87ba4; --c-dropped:#2a78d6;
  /* fidelity ramp: teal, most→least faithful (sequential, one hue) */
  --f-move:#0f766e; --f-light:#3f9d94; --f-adapter:#7bbfb7; --f-rewrite:#b9ddd8;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#16181d; --card:#1e2127; --ink:#e8e6e1; --ink-2:#a8a49b; --ink-3:#767268;
  --line:#2c2f36; --accent:#2aa79b;
  --c-green:#008300; --c-partial:#c98500; --c-pending:#199e70; --c-blocked:#9085e9; --c-quarry:#d55181; --c-dropped:#3987e5;
  --f-move:#2aa79b; --f-light:#3f8f87; --f-adapter:#4d6f6a; --f-rewrite:#3a4b49;
}}
:root[data-theme="dark"]{
  --bg:#16181d; --card:#1e2127; --ink:#e8e6e1; --ink-2:#a8a49b; --ink-3:#767268;
  --line:#2c2f36; --accent:#2aa79b;
  --c-green:#008300; --c-partial:#c98500; --c-pending:#199e70; --c-blocked:#9085e9; --c-quarry:#d55181; --c-dropped:#3987e5;
  --f-move:#2aa79b; --f-light:#3f8f87; --f-adapter:#4d6f6a; --f-rewrite:#3a4b49;
}
:root[data-theme="light"]{
  --bg:#faf9f6; --card:#ffffff; --ink:#1c1a17; --ink-2:#5f5b53; --ink-3:#8a857a;
  --line:#e7e4dc; --accent:#0f766e;
  --c-green:#008300; --c-partial:#eda100; --c-pending:#1baf7a; --c-blocked:#4a3aa7; --c-quarry:#e87ba4; --c-dropped:#2a78d6;
  --f-move:#0f766e; --f-light:#3f9d94; --f-adapter:#7bbfb7; --f-rewrite:#b9ddd8;
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0;padding:32px 20px 64px}
main{max-width:1060px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
h2{font-size:14px;margin:0;font-weight:600}
.muted{color:var(--ink-3);font-size:12.5px}
.mono,.file,.num,.tile b,time{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px 14px}
.tile b{display:block;font-size:26px;font-weight:600;letter-spacing:-.02em}
.tile span{font-size:12px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.06em}
.tile .sub{color:var(--ink-3);text-transform:none;letter-spacing:0;font-size:12px}
.bar{display:flex;height:14px;border-radius:4px;overflow:hidden;gap:2px;background:var(--bg)}
.seg{min-width:3px;transition:filter .1s}
.seg:hover{filter:brightness(1.18);outline:2px solid var(--ink);outline-offset:-2px}
.seg-green{background:var(--c-green)}.seg-partial{background:var(--c-partial)}.seg-pending{background:var(--c-pending)}
.seg-blocked{background:var(--c-blocked)}.seg-quarry{background:var(--c-quarry)}.seg-dropped{background:var(--c-dropped)}
.lead{margin:0;color:var(--ink-2);font-size:13px;max-width:78ch}
.gloss{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px 20px}
.glossg{display:flex;flex-direction:column;gap:1px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink)}
.lg .lg-name{font-weight:600}.lg b{color:var(--ink-3);font-weight:500;font-family:ui-monospace,Menlo,monospace}
.def{color:var(--ink-2);font-size:12px;padding-left:15px;max-width:52ch;line-height:1.4}
.dot{width:9px;height:9px;border-radius:2px;display:inline-block;flex:none}
.fseg-move{background:var(--f-move)}.fseg-light{background:var(--f-light)}.fseg-adapter{background:var(--f-adapter)}.fseg-rewrite{background:var(--f-rewrite)}
td.fid,th:nth-child(4){width:96px}
.fchip{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:9px;border:1px solid var(--line);color:var(--ink-2);white-space:nowrap}
.fchip-move{border-color:var(--f-move);color:var(--f-move)}
.fchip-light{border-color:var(--f-light)}
.fchip-adapter{border-color:var(--f-adapter)}
.fchip-rewrite{border-color:var(--f-rewrite)}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th{color:var(--ink-3);text-align:left;font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;padding:4px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:5px 10px 5px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.file{font-size:12.5px;word-break:break-word;max-width:340px}
td.num,th.num{text-align:right;width:44px}
.stat{white-space:nowrap;width:120px}
.chip{display:inline-block;background:transparent;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;padding:1px 7px;border-radius:9px;border:1px solid;line-height:1.5}
.issue-trigger{cursor:pointer}
.chip-green{color:var(--c-green);border-color:var(--c-green)}
.chip-partial{color:var(--c-partial);border-color:var(--c-partial)}
.chip-pending{color:var(--c-pending);border-color:var(--c-pending)}
.chip-blocked{color:var(--c-blocked);border-color:var(--c-blocked)}
.chip-quarry{color:var(--c-quarry);border-color:var(--c-quarry)}
.chip-dropped{color:var(--c-dropped);border-color:var(--c-dropped)}
.mini{height:3px;background:var(--line);border-radius:2px;margin-top:5px;max-width:104px}
.mini-fill{height:100%;background:var(--c-green);border-radius:2px}
.notes details{font-size:12px;color:var(--ink-2)}
.notes summary{cursor:pointer;color:var(--ink-3);list-style:none}
.notes summary:hover{color:var(--accent)}
.notes p{margin:4px 0 0;max-width:60ch}
.ichips{display:flex;flex-wrap:wrap;gap:6px}
.ichip{background:transparent;color:inherit;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;border:1px solid var(--line);border-radius:5px;padding:3px 8px;display:inline-flex;gap:6px;align-items:baseline;cursor:pointer;text-align:left}
.ichip em{font-style:normal;color:var(--ink-2);font-family:ui-sans-serif,system-ui,sans-serif}
.ichip b{color:var(--ink-3);font-weight:500}
.ichip.open{border-color:var(--c-blocked);color:var(--c-blocked)}
.ichip.done{color:var(--ink-3);text-decoration:line-through}
.ichip.done em{text-decoration:none;color:var(--ink-3)}
.ichip:hover,.chip-blocked:hover{background:color-mix(in srgb,var(--c-blocked) 10%,transparent)}
.issue-dialog{width:min(760px,calc(100% - 32px));max-height:calc(100% - 32px);padding:0;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);box-shadow:0 18px 60px #0005}
.issue-dialog::backdrop{background:#0008}
.issue-dialog header{display:flex;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid var(--line)}
.issue-dialog h2{font-size:16px}.issue-dialog .muted{display:block;margin-top:3px}
.issue-dialog pre{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink-2)}
.dialog-close{align-self:start;border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--ink);cursor:pointer;font-size:18px;line-height:1;padding:4px 7px}
ol.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
ol.log li{display:grid;grid-template-columns:88px 1fr;gap:12px;font-size:13px}
ol.log time{color:var(--ink-3);font-size:12px}
ol.log p{margin:0;color:var(--ink-2);max-width:88ch}
footer{color:var(--ink-3);font-size:12px;text-align:center}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<main>
  <div class="head">
    <h1>Rebuild · test-port dashboard</h1>
    <span class="muted mono">generated from COVERAGE.md @ ${esc(gitInfo)}</span>
  </div>
  <div class="tiles">
    <div class="tile"><span>Board pass rate</span><b>${passRate}%</b><span class="sub mono">${totals.boardPassed}/${totals.boardTotal} ported tests passing</span></div>
    <div class="tile"><span>Tests on the board</span><b>${totals.boardTotal}</b><span class="sub mono">of ${totalTests} accounted in ledger</span></div>
    <div class="tile"><span>Files green</span><b>${totals.green.files}</b><span class="sub mono">${totals.partial.files} ported &amp; failing · ${totals.pending.files} awaiting</span></div>
    <div class="tile"><span>Issues</span><b>${openIssues.length}</b><span class="sub mono">open · ${issues.length - openIssues.length} resolved</span></div>
  </div>
  <section class="card">
    <header><h2>All original tests by status</h2><span class="muted mono">${totalTests} tests</span></header>
    ${stackedBar(totals, Math.max(totalTests, 1))}
    <div class="gloss">${legend}</div>
  </section>
  <section class="card">
    <header><h2>Port fidelity</h2><span class="muted mono">${fidTotalFiles} ported files · ${fidTotalTests} tests</span></header>
    <p class="lead">Of the files actually on the board, how faithfully each tracks the original — independent of whether its tests currently pass.</p>
    ${fidBar()}
    <div class="gloss">${fidLegend}</div>
  </section>
  ${coverage.map(sectionCard).join("\n")}
  <section class="card">
    <header><h2>Issue tracker</h2><span class="muted">${openIssues.length} open</span></header>
    <div class="ichips">${issueChips}</div>
  </section>
  <section class="card">
    <header><h2>Recent activity</h2><span class="muted">PROGRESS.md log</span></header>
    <ol class="log">${logItems}</ol>
  </section>
  <footer>Single source of truth: <span class="mono">test-workers/ported/COVERAGE.md</span> — regenerate with <span class="mono">npm run dashboard</span></footer>
</main>
<dialog class="issue-dialog" id="issue-dialog" aria-labelledby="issue-dialog-title">
  <header><div><h2 id="issue-dialog-title"></h2><span class="muted mono" id="issue-dialog-meta"></span></div><button class="dialog-close" type="button" aria-label="Close issue details">×</button></header>
  <pre id="issue-dialog-body"></pre>
</dialog>
<script>
const issueDetails = ${JSON.stringify(issueDetails).replace(/</g, "\\u003c")};
const dialog = document.querySelector("#issue-dialog");
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-issue]");
  if (!trigger) return;
  const id = trigger.dataset.issue;
  const issue = issueDetails[id];
  if (!issue) return;
  document.querySelector("#issue-dialog-title").textContent = id + " · " + issue.title;
  document.querySelector("#issue-dialog-meta").textContent = issue.blockedTests + " tests blocked";
  document.querySelector("#issue-dialog-body").textContent = issue.body;
  dialog.showModal();
});
document.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
</script>`;

writeFileSync(join(root, "dashboard.html"), html);
console.log(
  `dashboard.html written — board ${totals.boardPassed}/${totals.boardTotal} (${passRate}%), ` +
    `${totals.green.files} files green, ${openIssues.length} issues open`
);
