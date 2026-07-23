import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export type SkillSource =
  | "repo"
  | "user"
  | "admin"
  | "bundled"
  | "devspace"
  | "agent-dir"
  | "explicit";

export type SkillScope = "repo" | "user" | "admin" | "bundled" | "compatibility";

export interface SkillRoot {
  path: string;
  source: SkillSource;
  scope: SkillScope;
  /** Canonical boundary that untrusted repository discovery must not escape. */
  boundary?: string;
}

export interface Skill {
  /** Stable identity derived from the canonical SKILL.md path. */
  skillId: string;
  /** Content identity captured during validated discovery. */
  manifestHash: string;
  /** Invocation policy and metadata identity captured during discovery. */
  openAiMetadataHash?: string;
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  scope: SkillScope;
  sourceRoot: string;
  allowImplicitInvocation: boolean;
  disableModelInvocation: boolean;
  openai?: Record<string, unknown>;
  /** Pi-compatible provenance retained while downstream integrations migrate. */
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "top-level";
    baseDir: string;
  };
}

export interface SkillDiagnostic {
  type: "warning" | "error";
  message: string;
  path?: string;
}

export class SkillUriError extends Error {
  constructor(
    readonly code: "skill_path_invalid" | "skill_not_found",
    readonly publicText: string,
  ) {
    super(publicText);
    this.name = "SkillUriError";
  }
}

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export const SKILL_DISCOVERY_LIMITS = Object.freeze({
  maxDepth: 16,
  maxDirectories: 2_048,
  maxEntries: 16_384,
  maxDiagnostics: 100,
  maxSkillBytes: 65_536,
  maxOpenAiYamlBytes: 262_144,
});

const SUBAGENT_DELEGATION_NAME = "subagent-delegation";
const SKILL_MANIFEST = "SKILL.md";

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function findRepositoryRoot(workspaceRoot: string, boundaryRoot: string): string {
  let current = realpathSync(workspaceRoot);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === boundaryRoot) return boundaryRoot;
    const parent = dirname(current);
    if (parent === current || !isPathInsideRoot(parent, boundaryRoot)) {
      return boundaryRoot;
    }
    current = parent;
  }
}

function repositorySkillRoots(workspaceRoot: string, allowedRoots: readonly string[]): SkillRoot[] {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const containingAllowedRoots = allowedRoots
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return undefined;
      }
    })
    .filter((root): root is string => Boolean(root && isPathInsideRoot(canonicalWorkspace, root)))
    .sort((left, right) => right.length - left.length);
  const boundaryRoot = containingAllowedRoots[0] ?? canonicalWorkspace;
  const repositoryRoot = findRepositoryRoot(canonicalWorkspace, boundaryRoot);
  const relationship = relative(repositoryRoot, canonicalWorkspace);
  if (relationship.startsWith("..") || isAbsolute(relationship)) return [];

  const ancestors = [repositoryRoot];
  let current = repositoryRoot;
  for (const segment of relationship.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ancestors.push(current);
  }
  return ancestors.map((ancestor) => ({
    path: join(ancestor, ".agents", "skills"),
    source: "repo",
    scope: "repo",
    boundary: repositoryRoot,
  }));
}

/** Resolves configured skill roots relative to the opened workspace, never process.cwd(). */
export function resolveSkillPath(path: string, workspaceRoot: string): string {
  return resolve(workspaceRoot, expandHomePath(path));
}

export function effectiveSkillSources(config: ServerConfig, workspaceRoot: string): SkillRoot[] {
  const candidates: SkillRoot[] = [
    ...repositorySkillRoots(workspaceRoot, config.allowedRoots),
    { path: join(homedir(), ".agents", "skills"), source: "user", scope: "user" },
    { path: config.adminSkillsDir, source: "admin", scope: "admin" },
    { path: bundledSkillsDir(), source: "bundled", scope: "bundled" },
    { path: config.devspaceSkillsDir, source: "devspace", scope: "compatibility" },
    { path: join(config.agentDir, "skills"), source: "agent-dir", scope: "compatibility" },
    ...config.skillPaths.map((path) => ({
      path,
      source: "explicit" as const,
      scope: "compatibility" as const,
    })),
  ];

  const seen = new Set<string>();
  return candidates
    .map((candidate) => ({
      ...candidate,
      path: resolveSkillPath(candidate.path, workspaceRoot),
    }))
    .filter((candidate) => {
      if (seen.has(candidate.path)) return false;
      seen.add(candidate.path);
      return true;
    });
}

