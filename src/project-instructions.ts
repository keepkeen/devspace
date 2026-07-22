import { basename } from "node:path";

export const MAX_PROJECT_DOC_FALLBACK_FILENAMES = 16;
export const MAX_PROJECT_DOC_FALLBACK_FILENAME_LENGTH = 128;

const BUILTIN_PROJECT_INSTRUCTION_FILENAMES = [
  "AGENTS.override.md",
  "AGENTS.override.MD",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

export function isValidProjectDocFallbackFilename(value: string): boolean {
  const filename = value.trim();
  return (
    filename.length > 0 &&
    filename.length <= MAX_PROJECT_DOC_FALLBACK_FILENAME_LENGTH &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("\0") &&
    basename(filename) === filename &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}

export function normalizeProjectDocFallbackFilenames(
  values: readonly string[] | undefined,
): string[] {
  if (!values) return [];
  if (values.length > MAX_PROJECT_DOC_FALLBACK_FILENAMES) {
    throw new Error(
      `Too many project document fallback filenames (maximum ${MAX_PROJECT_DOC_FALLBACK_FILENAMES}).`,
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>(BUILTIN_PROJECT_INSTRUCTION_FILENAMES);
  for (const value of values) {
    const filename = value.trim();
    if (!isValidProjectDocFallbackFilename(filename)) {
      throw new Error(`Invalid project document fallback filename: ${JSON.stringify(value)}`);
    }
    if (seen.has(filename)) continue;
    seen.add(filename);
    normalized.push(filename);
  }
  return normalized;
}

export function projectInstructionFilenames(fallbacks: readonly string[]): string[] {
  return [...BUILTIN_PROJECT_INSTRUCTION_FILENAMES, ...fallbacks];
}
