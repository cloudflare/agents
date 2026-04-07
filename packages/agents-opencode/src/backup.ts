import type { DirectoryBackup, ISandbox } from "@cloudflare/sandbox";
import type { OpenCodeSessionState } from "./types";

type PersistedBackup = { backups: DirectoryBackup[] };

const BACKUP_KEY = "opencode:backup";
const SESSION_STATE_KEY = "opencode:session-state";

/**
 * Backup the sandbox workspace to R2 and persist both the backup handle
 * and the OpenCode session state in DO storage.
 *
 * Failures are caught and logged — callers don't need to handle errors.
 *
 * Note: DirectoryBackup is a small reference ({ id, dir }), not file
 * contents, so the serialized value stays well within DO storage's
 * 128 KiB per-value limit.
 */
export async function backupSession(
  sandbox: ISandbox,
  storage: DurableObjectStorage,
  sessionState?: OpenCodeSessionState
): Promise<void> {
  try {
    const dirs = ["/workspace", "/home/opencode"];
    const backups = dirs.map((dir) =>
      sandbox.createBackup({
        dir,
        gitignore: false
      })
    );
    await storage.put(
      BACKUP_KEY,
      JSON.stringify({
        backups: await Promise.all(backups)
      } satisfies PersistedBackup)
    );

    if (sessionState) {
      await storage.put(SESSION_STATE_KEY, JSON.stringify(sessionState));
    }
  } catch (err) {
    console.warn("[opencode/backup] Failed to backup:", err);
  }
}

/**
 * Result of a restore operation. Contains the filesystem backup status
 * and any persisted OpenCode session state.
 */
export type RestoreResult = {
  /** Whether a filesystem backup was found and restored. */
  fsRestored: boolean;
  /** Persisted OpenCode session state, if any. */
  sessionState: OpenCodeSessionState | null;
};

/**
 * Restore the sandbox workspace from R2 backup and retrieve persisted
 * OpenCode session state from DO storage.
 *
 * The caller is responsible for using the session state to reconnect
 * the OpenCode client and resume any in-flight runs.
 */
export async function restoreSession(
  sandbox: ISandbox,
  storage: DurableObjectStorage
): Promise<RestoreResult> {
  let fsRestored = false;
  let sessionState: OpenCodeSessionState | null = null;

  // Restore filesystem
  try {
    const raw = await storage.get<string>(BACKUP_KEY);
    if (raw) {
      const { backups } = JSON.parse(raw) as PersistedBackup;
      await Promise.all(backups.map((backup) => sandbox.restoreBackup(backup)));
      fsRestored = true;
    }
  } catch (err) {
    console.warn("[opencode/backup] Failed to restore filesystem:", err);
  }

  // Restore session state
  try {
    const raw = await storage.get<string>(SESSION_STATE_KEY);
    if (raw) {
      sessionState = JSON.parse(raw) as OpenCodeSessionState;
    }
  } catch (err) {
    console.warn("[opencode/backup] Failed to restore session state:", err);
  }

  console.info("[opencode/backup] Restored: %j", { fsRestored, sessionState });
  return { fsRestored, sessionState };
}

/**
 * Update only the session state in DO storage (without a full FS backup).
 * Used to persist in-flight run status changes.
 */
export async function updateSessionState(
  storage: DurableObjectStorage,
  sessionState: OpenCodeSessionState
): Promise<void> {
  try {
    await storage.put(SESSION_STATE_KEY, JSON.stringify(sessionState));
  } catch (err) {
    console.warn("[opencode/backup] Failed to update session state:", err);
  }
}