/** Compatibility view for callers that only need the existing roots. */
export function effectiveSkillPaths(config: ServerConfig, workspaceRoot: string): string[] {
  return effectiveSkillSources(config, workspaceRoot)
    .map((source) => source.path)
    .filter((path) => existsSync(path));
}

class DiagnosticCollector {
  readonly diagnostics: SkillDiagnostic[] = [];
  private truncated = false;

  add(diagnostic: SkillDiagnostic): void {
    if (this.diagnostics.length < SKILL_DISCOVERY_LIMITS.maxDiagnostics - 1) {
      this.diagnostics.push(diagnostic);
    } else {
      this.truncated = true;
    }
  }

  finish(): SkillDiagnostic[] {
    if (this.truncated) {
      this.diagnostics.push({
        type: "warning",
        message: "Additional skill diagnostics were omitted because the diagnostic limit was reached.",
      });
    }
    return this.diagnostics;
  }
}

function yamlObject(text: string): Record<string, unknown> {
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("invalid YAML");
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("YAML document must be a mapping");
  }
  return value as Record<string, unknown>;
}

function parseFrontmatter(
  filePath: string,
  diagnostics: DiagnosticCollector,
): { metadata: Record<string, unknown>; contents: string } | undefined {
  let contents: string;
  try {
    if (statSync(filePath).size > SKILL_DISCOVERY_LIMITS.maxSkillBytes) {
      diagnostics.add({ type: "error", path: filePath, message: "Skill manifest exceeds the size limit." });
      return undefined;
    }
    contents = readFileSync(filePath, "utf8");
  } catch {
    diagnostics.add({ type: "error", path: filePath, message: "Skill manifest could not be read." });
    return undefined;
  }

  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    diagnostics.add({ type: "error", path: filePath, message: "Skill manifest must begin with YAML frontmatter." });
    return undefined;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    diagnostics.add({ type: "error", path: filePath, message: "Skill manifest has unterminated YAML frontmatter." });
    return undefined;
  }

  try {
    return {
      metadata: yamlObject(lines.slice(1, end).join("\n")),
      contents,
    };
  } catch {
    diagnostics.add({ type: "error", path: filePath, message: "Skill manifest contains invalid YAML frontmatter." });
    return undefined;
  }
}

type OpenAiMetadataSnapshot =
  | { kind: "absent" }
  | { kind: "file"; contents: string }
  | { kind: "outside"; canonicalPath: string }
  | { kind: "not-file"; canonicalPath: string }
  | { kind: "oversized"; canonicalPath: string; fingerprint: string }
  | { kind: "unreadable" };

