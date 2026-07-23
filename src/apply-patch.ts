import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { readFileVersion, type FileVersion } from "./file-version.js";

export type PatchOperation = "add" | "update" | "delete" | "move";

export interface AppliedPatchFile {
  path: string;
  previousPath?: string;
  operation: PatchOperation;
  observedBefore: FileVersion | null;
  observedAfter: FileVersion | null;
  /** Prior version of a distinct move destination; undefined when not a move. */
  overwrittenBefore?: FileVersion | null;
}

export interface ApplyPatchResult {
  files: AppliedPatchFile[];
  patch: string;
  additions: number;
  removals: number;
}

export interface ApplyPatchOptions {
  ifMatch?: Readonly<Record<string, FileVersionPrecondition>>;
  commitOperations?: PatchCommitOperations;
}

export interface PatchCommitOperations {
  rename(source: string, destination: string): Promise<void>;
}

export type FileVersionPrecondition =
  | string
  | { hash: string; mtimeNs?: string }
  | null;

export class FileVersionConflictError extends Error {
  constructor(
    readonly path: string,
    readonly expected: FileVersionPrecondition,
    readonly actual: FileVersion | null,
  ) {
    super(`File version conflict for ${path}`);
    this.name = "FileVersionConflictError";
  }
}

export class InvalidPatchError extends Error {
  readonly code = "invalid_patch";

  constructor(
    readonly publicText: string,
    readonly path?: string,
  ) {
    super(`Invalid patch: ${publicText}`);
    this.name = "InvalidPatchError";
  }
}

export interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface UpdateHunk {
  lines: HunkLine[];
  changeContext?: string;
  endOfFile?: boolean;
}

export type PatchAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: UpdateHunk[] };

export interface PreparedPatch {
  readonly actions: readonly PatchAction[];
  readonly paths: readonly string[];
}

interface TextFile {
  content: string;
  mode?: number;
}

type StagedTextFile = TextFile | null;
interface TransactionEntry {
  destination: string;
  file: StagedTextFile;
  validation: DestinationValidation;
  replacement?: string;
}

interface CommitRecord {
  destination: string;
  destinationExisted: boolean;
  backup?: string;
}

type FileIdentity = Pick<Stats, "dev" | "ino">;
type FileIdentityReader = (path: string) => Promise<FileIdentity>;

interface ParentValidation {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

interface DestinationValidation {
  displayPath: string;
  identity: FileIdentity | null;
  observedVersion: FileVersion | null;
  expectedVersion: FileVersionPrecondition;
  parent: ParentValidation;
}

function patchError(message: string, path?: string): InvalidPatchError {
  const publicPath = path !== undefined && isPublicRelativePath(path) ? path : undefined;
  const publicText = path && !publicPath
    ? message.split(path).join("the provided path")
    : message;
  return new InvalidPatchError(publicText, publicPath);
}

export function parsePatch(patch: string): PatchAction[] {
  const lines = patchLines(patch);
  if (lines.shift()?.trim() !== "*** Begin Patch") {
    throw patchError("missing *** Begin Patch marker");
  }
  if (lines.pop()?.trim() !== "*** End Patch") {
    throw patchError("missing *** End Patch marker");
  }

  const actions: PatchAction[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index++].trim();
    if (header === "") continue;

    if (header.startsWith("*** Environment ID: ")) {
      if (!header.slice("*** Environment ID: ".length).trim()) {
        throw patchError("environment id cannot be empty");
      }
      continue;
    }

    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      const content: string[] = [];
      while (index < lines.length && !isTopLevelHeader(lines[index])) {
        const line = lines[index++];
        if (!line.startsWith("+")) {
          throw patchError(`added file lines must start with +: ${path}`, path);
        }
        content.push(line.slice(1));
      }
      if (content.length === 0) throw patchError(`add file has no content: ${path}`, path);
      actions.push({
        kind: "add",
        path,
        content: `${content.join("\n")}\n`,
      });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      actions.push({ kind: "delete", path: header.slice("*** Delete File: ".length) });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length);
      let moveTo: string | undefined;
      const hunks: UpdateHunk[] = [];

