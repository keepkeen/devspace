import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface DiffPage {
  offsetBytes: number;
  lengthBytes: number;
  totalBytes: number;
  eof: boolean;
}

export interface ToolResultCard {
  tool: "show_changes";
  changeSource: "repository" | "apply_patch_history";
  summary: ReviewSummary;
  files: ReviewFile[];
  payload: {
    patch: string;
  };
  page: DiffPage;
}

export interface ResumableHandoffCard {
  handoffRef: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "resumable";
  version: number;
}

export interface ProjectCardEntry {
  projectRef: string;
  label: string;
  handoffs: ResumableHandoffCard[];
}

export interface ProjectListCard {
  tool: "list_projects";
  projects: ProjectCardEntry[];
  defaultProjectRef?: string;
  truncated: boolean;
  handoffProvenance: {
    source: "devspace_saved_progress";
    trust: "untrusted";
    authority: "none";
  };
  handoffLimits: {
    perProject: number;
    total: number;
  };
}

export type ProjectAppCard = ToolResultCard | ProjectListCard;

const MAX_DIFF_PAGE_BYTES = 32_000;
const MAX_REVIEW_FILES = 50;
const MAX_PATH_LENGTH = 4_096;
const MAX_PROJECTS = 100;
const MAX_PROJECT_LABEL_LENGTH = 512;
const MAX_PROJECT_REF_LENGTH = 128;
const MAX_HANDOFF_REF_LENGTH = 512;
const MAX_HANDOFF_TITLE_LENGTH = 256;
const MAX_HANDOFFS_PER_PROJECT = 20;
const MAX_TOTAL_HANDOFFS = 100;

export function toolResultCard(result: CallToolResult): ProjectAppCard | undefined {
  const meta = objectRecord(result._meta);
  if (meta?.tool === "list_projects") return projectListCard(result);
  if (meta?.tool !== "show_changes") return undefined;
  return showChangesCard(result);
}

function showChangesCard(result: CallToolResult): ToolResultCard | undefined {
  const meta = objectRecord(result._meta);
  const metaCard = objectRecord(meta?.card);
  const structured = objectRecord(result.structuredContent);
  const structuredDiff = objectRecord(structured?.diff);
  const metaPayload = objectRecord(metaCard?.payload);
  const provenance = objectRecord(structuredDiff?.provenance);
  const changeSource = structured?.changeSource;
  const validRepositoryProvenance =
    changeSource === "repository" &&
    provenance?.source === "repository" &&
    provenance.trust === "untrusted" &&
    provenance.authority === "none";
  const validApplyPatchProvenance =
    changeSource === "apply_patch_history" &&
    provenance?.source === "devspace" &&
    provenance.trust === "server_observed" &&
    provenance.authority === "none" &&
    provenance.scope === "successful_apply_patch_history";
  if (
    !metaCard ||
    !structured ||
    !structuredDiff ||
    structured?.ok !== true ||
    (!validRepositoryProvenance && !validApplyPatchProvenance)
  ) {
    return undefined;
  }

  const metaPatch = metaPayload?.patch;
  const structuredPatch = structuredDiff?.patch;
  if (
    typeof metaPatch !== "string" ||
    typeof structuredPatch !== "string" ||
    metaPatch !== structuredPatch
  ) {
    return undefined;
  }

  const patchBytes = new TextEncoder().encode(metaPatch).byteLength;
  if (patchBytes > MAX_DIFF_PAGE_BYTES) return undefined;

  const summary = reviewSummary(metaCard?.summary);
  const structuredSummary = reviewSummary(structured.summary);
  const files = reviewFiles(metaCard?.files);
  const page = diffPage(structuredDiff, patchBytes);
  if (
    !summary ||
    !structuredSummary ||
    !sameSummary(summary, structuredSummary) ||
    !files ||
    !page
  ) {
    return undefined;
  }

  return {
    tool: "show_changes",
    changeSource,
    summary,
    files,
    payload: { patch: metaPatch },
    page,
  };
}

export function isExpandableCard(card: ProjectAppCard): boolean {
  return card.tool === "show_changes" && card.payload.patch.length > 0;
}

