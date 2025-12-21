import { execSync } from "node:child_process";

const update = process.argv.includes("-u") ? "-u" : "";

execSync(
  `npx npm-check-updates ${update} \
  --reject @a2a-\*  \
  --reject vitest \
  --reject @vitest/runner \
  --reject @vitest/browser \
  --reject vitest-browser-react \
  --reject @vitest/ui \
  --reject @modelcontextprotocol/sdk \
  --reject zod \
  --workspaces`,
  {
    stdio: "inherit"
  }
);