      if (lines[index]?.trim().startsWith("*** Move to: ")) {
        moveTo = lines[index++].trim().slice("*** Move to: ".length);
      }

      let current: UpdateHunk | undefined;
      const finishCurrent = (): void => {
        if (!current) return;
        if (current.lines.length === 0) throw patchError(`update hunk is empty: ${path}`, path);
        hunks.push(current);
        current = undefined;
      };

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!current && trimmed === "") {
          index++;
          continue;
        }
        if (trimmed === "*** End of File") {
          if (!current) throw patchError(`end-of-file marker has no update hunk: ${path}`, path);
          current.endOfFile = true;
          index++;
          continue;
        }

        if ((!current || !line.startsWith(" ")) && isTopLevelHeader(line)) break;

        if (trimmed.startsWith("@@") && !line.startsWith(" ")) {
          finishCurrent();
          const changeContext = trimmed.slice(2).trim();
          current = { lines: [], changeContext: changeContext || undefined };
          index++;
          continue;
        }

        current ??= { lines: [] };
        index++;
        if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) });
        else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
        else if (line.startsWith("-")) current.lines.push({ kind: "remove", text: line.slice(1) });
        else if (line === "\\ No newline at end of file") continue;
        else throw patchError(`hunk lines must start with space, +, or -: ${path}`, path);
      }
      finishCurrent();

      if (hunks.length === 0 && !moveTo) {
        throw patchError(`update has no hunks or move destination: ${path}`, path);
      }
      actions.push({ kind: "update", path, moveTo, hunks });
      continue;
    }

    throw patchError("unknown action header; use *** Add File, *** Delete File, or *** Update File");
  }

  if (actions.length === 0) throw patchError("contains no file actions");
  return actions;
}

export function preparePatch(patch: string): PreparedPatch {
  const actions = parsePatch(patch);
  return {
    actions,
    paths: actions.flatMap((action) =>
      action.kind === "update" && action.moveTo
        ? [action.path, action.moveTo]
        : [action.path],
    ),
  };
}

function patchLines(patch: string): string[] {
  let lines = patch.replace(/\r\n/g, "\n").trim().split("\n");
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last?.endsWith("EOF") &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  return lines;
}

function isTopLevelHeader(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("*** Add File: ") ||
    trimmed.startsWith("*** Delete File: ") ||
    trimmed.startsWith("*** Update File: ") ||
    trimmed.startsWith("*** Environment ID: ")
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isPublicRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || isAbsolute(path)) return false;
  const syntheticRoot = resolve("/", "__devspace_patch_root__");
  return isInside(syntheticRoot, resolve(syntheticRoot, path));
}

async function resolveConfinedPath(rootPath: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || isAbsolute(input)) {
    throw patchError("path must be relative to the workspace and non-empty");
  }

  const target = resolve(rootPath, input);
  if (!isInside(rootPath, target)) {
    throw patchError(`path escapes the workspace: ${input}`, input);
  }

  let existing = target;
  while (true) {
    try {
      const resolved = await realpath(existing);
      if (!isInside(rootPath, resolved)) {
        throw patchError(`path resolves outside the workspace through a symbolic link: ${input}`, input);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  return target;
}

function splitFile(content: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function findSequence(haystack: string[], needle: string[], from: number, endOfFile = false): number {
  if (needle.length === 0) return from;

  const matchAt = (index: number, normalize: (value: string) => string): boolean =>
    needle.every((line, offset) => normalize(haystack[index + offset] ?? "") === normalize(line));

  for (const normalize of [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
  ]) {
    const start = endOfFile ? haystack.length - needle.length : from;
    const end = haystack.length - needle.length;
    for (let index = start; index <= end; index += 1) {
      if (index >= from && matchAt(index, normalize)) return index;
    }
  }

  return -1;
}

function applyHunks(path: string, content: string, hunks: UpdateHunk[]): string {
  const file = splitFile(content);
  const lines = [...file.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.changeContext) {
      const contextIndex = findSequence(lines, [hunk.changeContext], cursor);
      if (contextIndex < 0) {
        throw patchError(`could not find hunk context in ${path}; read the file and regenerate the patch`, path);
      }
      cursor = contextIndex + 1;
    }

    const oldLines = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);
    const index = hunk.endOfFile && oldLines.length === 0
      ? lines.length
      : findSequence(lines, oldLines, cursor, hunk.endOfFile);

    if (index < 0) {
      throw patchError(`could not find hunk context in ${path}; read the file and regenerate the patch`, path);
    }

    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }

  const normalized = `${lines.join("\n")}\n`;
  return file.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function replaceFile(
  temporary: string,
  destination: string,
  destinationExists: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32" || !destinationExists) {
    await rename(temporary, destination);
    return;
  }

  const backup = `${temporary}.original`;
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rename(backup, destination);
    throw error;
  }
  await rm(backup, { force: true });
}

