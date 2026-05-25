import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";

const WINDOWS_RENAME_CONFLICT_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

export async function replaceFileCrossPlatform(tempPath: string, finalPath: string): Promise<void> {
  try {
    await rename(tempPath, finalPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !WINDOWS_RENAME_CONFLICT_ERROR_CODES.has(code)) {
      throw error;
    }
  }

  const backupPath = `${finalPath}.${randomUUID()}.bak`;
  let backupCreated = false;
  try {
    try {
      await rename(finalPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tempPath, finalPath);
  } catch (error) {
    if (backupCreated) {
      try { await rename(backupPath, finalPath); } catch { /* best effort */ }
    }
    await rm(tempPath, { force: true });
    throw error;
  }
  if (backupCreated) {
    try { await rm(backupPath, { force: true }); } catch { /* best effort */ }
  }
}
