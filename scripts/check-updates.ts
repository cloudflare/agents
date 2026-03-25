import { execSync } from "node:child_process";

const update = process.argv.includes("-u") ? "-u" : "";

execSync(
  `npx npm-check-updates ${update} --reject @modelcontextprotocol/sdk --reject streamdown --reject @streamdown/code --reject typescript --workspaces`,
  {
    stdio: "inherit"
  }
);
