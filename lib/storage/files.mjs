import { promises as fs } from "node:fs";
import path from "node:path";

export async function measurePath(targetPath) {
  let bytes = 0;
  let fileCount = 0;
  const pending = [path.resolve(targetPath)];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    let stats;

    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      const entries = await fs.readdir(currentPath);

      for (const entry of entries) {
        pending.push(path.join(currentPath, entry));
      }

      continue;
    }

    if (stats.isFile()) {
      bytes += stats.size;
      fileCount += 1;
    }
  }

  return { bytes, fileCount };
}
