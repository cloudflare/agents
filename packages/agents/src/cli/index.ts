import { main as tui } from "../experimental/channels/web/tui/main";

const usage = `Usage: agents <command>

Commands:
  tui <url>   Chat with an agent's Web Channel from the terminal`;

const [command, ...rest] = process.argv.slice(2);

if (command === "tui") {
  process.exit(await tui(rest));
}
if (command === undefined || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}
console.error(`Unknown command "${command}"\n\n${usage}`);
process.exit(2);