function openAiMetadataSnapshot(baseDir: string): OpenAiMetadataSnapshot {
  const configuredPath = join(baseDir, "agents", "openai.yaml");
  try {
    lstatSync(configuredPath);
  } catch {
    return { kind: "absent" };
  }

  try {
    const canonicalPath = realpathSync(configuredPath);
    if (!isPathInsideRoot(canonicalPath, baseDir)) {
      return { kind: "outside", canonicalPath };
    }
    const metadata = statSync(canonicalPath);
    if (!metadata.isFile()) return { kind: "not-file", canonicalPath };
    if (metadata.size > SKILL_DISCOVERY_LIMITS.maxOpenAiYamlBytes) {
      return {
        kind: "oversized",
        canonicalPath,
        fingerprint: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`,
      };
    }
    return { kind: "file", contents: readFileSync(canonicalPath, "utf8") };
  } catch {
    return { kind: "unreadable" };
  }
}

function hashOpenAiMetadataSnapshot(snapshot: OpenAiMetadataSnapshot): string {
  const hash = createHash("sha256").update(snapshot.kind).update("\0");
  if (snapshot.kind === "file") hash.update(snapshot.contents);
  if (snapshot.kind === "outside" || snapshot.kind === "not-file") {
    hash.update(snapshot.canonicalPath);
  }
  if (snapshot.kind === "oversized") {
    hash.update(snapshot.canonicalPath).update("\0").update(snapshot.fingerprint);
  }
  return hash.digest("hex");
}

/** Returns the policy/metadata identity used to lock a discovered Skill. */
export function computeSkillOpenAiMetadataHash(baseDir: string): string {
  return hashOpenAiMetadataSnapshot(openAiMetadataSnapshot(baseDir));
}

function readOpenAiMetadata(
  baseDir: string,
  diagnostics: DiagnosticCollector,
): {
  metadata?: Record<string, unknown>;
  metadataHash: string;
  allowImplicitInvocation: boolean;
} {
  const configuredPath = join(baseDir, "agents", "openai.yaml");
  const snapshot = openAiMetadataSnapshot(baseDir);
  const metadataHash = hashOpenAiMetadataSnapshot(snapshot);
  if (snapshot.kind === "absent") {
    return { metadataHash, allowImplicitInvocation: true };
  }
  if (snapshot.kind !== "file") {
    const message = snapshot.kind === "oversized"
      ? "Skill OpenAI metadata exceeds the size limit."
      : snapshot.kind === "outside" || snapshot.kind === "not-file"
        ? "Skill OpenAI metadata is outside the skill directory or is not a file."
        : "Skill OpenAI metadata could not be read; implicit invocation is disabled.";
    diagnostics.add({ type: "warning", path: configuredPath, message });
    return { metadataHash, allowImplicitInvocation: false };
  }

  try {
    const metadata = yamlObject(snapshot.contents);
    const policy = metadata.policy;
    let allowImplicitInvocation = true;
    if (policy !== undefined) {
      if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
        throw new Error("policy must be a mapping");
      }
      const configured = (policy as Record<string, unknown>).allow_implicit_invocation;
      if (configured !== undefined && typeof configured !== "boolean") {
        throw new Error("allow_implicit_invocation must be boolean");
      }
      if (typeof configured === "boolean") allowImplicitInvocation = configured;
    }
    return { metadata, metadataHash, allowImplicitInvocation };
  } catch {
    diagnostics.add({ type: "warning", path: configuredPath, message: "Skill OpenAI metadata is invalid; implicit invocation is disabled." });
    return { metadataHash, allowImplicitInvocation: false };
  }
}

function canonicalDisabledSkillPaths(config: ServerConfig, workspaceRoot: string): Set<string> {
  const disabled = new Set<string>();
  for (const configuredPath of config.disabledSkillPaths) {
    const resolvedPath = resolveSkillPath(configuredPath, workspaceRoot);
    try {
      disabled.add(realpathSync(resolvedPath));
    } catch {
      disabled.add(resolvedPath);
    }
  }
  return disabled;
}

function loadSkill(
  filePath: string,
  source: SkillRoot,
  disabledPaths: Set<string>,
  diagnostics: DiagnosticCollector,
  expectedBaseDir?: string,
): Skill | undefined {
  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(filePath);
  } catch {
    diagnostics.add({ type: "error", path: filePath, message: "Skill manifest could not be resolved." });
    return undefined;
  }
  if (expectedBaseDir && dirname(canonicalFile) !== expectedBaseDir) {
    diagnostics.add({
      type: "error",
      path: filePath,
      message: "Skill manifest symlink escapes its discovered skill directory.",
    });
    return undefined;
  }
  if (disabledPaths.has(canonicalFile)) return undefined;

  const manifest = parseFrontmatter(canonicalFile, diagnostics);
  if (!manifest) return undefined;
  const frontmatter = manifest.metadata;
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name || !description) {
    diagnostics.add({
      type: "error",
      path: canonicalFile,
      message: "Skill manifest requires non-empty string name and description fields.",
    });
    return undefined;
  }

  const legacyDisable = frontmatter["disable-model-invocation"];
  if (legacyDisable !== undefined && typeof legacyDisable !== "boolean") {
    diagnostics.add({
      type: "error",
      path: canonicalFile,
      message: "Skill disable-model-invocation field must be boolean when present.",
    });
    return undefined;
  }

  const baseDir = dirname(canonicalFile);
  if (disabledPaths.has(baseDir)) return undefined;
  const openai = readOpenAiMetadata(baseDir, diagnostics);
  const sourceRoot = (() => {
    try {
      return realpathSync(source.path);
    } catch {
      return source.path;
    }
  })();
  const allowImplicitInvocation = openai.allowImplicitInvocation && legacyDisable !== true;
  return {
    skillId: `skill_${createHash("sha256").update(canonicalFile).digest("hex")}`,
    manifestHash: createHash("sha256").update(manifest.contents).digest("hex"),
    openAiMetadataHash: openai.metadataHash,
    name,
    description,
    filePath: canonicalFile,
    baseDir,
    source: source.source,
    scope: source.scope,
    sourceRoot,
    allowImplicitInvocation,
    disableModelInvocation: !allowImplicitInvocation,
    openai: openai.metadata,
    sourceInfo: {
      path: canonicalFile,
      source: source.source,
      scope: source.scope === "repo" ? "project" : "user",
      origin: "top-level",
      baseDir: sourceRoot,
    },
  };
}

export function loadWorkspaceSkills(config: ServerConfig, workspaceRoot: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const skills: Skill[] = [];
  const diagnostics = new DiagnosticCollector();
  const disabledPaths = canonicalDisabledSkillPaths(config, workspaceRoot);
  const visitedDirectories = new Set<string>();
  const visitedRoots = new Set<string>();
  let directoriesVisited = 0;
  let entriesVisited = 0;
  let traversalLimitReported = false;

  const reportTraversalLimit = () => {
    if (traversalLimitReported) return;
    traversalLimitReported = true;
    diagnostics.add({ type: "warning", message: "Skill discovery stopped after reaching its traversal limit." });
  };

  const visitDirectory = (
    directory: string,
    source: SkillRoot,
    canonicalRoot: string,
    depth: number,
    symlinkEntry: boolean,
  ): void => {
    if (depth > SKILL_DISCOVERY_LIMITS.maxDepth) {
      reportTraversalLimit();
      return;
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = realpathSync(directory);
      if (!statSync(canonicalDirectory).isDirectory()) return;
    } catch {
      return;
    }
    if (source.boundary && !isPathInsideRoot(canonicalDirectory, source.boundary)) {
      diagnostics.add({
        type: "error",
        path: directory,
        message: "Repository Skill symlink escapes the canonical repository or allowed-root boundary.",
      });
      return;
    }
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    directoriesVisited += 1;
    if (directoriesVisited > SKILL_DISCOVERY_LIMITS.maxDirectories) {
      reportTraversalLimit();
      return;
    }

    const manifest = join(canonicalDirectory, SKILL_MANIFEST);
    if (existsSync(manifest)) {
      const skill = loadSkill(
        manifest,
        source,
        disabledPaths,
        diagnostics,
        canonicalDirectory,
      );
      if (skill && (config.subagents || skill.name !== SUBAGENT_DELEGATION_NAME)) skills.push(skill);
      return;
    }

    // A linked child is allowed to represent one skill folder, but is never used
    // as a new recursive discovery root outside the configured canonical root.
    if (symlinkEntry || !isPathInsideRoot(canonicalDirectory, canonicalRoot)) return;

    let entries;
    try {
      entries = readdirSync(canonicalDirectory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      diagnostics.add({ type: "warning", path: canonicalDirectory, message: "Skill directory could not be read." });
      return;
    }

    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > SKILL_DISCOVERY_LIMITS.maxEntries) {
        reportTraversalLimit();
        return;
      }
      const entryPath = join(canonicalDirectory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(entryPath, source, canonicalRoot, depth + 1, false);
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(entryPath).isDirectory()) {
            visitDirectory(entryPath, source, canonicalRoot, depth + 1, true);
          }
        } catch {
          // Broken links are ignored; they are not valid skill folders.
        }
      }
    }
  };

  for (const source of effectiveSkillSources(config, workspaceRoot)) {
    let sourceStat;
    try {
      sourceStat = lstatSync(source.path);
    } catch {
      continue;
    }

    let sourceIsFile = sourceStat.isFile();
    if (sourceStat.isSymbolicLink()) {
      try {
        sourceIsFile = statSync(source.path).isFile();
      } catch {
        continue;
      }
    }
    if (sourceIsFile) {
      if (basename(source.path) === SKILL_MANIFEST) {
        const skill = loadSkill(source.path, source, disabledPaths, diagnostics);
        if (skill && (config.subagents || skill.name !== SUBAGENT_DELEGATION_NAME)) skills.push(skill);
      }
      continue;
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(source.path);
    } catch {
      continue;
    }
    if (visitedRoots.has(canonicalRoot)) continue;
    visitedRoots.add(canonicalRoot);
    visitDirectory(source.path, source, canonicalRoot, 0, false);
  }

  return { skills, diagnostics: diagnostics.finish() };
}

/** Resolves model-provided paths against the opened workspace, never process.cwd(). */
export function resolveSkillInputPath(inputPath: string, workspaceRoot: string): string {
  return resolve(workspaceRoot, expandHomePath(inputPath));
}

export function skillUriRoot(skillId: string): string {
  return `skill://${skillId}/`;
}

function parseSkillUri(inputPath: string): { skillId: string; relativePath: string } | undefined {
  if (!inputPath.startsWith("skill:")) return undefined;
  if (!inputPath.startsWith("skill://")) {
    throw new SkillUriError(
      "skill_path_invalid",
      "Use skill://<skillId>/<relative-path>.",
    );
  }

  const remainder = inputPath.slice("skill://".length);
  const separatorIndex = remainder.indexOf("/");
  const skillId = separatorIndex < 0 ? "" : remainder.slice(0, separatorIndex);
  const rawPath = separatorIndex < 0 ? "" : remainder.slice(separatorIndex + 1);
  if (!skillId || !rawPath || /[/?#%\\\0]/u.test(skillId) || /[?#\\\0]/u.test(rawPath)) {
    throw new SkillUriError(
      "skill_path_invalid",
      "Use skill://<skillId>/<relative-path> without query, fragment, or backslash components.",
    );
  }

  const decodedSegments = rawPath.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new SkillUriError("skill_path_invalid", "The Skill path contains invalid percent encoding.");
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new SkillUriError(
        "skill_path_invalid",
        "Skill paths cannot contain empty, dot, traversal, or encoded separator components.",
      );
    }
    return decoded;
  });

  return { skillId, relativePath: join(...decodedSegments) };
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
  workspaceRoot?: string,
): SkillReadResolution | undefined {
  const skillUri = parseSkillUri(inputPath);
  if (skillUri) {
    const skill = skills.find((candidate) => candidate.skillId === skillUri.skillId);
    if (!skill) {
      throw new SkillUriError(
        "skill_not_found",
        "The Skill is not available in this workspace; reopen the workspace and use its current skillId.",
      );
    }
    const absolutePath = resolve(skill.baseDir, skillUri.relativePath);
    if (!isPathInsideRoot(absolutePath, skill.baseDir)) {
      throw new SkillUriError("skill_path_invalid", "The Skill path escapes its Skill directory.");
    }
    return {
      absolutePath,
      skill,
      isSkillFile: absolutePath === resolve(skill.filePath),
    };
  }

  const expandedPath = expandHomePath(inputPath);
  if (!isAbsolute(expandedPath) && !workspaceRoot) return undefined;
  const absolutePath = isAbsolute(expandedPath)
    ? resolve(expandedPath)
    : resolveSkillInputPath(expandedPath, workspaceRoot!);

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;
    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(activatedSkillDirs: Set<string>, skill: Skill): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}
