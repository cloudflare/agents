/**
 * Local session index — stored at ~/.think/sessions.json
 *
 * Lightweight index of sessions so /resume can list them.
 * Actual session data lives on the server (DO SQLite).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".think");
const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
const MAX_SESSIONS = 100;

export interface SessionEntry {
  id: string;
  server: string;
  firstMessage?: string;
  model?: string;
  createdAt: string;
  lastUsedAt: string;
}

function readIndex(): SessionEntry[] {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeIndex(entries: SessionEntry[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(entries, null, 2) + "\n");
}

export function saveSession(session: Omit<SessionEntry, "lastUsedAt"> & { lastUsedAt?: string }): void {
  const entries = readIndex();
  const existing = entries.findIndex((e) => e.id === session.id);
  const entry: SessionEntry = { ...session, lastUsedAt: session.lastUsedAt ?? new Date().toISOString() };

  if (existing >= 0) {
    entries[existing] = { ...entries[existing], ...entry };
  } else {
    entries.unshift(entry);
  }
  writeIndex(entries.slice(0, MAX_SESSIONS));
}

export function touchSession(id: string): void {
  const entries = readIndex();
  const entry = entries.find((e) => e.id === id);
  if (entry) {
    entry.lastUsedAt = new Date().toISOString();
    writeIndex(entries);
  }
}

export function listSessions(server?: string): SessionEntry[] {
  const entries = readIndex();
  const filtered = server ? entries.filter((e) => e.server === server) : entries;
  const byId = new Map<string, SessionEntry>();
  for (const entry of filtered) {
    const existing = byId.get(entry.id);
    if (!existing || new Date(entry.lastUsedAt) > new Date(existing.lastUsedAt)) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
  );
}
