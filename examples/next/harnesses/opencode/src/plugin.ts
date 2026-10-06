import type { Plugin } from "@opencode/plugin";

/**
 * OpenCode's tools that need a local filesystem or process. The Workers
 * profile has neither, so the model is not offered them.
 */
const LOCAL_TOOLS = ["read", "write", "edit", "patch", "glob", "grep", "shell"];

const SYSTEM = `You are running inside a Cloudflare Durable Object, not on the user's computer. There is no filesystem or shell. You can keep notes with save_note, list_notes, read_note and delete_note: they persist in this object's storage across sessions and restarts. You can fetch web pages with webfetch. Be concise.`;

type Note = { readonly text: string; readonly updated: number };

const NOTE_PREFIX = "note:";

/**
 * This app's OpenCode plugin: notes kept in the Durable Object's own
 * storage, in place of OpenCode's local file and shell tools.
 */
export function playgroundPlugin(storage: SyncKvStorage): Plugin.Plugin {
  const titleInput = {
    type: "object",
    properties: { title: { type: "string", description: "The note's title" } },
    required: ["title"],
    additionalProperties: false
  } as const;

  return {
    id: "example.playground",
    async setup(ctx) {
      await ctx.agent.transform((editor) => {
        editor.update("build", (agent) => {
          agent.system = SYSTEM;
        });
      });
      await ctx.tool.transform((editor) => {
        for (const id of LOCAL_TOOLS) editor.remove(id);
        editor.add({
          name: "save_note",
          description: "Save a note under a title, replacing any note with it.",
          input: {
            type: "object",
            properties: {
              title: { type: "string", description: "The note's title" },
              text: { type: "string", description: "The note's text" }
            },
            required: ["title", "text"],
            additionalProperties: false
          },
          execute: async (input) => {
            const { title, text } = input as { title: string; text: string };
            storage.put<Note>(`${NOTE_PREFIX}${title}`, {
              text,
              updated: Date.now()
            });
            return { content: `Saved "${title}".` };
          }
        });
        editor.add({
          name: "list_notes",
          description: "List the titles of every saved note.",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false
          },
          execute: async () => {
            const titles = [...storage.list<Note>({ prefix: NOTE_PREFIX })].map(
              ([key]) => key.slice(NOTE_PREFIX.length)
            );
            return {
              content: titles.length > 0 ? titles.join("\n") : "No notes yet."
            };
          }
        });
        editor.add({
          name: "read_note",
          description: "Read a saved note by its title.",
          input: titleInput,
          execute: async (input) => {
            const { title } = input as { title: string };
            const note = storage.get<Note>(`${NOTE_PREFIX}${title}`);
            return {
              content: note ? note.text : `There is no note titled "${title}".`
            };
          }
        });
        editor.add({
          name: "delete_note",
          description: "Delete a saved note by its title.",
          input: titleInput,
          execute: async (input) => {
            const { title } = input as { title: string };
            const deleted = storage.delete(`${NOTE_PREFIX}${title}`);
            return {
              content: deleted
                ? `Deleted "${title}".`
                : `There is no note titled "${title}".`
            };
          }
        });
      });
    }
  };
}
