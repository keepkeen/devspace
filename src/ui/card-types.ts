import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type DisplayToolName =
  | "open_workspace"
  | "close_workspace"
  | "load_skill"
  | "show_changes"
  | "apply_patch"
  | "exec_command"
  | "write_stdin"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "bash";

export type ToolName =
  | DisplayToolName
  | "batch_read"
  | "batch_inspect"
  | "read_process_output";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export type PatchOperation = "add" | "update" | "delete" | "move";

export interface ToolResultCard<TTool extends ToolName = DisplayToolName> {
  tool: TTool;
  workspaceId?: string;
  path?: string;
  root?: string;
  status?: string;
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    operation?: PatchOperation;
    type?: string;
    additions?: number;
    removals?: number;
  }>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  skillDiagnostics?: unknown[];
  instruction?: string;
  content?: ToolContent[];
  items?: BatchResultItem[];
  truncated?: boolean;
  instructions?: string;
  outputId?: string;
  offset?: number;
  nextOffset?: number;
  eof?: boolean;
  totalBytes?: number;
  storedBytes?: number;
  droppedBytes?: number;
}

export type AnyToolResultCard = ToolResultCard<ToolName>;

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolPayload {
  /** Compatibility-only input. New results carry model-visible content at top level. */
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

export interface BatchResultItem {
  index?: number;
  operation?: string;
  path?: string;
  ok?: boolean;
  result?: string;
}

export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "close_workspace" ||
    value === "load_skill" ||
    value === "show_changes" ||
    value === "apply_patch" ||
    value === "exec_command" ||
    value === "write_stdin" ||
    value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls" ||
    value === "bash" ||
    value === "batch_read" ||
    value === "batch_inspect" ||
    value === "read_process_output"
  );
}

export function isDisplayToolName(value: ToolName): value is DisplayToolName {
  return value !== "batch_read" && value !== "batch_inspect" && value !== "read_process_output";
}

export function isReadTool(tool: ToolName): boolean {
  return tool === "read";
}

export function isWriteTool(tool: ToolName): boolean {
  return tool === "write";
}

export function isEditTool(tool: ToolName): boolean {
  return tool === "edit";
}

export function isPatchTool(tool: ToolName): boolean {
  return tool === "apply_patch";
}

export function isSearchTool(tool: ToolName): boolean {
  return tool === "grep" || tool === "glob";
}

export function isShellTool(tool: ToolName): boolean {
  return tool === "bash" || tool === "exec_command" || tool === "write_stdin";
}

export function isReviewTool(tool: ToolName): boolean {
  return tool === "show_changes";
}

export function isBatchTool(tool: ToolName): boolean {
  return tool === "batch_read" || tool === "batch_inspect";
}

export function isToolResultCard(value: unknown): value is Omit<ToolResultCard, "tool"> {
  return Boolean(value && typeof value === "object");
}

export function payloadText(payload: ToolPayload | undefined): string {
  return contentText(payload?.content);
}

export function contentText(content: ToolContent[] | undefined): string {
  return (
    content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

export function toolResultText(card: AnyToolResultCard): string {
  if (isBatchTool(card.tool)) {
    const itemText = batchItemsText(card.items);
    const structuredText = [itemText, card.instructions]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    if (structuredText) return structuredText;
  }

  return contentText(card.content) || payloadText(card.payload);
}

export function toolResultCard(result: CallToolResult): AnyToolResultCard | undefined {
  const meta = objectRecord(result._meta);
  const tool = meta?.tool;
  if (!isToolName(tool)) return undefined;

  const metaCard = objectRecord(meta?.card) ?? {};
  const structuredContent = objectRecord(result.structuredContent) ?? {};
  const metaPayload = objectRecord(metaCard.payload);
  const topLevelContent = normalizeContent(result.content);
  const legacyContent = topLevelContent.length === 0
    ? normalizeContent(metaPayload?.content)
    : [];
  const payload = uiOnlyPayload(metaPayload);
  const files = Array.isArray(structuredContent.files)
    ? structuredContent.files
    : Array.isArray(metaCard.files)
      ? metaCard.files
      : undefined;
  const { payload: _legacyPayload, ...cardMetadata } = metaCard;

  return {
    ...cardMetadata,
    ...structuredContent,
    tool,
    ...(topLevelContent.length > 0 || legacyContent.length > 0
      ? { content: topLevelContent.length > 0 ? topLevelContent : legacyContent }
      : {}),
    ...(payload ? { payload } : {}),
    ...(files ? { files } : {}),
  } as AnyToolResultCard;
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isExpandableCard(card: AnyToolResultCard): boolean {
  if (card.tool === "open_workspace") {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Number(card.summary?.skillDiagnostics ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.skillDiagnostics?.length)
    );
  }

  if (isReviewTool(card.tool)) return Boolean(card.files?.length || card.payload?.patch);
  if (isPatchTool(card.tool)) return Boolean(card.payload?.patch);

  return Boolean(card.payload || toolResultText(card));
}

function batchItemsText(items: BatchResultItem[] | undefined): string {
  return (
    items
      ?.map((item, itemIndex) => {
        if (typeof item.result !== "string" || !item.result) return "";
        const label = item.path
          ? item.path
          : item.operation
            ? `${item.operation} ${itemIndex + 1}`
            : `Item ${itemIndex + 1}`;
        return `${item.ok === false ? "[failed] " : ""}${label}\n${item.result}`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeContent(value: unknown): ToolContent[] {
  if (!Array.isArray(value)) return [];
  const content: ToolContent[] = [];
  for (const item of value) {
    const block = objectRecord(item);
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
    }
  }
  return content;
}

function uiOnlyPayload(value: Record<string, unknown> | undefined): ToolPayload | undefined {
  const diff = typeof value?.diff === "string" ? value.diff : undefined;
  const patch = typeof value?.patch === "string" ? value.patch : undefined;
  return diff || patch ? { diff, patch } : undefined;
}
