import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(resolve(projectRoot, "package.json"));
  const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
  for (const architecture of ["arm64", "x64"]) {
    const helper = resolve(
      nodePtyRoot,
      "prebuilds",
      `darwin-${architecture}`,
      "spawn-helper",
    );
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