export async function isSamePatchFile(
  source: string,
  destination: string,
  readIdentity: FileIdentityReader = lstat,
): Promise<boolean> {
  if (source === destination) return true;
  if (source.toLowerCase() !== destination.toLowerCase()) return false;

  try {
    const [sourceIdentity, destinationIdentity] = await Promise.all([
      readIdentity(source),
      readIdentity(destination),
    ]);
    return sourceIdentity.dev === destinationIdentity.dev && sourceIdentity.ino === destinationIdentity.ino;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function applyPatch(
  root: string,
  patch: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  return applyPreparedPatch(root, preparePatch(patch), options);
}

export async function applyPreparedPatch(
  root: string,
  prepared: PreparedPatch,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  const rootPath = await realpath(root);
  const results: AppliedPatchFile[] = [];
  const patches: string[] = [];
  const staged = new Map<string, StagedTextFile>();
  const touched = new Map<string, string>();

  const resolveTouchedPath = async (path: string): Promise<string> => {
    const absolute = await resolveConfinedPath(rootPath, path);
    touched.set(absolute, path);
    return absolute;
  };

  const readStagedOptional = async (absolute: string, displayPath: string): Promise<StagedTextFile> => {
    if (staged.has(absolute)) return staged.get(absolute) ?? null;
    const file = await readOptionalTextFile(absolute, displayPath);
    staged.set(absolute, file);
    return file;
  };

  const readStagedRequired = async (absolute: string, displayPath: string): Promise<TextFile> => {
    const file = await readStagedOptional(absolute, displayPath);
    if (!file) throw patchError(`file does not exist: ${displayPath}`, displayPath);
    return file;
  };

  for (const action of prepared.actions) {
    if (action.kind === "add") {
      const absolute = await resolveTouchedPath(action.path);
      const original = await readStagedOptional(absolute, action.path);
      staged.set(absolute, { content: action.content, mode: original?.mode });
      patches.push(unifiedFilePatch(action.path, action.path, original?.content ?? null, action.content));
      results.push({
        path: action.path,
        operation: original ? "update" : "add",
        observedBefore: null,
        observedAfter: null,
      });
      continue;
    }

    const absolute = await resolveTouchedPath(action.path);
    const file = await readStagedRequired(absolute, action.path);

    if (action.kind === "delete") {
      staged.set(absolute, null);
      patches.push(unifiedFilePatch(action.path, action.path, file.content, null));
      results.push({
        path: action.path,
        operation: "delete",
        observedBefore: null,
        observedAfter: null,
      });
      continue;
    }

    const updated = applyHunks(action.path, file.content, action.hunks);
    if (action.moveTo) {
      const destination = await resolveTouchedPath(action.moveTo);
      const samePatchFile = await isSamePatchFile(absolute, destination);
      if (!samePatchFile) await readStagedOptional(destination, action.moveTo);
      if (samePatchFile) staged.delete(absolute);
      staged.set(destination, { content: updated, mode: file.mode });
      if (!samePatchFile) staged.set(absolute, null);
      patches.push(unifiedFilePatch(action.path, action.moveTo, file.content, updated));
      results.push({
        path: action.moveTo,
        previousPath: action.path,
        operation: "move",
        observedBefore: null,
        observedAfter: null,
        ...(!samePatchFile ? { overwrittenBefore: null } : {}),
      });
    } else {
      staged.set(absolute, { content: updated, mode: file.mode });
      patches.push(unifiedFilePatch(action.path, action.path, file.content, updated));
      results.push({
        path: action.path,
        operation: "update",
        observedBefore: null,
        observedAfter: null,
      });
    }
  }

  const validations = await validateCommitDestinations(rootPath, options.ifMatch, touched);
  await commitPatchTransaction(
    rootPath,
    staged,
    validations,
    options.commitOperations?.rename ?? rename,
  );
  const observedFiles = await observeAppliedFiles(rootPath, results, validations);

  const unifiedPatch = patches.filter(Boolean).join("\n");
  const stats = countPatchStats(unifiedPatch);
  return { files: observedFiles, patch: unifiedPatch, ...stats };
}

async function observeAppliedFiles(
  rootPath: string,
  files: readonly AppliedPatchFile[],
  validations: ReadonlyMap<string, DestinationValidation>,
): Promise<AppliedPatchFile[]> {
  return Promise.all(files.map(async (file) => {
    const beforePath = await resolveConfinedPath(rootPath, file.previousPath ?? file.path);
    const before = validations.get(beforePath);
    if (!before) throw new Error(`Missing patch observation: ${file.previousPath ?? file.path}`);

    const afterPath = await resolveConfinedPath(rootPath, file.path);
    const destinationBefore = file.previousPath !== undefined && afterPath !== beforePath
      ? validations.get(afterPath)
      : undefined;
    if (file.previousPath !== undefined && afterPath !== beforePath && !destinationBefore) {
      throw new Error(`Missing patch destination observation: ${file.path}`);
    }
    return {
      path: file.path,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      operation: file.operation,
      observedBefore: before.observedVersion,
      observedAfter: await readFileVersion(afterPath),
      ...(file.previousPath !== undefined && afterPath !== beforePath
        ? { overwrittenBefore: destinationBefore!.observedVersion }
        : {}),
    };
  }));
}

async function validateCommitDestinations(
  rootPath: string,
  ifMatch: ApplyPatchOptions["ifMatch"],
  touched: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, DestinationValidation>> {
  const preconditions = new Map<
    string,
    { path: string; expected: FileVersionPrecondition }
  >();

  for (const [path, expected] of Object.entries(ifMatch ?? {})) {
    const absolute = await resolveConfinedPath(rootPath, path);
    assertFilePrecondition(path, expected);
    if (!touched.has(absolute)) {
      throw patchError(`precondition path is not touched by the patch: ${path}`, path);
    }
    preconditions.set(absolute, { path, expected });
  }

  const validations = new Map<string, DestinationValidation>();
  for (const [absolute, displayPath] of touched) {
    const snapshot = await readDestinationSnapshot(absolute);
    const precondition = preconditions.get(absolute);

    if (precondition && !sameFileVersion(precondition.expected, snapshot.version)) {
      throw new FileVersionConflictError(
        precondition.path,
        precondition.expected,
        snapshot.version,
      );
    }

    validations.set(absolute, {
      displayPath,
      identity: snapshot.identity,
      observedVersion: snapshot.version,
      expectedVersion: precondition?.expected ?? snapshot.version,
      parent: await captureExistingParent(rootPath, dirname(absolute), displayPath),
    });
  }

  return validations;
}

function assertFilePrecondition(path: string, version: FileVersionPrecondition): void {
  if (version === null) return;
  if (typeof version === "string") {
    if (/^sha256:[0-9a-f]{64}$/.test(version)) return;
    throw patchError(`invalid file version precondition for ${path}`, path);
  }
  if (
    typeof version !== "object" ||
    !/^sha256:[0-9a-f]{64}$/.test(version.hash) ||
    (version.mtimeNs !== undefined && !/^-?\d+$/.test(version.mtimeNs))
  ) {
    throw patchError(`invalid file version precondition for ${path}`, path);
  }
}

function sameFileVersion(expected: FileVersionPrecondition, actual: FileVersion | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (typeof expected === "string") return expected === actual.hash;
  return (
    expected.hash === actual.hash &&
    (expected.mtimeNs === undefined || expected.mtimeNs === actual.mtimeNs)
  );
}

async function readOptionalTextFile(absolute: string, displayPath: string): Promise<TextFile | null> {
  if (!(await fileExists(absolute))) return null;
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw patchError(`path is not a regular file: ${displayPath}`, displayPath);
  return { content: await readUtf8Text(absolute, displayPath), mode: metadata.mode };
}

async function readUtf8Text(absolute: string, displayPath: string): Promise<string> {
  const bytes = await readFile(absolute);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw patchError(`file is not valid UTF-8 text: ${displayPath}`, displayPath);
  }
  if (content.includes("\0")) throw patchError(`file appears to be binary: ${displayPath}`, displayPath);
  return content;
}

async function commitPatchTransaction(
  rootPath: string,
  staged: ReadonlyMap<string, StagedTextFile>,
  validations: ReadonlyMap<string, DestinationValidation>,
  renameFile: PatchCommitOperations["rename"],
): Promise<void> {
  const transactionRoot = resolve(
    rootPath,
    `.devspace-patch-${process.pid}-${randomUUID()}`,
  );
  const entries: TransactionEntry[] = [];
  const committed: CommitRecord[] = [];
  const createdDirectories: string[] = [];
  let cleanupTransaction = true;

  await mkdir(transactionRoot);
  try {
    let index = 0;
    for (const [destination, file] of staged) {
      const validation = validations.get(destination);
      if (!validation) throw new Error(`Missing patch destination validation: ${destination}`);
      const replacement = file
        ? resolve(transactionRoot, `replacement-${index}`)
        : undefined;
      if (file && replacement) {
        await writeFile(
          replacement,
          file.content,
          file.mode === undefined ? undefined : { mode: file.mode },
        );
      }
      entries.push({ destination, file, validation, replacement });
      index += 1;
    }

    try {
      for (const [entryIndex, entry] of entries.entries()) {
        await ensureDestinationParent(entry.destination, rootPath, createdDirectories);
        const parentIdentity = await revalidateDestinationParent(
          rootPath,
          entry.destination,
          entry.validation,
        );
        await revalidateDestination(entry.destination, entry.validation);
        const destinationExisted = entry.validation.identity !== null;
        const backup = destinationExisted
          ? resolve(transactionRoot, `backup-${entryIndex}`)
          : undefined;
        committed.push({
          destination: entry.destination,
          destinationExisted,
          backup,
        });

        if (backup) {
          await revalidateDestinationParent(
            rootPath,
            entry.destination,
            entry.validation,
            parentIdentity,
          );
          await revalidateDestination(entry.destination, entry.validation);
          await renameFile(entry.destination, backup);
        }
        if (entry.file && entry.replacement) {
          await revalidateDestinationParent(
            rootPath,
            entry.destination,
            entry.validation,
            parentIdentity,
          );
          await revalidateDestination(entry.destination, {
            ...entry.validation,
            identity: null,
            expectedVersion: null,
          });
          await renameFile(entry.replacement, entry.destination);
        }
      }
    } catch (error) {
      const rollbackErrors = await rollbackPatchCommit(
        committed,
        createdDirectories,
        renameFile,
      );
      if (rollbackErrors.length > 0) {
        cleanupTransaction = false;
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Patch commit failed and rollback was incomplete",
        );
      }
      throw error;
    }
  } finally {
    if (cleanupTransaction) {
      await rm(transactionRoot, { recursive: true, force: true });
    }
  }
}

async function captureExistingParent(
  rootPath: string,
  parent: string,
  displayPath: string,
): Promise<ParentValidation> {
  let current = parent;
  while (isInside(rootPath, current)) {
    try {
      const canonicalPath = await realpath(current);
      if (!isInside(rootPath, canonicalPath)) {
        throw patchError(
          `destination parent resolves outside the workspace: ${displayPath}`,
          displayPath,
        );
      }
      const metadata = await stat(canonicalPath);
      if (!metadata.isDirectory()) {
        throw patchError(`destination parent is not a directory: ${displayPath}`, displayPath);
      }
      return {
        path: current,
        canonicalPath,
        identity: metadata,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      if (current === rootPath) throw error;
      current = dirname(current);
    }
  }

  throw patchError(`destination parent escapes the workspace: ${displayPath}`, displayPath);
}

async function revalidateDestinationParent(
  rootPath: string,
  destination: string,
  validation: DestinationValidation,
  expectedDirectIdentity?: FileIdentity,
): Promise<FileIdentity> {
  const parent = dirname(destination);
  let canonicalParent: string;
  let directMetadata: Stats;
  let anchorCanonical: string;
  let anchorMetadata: Stats;
  try {
    canonicalParent = await realpath(parent);
    anchorCanonical = await realpath(validation.parent.path);
    [directMetadata, anchorMetadata] = await Promise.all([
      stat(canonicalParent),
      stat(anchorCanonical),
    ]);
  } catch {
    throw patchError(
      `destination parent changed during patch commit: ${validation.displayPath}`,
      validation.displayPath,
    );
  }

  if (
    !isInside(rootPath, canonicalParent) ||
    !directMetadata.isDirectory() ||
    anchorCanonical !== validation.parent.canonicalPath ||
    !sameFileIdentity(anchorMetadata, validation.parent.identity) ||
    (expectedDirectIdentity !== undefined &&
      !sameFileIdentity(directMetadata, expectedDirectIdentity))
  ) {
    throw patchError(
      `destination parent changed during patch commit: ${validation.displayPath}`,
      validation.displayPath,
    );
  }

  return directMetadata;
}

async function revalidateDestination(
  destination: string,
  validation: DestinationValidation,
): Promise<void> {
  const snapshot = await readDestinationSnapshot(destination);
  if (
    !sameOptionalFileIdentity(snapshot.identity, validation.identity) ||
    !sameFileVersion(validation.expectedVersion, snapshot.version)
  ) {
    throw new FileVersionConflictError(
      validation.displayPath,
      validation.expectedVersion,
      snapshot.version,
    );
  }
}

async function readDestinationSnapshot(
  path: string,
): Promise<{ identity: FileIdentity | null; version: FileVersion | null }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readOptionalFileIdentity(path);
    const version = await readFileVersion(path);
    const after = await readOptionalFileIdentity(path);
    if (sameOptionalFileIdentity(before, after)) return { identity: after, version };
  }

  throw new Error("Patch destination changed while it was being validated");
}

