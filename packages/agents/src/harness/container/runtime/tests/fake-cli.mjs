// A stand-in agent CLI for the tests: one process per turn, a session kept
// as a JSONL file under $HOME/.fake/sessions, resumed with `--resume <id>`.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const resumeAt = args.indexOf("--resume");
const id = resumeAt >= 0 ? args[resumeAt + 1] : randomUUID();
const dir = `${process.env.HOME}/.fake/sessions`;
const file = `${dir}/${id}.jsonl`;
const prompt = readFileSync(0, "utf8");
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

let history = [];
try {
  history = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
} catch {
  if (resumeAt >= 0) {
    print({ type: "error", message: `no session ${id}` });
    process.exit(2);
  }
}
mkdirSync(dir, { recursive: true });
appendFileSync(file, `${JSON.stringify({ prompt })}\n`);
print({ type: "session", id });
if (prompt.startsWith("sleep")) await new Promise((r) => setTimeout(r, 10_000));
if (prompt === "crash") process.exit(3);
print({ type: "text", text: `turn ${history.length + 1}: ${prompt}` });
print({ type: "done" });
