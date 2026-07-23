import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export interface FileVersion {
  hash: string;
  mtimeNs: string;
}

const MAX_STABLE_READ_ATTEMPTS = 3;

export async function readFileVersion(path: string): Promise<FileVersion | null> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }

    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new Error("Cannot compute a file version for a non-regular file");
      }

      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        continue;
      }

      return {
        hash: `sha256:${hash.digest("hex")}`,
        mtimeNs: after.mtimeNs.toString(10),
      };
    } finally {
      await handle.close();
    }
  }

  throw new Error("File changed while its version was being computed");
}
