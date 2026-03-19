import type { SlashCommand, AutocompleteItem } from "@mariozechner/pi-tui";
import { listSessions } from "../local/sessions.js";

export function getSlashCommands(server?: string): SlashCommand[] {
  return [
    { name: "clear", description: "Clear the current session" },
    { name: "exit", description: "Quit think" },
    { name: "session", description: "Show current session info" },
    { name: "new", description: "Start a new session" },
    {
      name: "resume",
      description: "List and resume sessions",
      getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
        const sessions = listSessions(server);
        if (sessions.length === 0) return null;

        const items = sessions.map((s) => ({
          value: s.name ?? s.id,
          label: s.name ? `${s.name} (${s.id.slice(0, 8)}…)` : s.id,
          description: s.firstMessage?.slice(0, 40) ?? new Date(s.lastUsedAt).toLocaleDateString()
        }));

        if (!prefix) return items;

        const lower = prefix.toLowerCase();
        const filtered = items.filter((i) => i.value.toLowerCase().startsWith(lower));
        return filtered.length > 0 ? filtered : null;
      }
    },
    { name: "name", description: "Name the current session" },
    { name: "model", description: "Show current model info" }
  ];
}
