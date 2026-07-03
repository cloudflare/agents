/**
 * Seed the agent-think-skills R2 bucket from ./skills.
 *
 * Uploads every skills/<name>/SKILL.md to the bucket under the
 * `.agents/skills/<name>/SKILL.md` key, matching the mount prefix in
 * wrangler.jsonc (R2Bucket(env.R2_SKILLS, { prefix: ".agents/" }) →
 * /workspace/.agents). Run after editing a skill:
 *
 *   npm run seed:r2            # remote bucket
 *   npm run seed:r2 -- --local # local (wrangler dev) bucket
 */
import { readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const local = process.argv.includes("--local");
const bucket = "agent-think-skills";

for (const name of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const file = join(skillsDir, name.name, "SKILL.md");
  if (!existsSync(file)) continue;
  const key = `.agents/skills/${name.name}/SKILL.md`;
  const args = [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    file,
    local ? "--local" : "--remote"
  ];
  console.log(`↑ ${key}${local ? " (local)" : ""}`);
  execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
}
console.log("done.");
