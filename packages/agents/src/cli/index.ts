import { main as acp } from "../experimental/channels/acp/bridge";
import { main as tui } from "../experimental/channels/web/tui/main";

const usage = `Usage: agents <command>

Commands:
  tui <url>   Chat with an agent's Web Channel from the terminal
  acp <url>   Connect an ACP client, such as Zed or T3 Code, to an agent's ACP channel`;

const [command, ...rest] = process.argv.slice(2);

if (command === "tui") {
  process.exit(await tui(rest));
}
if (command === "acp") {
  process.exit(await acp(rest));
}
if (command === undefined || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}
console.error(`Unknown command "${command}"\n\n${usage}`);
process.exit(2);