async function readOptionalFileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function sameOptionalFileIdentity(
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sameFileIdentity(left, right);
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function ensureDestinationParent(
  destination: string,
  rootPath: string,
  createdDirectories: string[],
): Promise<void> {
  const parent = dirname(destination);
  const missing: string[] = [];
  let current = parent;

  while (current !== rootPath && isInside(rootPath, current)) {
    try {
      const metadata = await stat(current);
      if (!metadata.isDirectory()) {
        throw new Error(`Patch destination parent is not a directory: ${current}`);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      missing.push(current);
      current = dirname(current);
    }
  }

  if (missing.length === 0) return;
  createdDirectories.push(...missing);
  await mkdir(parent, { recursive: true });
}

async function rollbackPatchCommit(
  committed: readonly CommitRecord[],
  createdDirectories: readonly string[],
  renameFile: PatchCommitOperations["rename"],
): Promise<unknown[]> {
  const errors: unknown[] = [];

  for (const record of [...committed].reverse()) {
    try {
      if (record.backup && await pathExists(record.backup)) {
        await rm(record.destination, { force: true });
        await renameFile(record.backup, record.destination);
      } else if (!record.destinationExisted) {
        await rm(record.destination, { force: true });
      }
    } catch (error) {
      errors.push(error);
    }
  }

  for (const directory of createdDirectories) {
    try {
      await rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        errors.push(error);
      }
    }
  }

  return errors;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function unifiedFilePatch(
  oldPath: string,
  newPath: string,
  oldContent: string | null,
  newContent: string | null,
): string {
  const oldFileName = oldContent === null ? "/dev/null" : `a/${oldPath}`;
  const newFileName = newContent === null ? "/dev/null" : `b/${newPath}`;
  const body = createTwoFilesPatch(
    oldFileName,
    newFileName,
    oldContent ?? "",
    newContent ?? "",
    "",
    "",
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  );

  return [
    `diff --git a/${oldPath} b/${newPath}`,
    oldContent === null ? "new file mode 100644" : undefined,
    newContent === null ? "deleted file mode 100644" : undefined,
    stripFinalNewline(body),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function stripFinalNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function countPatchStats(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}