function projectListCard(result: CallToolResult): ProjectListCard | undefined {
  const structured = objectRecord(result.structuredContent);
  const limits = objectRecord(structured?.handoffLimits);
  const provenance = objectRecord(structured?.handoffProvenance);
  const perProject = safePositiveInteger(limits?.perProject);
  const total = safePositiveInteger(limits?.total);
  if (
    structured?.ok !== true ||
    typeof structured.truncated !== "boolean" ||
    provenance?.source !== "devspace_saved_progress" ||
    provenance.trust !== "untrusted" ||
    provenance.authority !== "none" ||
    perProject === undefined ||
    total === undefined ||
    perProject > MAX_HANDOFFS_PER_PROJECT ||
    total > MAX_TOTAL_HANDOFFS ||
    !Array.isArray(structured.projects) ||
    structured.projects.length > MAX_PROJECTS
  ) {
    return undefined;
  }

  const projects: ProjectCardEntry[] = [];
  const projectRefs = new Set<string>();
  const handoffRefs = new Set<string>();
  let handoffCount = 0;
  for (const value of structured.projects) {
    const project = objectRecord(value);
    const projectRef = boundedString(project?.projectRef, MAX_PROJECT_REF_LENGTH);
    const label = boundedString(project?.label, MAX_PROJECT_LABEL_LENGTH);
    if (
      !projectRef ||
      !label ||
      projectRefs.has(projectRef) ||
      !Array.isArray(project?.handoffs) ||
      project.handoffs.length > perProject
    ) {
      return undefined;
    }
    projectRefs.add(projectRef);

    const handoffs: ResumableHandoffCard[] = [];
    for (const handoffValue of project.handoffs) {
      const handoff = objectRecord(handoffValue);
      const handoffRef = boundedString(
        handoff?.handoffRef,
        MAX_HANDOFF_REF_LENGTH,
      );
      const title = boundedString(handoff?.title, MAX_HANDOFF_TITLE_LENGTH);
      const createdAt = isoTimestamp(handoff?.createdAt);
      const updatedAt = isoTimestamp(handoff?.updatedAt);
      const version = safePositiveInteger(handoff?.version);
      if (
        !handoffRef ||
        handoffRefs.has(handoffRef) ||
        !title ||
        !createdAt ||
        !updatedAt ||
        version === undefined ||
        handoff?.status !== "resumable"
      ) {
        return undefined;
      }
      handoffRefs.add(handoffRef);
      handoffs.push({
        handoffRef,
        title,
        createdAt,
        updatedAt,
        status: "resumable",
        version,
      });
    }
    handoffCount += handoffs.length;
    if (handoffCount > total) return undefined;
    projects.push({ projectRef, label, handoffs });
  }

  const defaultProjectRef = structured.defaultProjectRef === undefined
    ? undefined
    : boundedString(structured.defaultProjectRef, MAX_PROJECT_REF_LENGTH);
  if (
    (structured.defaultProjectRef !== undefined && !defaultProjectRef) ||
    (defaultProjectRef !== undefined && !projectRefs.has(defaultProjectRef))
  ) {
    return undefined;
  }

  return {
    tool: "list_projects",
    projects,
    ...(defaultProjectRef ? { defaultProjectRef } : {}),
    truncated: structured.truncated,
    handoffProvenance: {
      source: "devspace_saved_progress",
      trust: "untrusted",
      authority: "none",
    },
    handoffLimits: { perProject, total },
  };
}

function reviewSummary(value: unknown): ReviewSummary | undefined {
  const summary = objectRecord(value);
  const files = safeNonNegativeInteger(summary?.files);
  const additions = safeNonNegativeInteger(summary?.additions);
  const removals = safeNonNegativeInteger(summary?.removals);
  if (files === undefined || additions === undefined || removals === undefined) return undefined;
  return { files, additions, removals };
}

function reviewFiles(value: unknown): ReviewFile[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_FILES) return undefined;

  const files: ReviewFile[] = [];
  for (const valueItem of value) {
    const item = objectRecord(valueItem);
    const path = boundedPath(item?.path);
    const previousPath = item?.previousPath === undefined
      ? undefined
      : boundedPath(item.previousPath);
    const additions = safeNonNegativeInteger(item?.additions);
    const removals = safeNonNegativeInteger(item?.removals);
    const type = reviewFileType(item?.type);
    if (
      !path ||
      (item?.previousPath !== undefined && !previousPath) ||
      additions === undefined ||
      removals === undefined ||
      !type
    ) {
      return undefined;
    }

    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      type,
      additions,
      removals,
    });
  }
  return files;
}

function diffPage(
  value: Record<string, unknown>,
  actualLengthBytes: number,
): DiffPage | undefined {
  const offsetBytes = safeNonNegativeInteger(value.offsetBytes);
  const lengthBytes = safeNonNegativeInteger(value.lengthBytes);
  const totalBytes = safeNonNegativeInteger(value.totalBytes);
  const eof = value.eof;
  if (
    offsetBytes === undefined ||
    lengthBytes === undefined ||
    totalBytes === undefined ||
    typeof eof !== "boolean" ||
    lengthBytes !== actualLengthBytes ||
    offsetBytes + lengthBytes > totalBytes ||
    eof !== (offsetBytes + lengthBytes === totalBytes)
  ) {
    return undefined;
  }
  return { offsetBytes, lengthBytes, totalBytes, eof };
}

function sameSummary(left: ReviewSummary, right: ReviewSummary): boolean {
  return left.files === right.files &&
    left.additions === right.additions &&
    left.removals === right.removals;
}

function boundedPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH
    ? value
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : undefined;
}

function reviewFileType(value: unknown): ReviewFile["type"] | undefined {
  if (
    value === "change" ||
    value === "rename-pure" ||
    value === "rename-changed" ||
    value === "new" ||
    value === "deleted"
  ) {
    return value;
  }
  return undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  const parsed = safeNonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
