import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

/**
 * Canonical confinement for an existing directory used as an execution root.
 *
 * The ordinary path helper is intentionally lexical because it also resolves
 * not-yet-created file destinations. A process working directory already
 * exists, so following both it and the configured roots through realpath closes
 * the directory-symlink escape without changing file-creation semantics.
 */
export function assertAllowedDirectory(path: string, allowedRoots: string[]): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(resolve(expandHomePath(path)));
    if (!statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AccessDeniedError(`Path is not an existing directory: ${path}`);
  }

  const canonicalRoots = allowedRoots.flatMap((root) => {
    try {
      const canonicalRoot = realpathSync(resolve(expandHomePath(root)));
      return statSync(canonicalRoot).isDirectory() ? [canonicalRoot] : [];
    } catch {
      return [];
    }
  });
  if (canonicalRoots.some((root) => isPathInsideRoot(canonicalPath, root))) {
    return canonicalPath;
  }
  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

export function allowedRootsRevision(allowedRoots: string[]): string {
  return createHash("sha256")
    .update([...allowedRoots].sort().join("\0"))
    .digest("hex")
    .slice(0, 16);
}
