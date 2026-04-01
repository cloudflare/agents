import type { DirectoryBackup } from "@cloudflare/sandbox";
import type { SandboxWorkspace } from "./sandbox-workspace";

/**
 * Backup the workspace to R2 and persist the handle in DO storage.
 * Failures are caught and logged — callers don't need to handle errors.
 *
 * Note: DirectoryBackup is a small reference ({ id, dir }), not file
 * contents, so the serialized value stays well within DO storage's
 * 128 KiB per-value limit.
 */
export async function backupWorkspace(
  sw: SandboxWorkspace,
  storage: DurableObjectStorage
): Promise<void> {
  try {
    const backup = await sw.createBackup();
    await storage.put("backup", JSON.stringify(backup));
  } catch (err) {
    console.warn("[backup] Failed to backup workspace:", err);
  }
}

/**
 * Restore the last workspace backup from DO storage.
 * Returns true if a backup was found and restored.
 */
export async function restoreWorkspace(
  sw: SandboxWorkspace,
  storage: DurableObjectStorage
): Promise<boolean> {
  try {
    const raw = await storage.get<string>("backup");
    if (raw) {
      const backup = JSON.parse(raw) as DirectoryBackup;
      await sw.restoreBackup(backup);
      return true;
    }
  } catch (err) {
    console.warn("[backup] Failed to restore backup:", err);
  }
  return false;
}
