export const BATCH_MAX_ITEMS = 8;
export const BATCH_READ_DEFAULT_LINES = 400;
export const BATCH_READ_MAX_LINES = 2_000;
export const BATCH_ERROR_MAX_CHARACTERS = 1_000;
export const BATCH_ITEM_MAX_CHARACTERS = 16_000;
export const BATCH_TOTAL_MAX_CHARACTERS = 48_000;
export const BATCH_ITEM_MIN_CHARACTERS = 512;
export const BATCH_ALLOCATION_CHUNK_CHARACTERS = 1_024;

export type BatchOmittedReason = "aggregate_budget_exhausted";

export interface BatchWorkItem {
  operation: string;
  path: string;
}

export interface BatchItemResult {
  index: number;
  operation: string;
  path: string;
  ok: boolean;
  result: string;
  error?: {
    code: string;
    retryable?: boolean;
    safeToRetry?: boolean;
    recovery?: string;
    phase?: "not_started" | "committed" | "outcome_unknown";
    effectsKnown?: boolean;
  };
  truncated: boolean;
  omitted?: true;
  omittedReason?: BatchOmittedReason;
}

export interface BatchResult {
  items: BatchItemResult[];
  result: string;
  truncated: boolean;
}

export interface BatchOptions<T extends BatchWorkItem> {
  onError?: (error: unknown, item: T, index: number) => void;
  totalMaxCharacters?: number;
  minItemCharacters?: number;
  allocationChunkCharacters?: number;
}

class UnsafeBatchReadTruncationError extends Error {
  readonly code = "read_files_truncation_unsafe";
  readonly publicText =
    "A file read exceeded the output budget. Call read_files with fewer files or fewer lines so each continuation remains exact.";

  constructor() {
    super("Refusing to return a read_files continuation after its visible content was truncated.");
    this.name = "UnsafeBatchReadTruncationError";
  }
}

export function limitBatchText(
  text: string,
  maxCharacters = BATCH_TOTAL_MAX_CHARACTERS,
): { text: string; truncated: boolean } {
  return limitText(text, maxCharacters);
}

/**
 * Executes a small, schema-bounded batch concurrently while preserving input
 * order and enforcing both per-item and aggregate response budgets.
 */
export async function runBoundedBatch<T extends BatchWorkItem>(
  items: T[],
  execute: (item: T, index: number) => Promise<{
    ok: boolean;
    result: string;
    error?: BatchItemResult["error"];
  }>,
  options: BatchOptions<T> = {},
): Promise<BatchResult> {
  if (items.length === 0 || items.length > BATCH_MAX_ITEMS) {
    throw new Error(`Batch must contain between 1 and ${BATCH_MAX_ITEMS} items.`);
  }

  const seen = new Set<string>();
  const rawResults = await Promise.all(items.map(async (item, index): Promise<BatchItemResult> => {
    const duplicateKey = JSON.stringify(item);
    if (seen.has(duplicateKey)) {
      return {
        index,
        operation: item.operation,
        path: item.path,
        ok: false,
        result: "Duplicate batch item skipped.",
        truncated: false,
      };
    }
    seen.add(duplicateKey);

    try {
      const response = await execute(item, index);
      const limited = limitText(
        response.result,
        response.ok ? BATCH_ITEM_MAX_CHARACTERS : BATCH_ERROR_MAX_CHARACTERS,
      );
      if (item.operation === "read" && response.ok && limited.truncated) {
        throw new UnsafeBatchReadTruncationError();
      }
      return {
        index,
        operation: item.operation,
        path: item.path,
        ok: response.ok,
        result: limited.text,
        ...(response.error ? { error: response.error } : {}),
        truncated: limited.truncated,
      };
    } catch (error) {
      if (error instanceof UnsafeBatchReadTruncationError) throw error;
      options.onError?.(error, item, index);
      const limited = limitText(
        publicBatchError(error),
        BATCH_ERROR_MAX_CHARACTERS,
      );
      return {
        index,
        operation: item.operation,
        path: item.path,
        ok: false,
        result: limited.text,
        truncated: limited.truncated,
      };
    }
  }));

  const totalMaxCharacters = nonNegativeInteger(
    options.totalMaxCharacters ?? BATCH_TOTAL_MAX_CHARACTERS,
    "totalMaxCharacters",
  );
  const minItemCharacters = nonNegativeInteger(
    options.minItemCharacters ?? BATCH_ITEM_MIN_CHARACTERS,
    "minItemCharacters",
  );
  const allocationChunkCharacters = positiveInteger(
    options.allocationChunkCharacters ?? BATCH_ALLOCATION_CHUNK_CHARACTERS,
    "allocationChunkCharacters",
  );
  const results = allocateBatchTextFairly(
    rawResults,
    totalMaxCharacters,
    minItemCharacters,
    allocationChunkCharacters,
  );
  if (results.some((item) => item.operation === "read" && item.ok && item.truncated)) {
    throw new UnsafeBatchReadTruncationError();
  }
  const aggregateTruncated = results.some((item) => item.truncated || item.omitted === true);

  const formatted = limitText(
    results.map(formatBatchItem).join("\n\n"),
    totalMaxCharacters,
  );
  if (formatted.truncated && results.some((item) => item.operation === "read" && item.ok)) {
    throw new UnsafeBatchReadTruncationError();
  }
  return {
    items: results,
    result: formatted.text,
    truncated: formatted.truncated || aggregateTruncated || results.some((item) => item.truncated),
  };
}

function publicBatchError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    "publicText" in error &&
    typeof error.publicText === "string"
  ) {
    return `${error.code}: ${error.publicText}`;
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return `${error.code}: Batch item failed.`;
  }
  return "Batch item failed.";
}

function formatBatchItem(item: BatchItemResult): string {
  const status = item.ok ? "ok" : "error";
  const truncation = item.truncated ? ", truncated" : "";
  const omitted = item.omitted ? ", omitted" : "";
  return `## ${item.index + 1}. ${item.operation} ${item.path} (${status}${truncation}${omitted})\n${item.result}`;
}

function allocateBatchTextFairly(
  items: BatchItemResult[],
  maximum: number,
  minimumPerItem: number,
  chunkSize: number,
): BatchItemResult[] {
  if (items.length === 0) return [];
  const allocations = Array.from({ length: items.length }, () => 0);
  const baseline = Math.min(minimumPerItem, Math.floor(maximum / items.length));
  let remaining = maximum;

  for (let index = 0; index < items.length; index += 1) {
    const allocation = Math.min(items[index]!.result.length, baseline);
    allocations[index] = allocation;
    remaining -= allocation;
  }

  // Bring every item toward the minimum one character per round. This keeps a
  // very small aggregate budget from being consumed entirely by the first
  // result while still producing explicit omitted markers when mathematically
  // unavoidable.
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (let index = 0; index < items.length && remaining > 0; index += 1) {
      const desiredMinimum = Math.min(items[index]!.result.length, minimumPerItem);
      if (allocations[index]! >= desiredMinimum) continue;
      allocations[index]! += 1;
      remaining -= 1;
      progress = true;
    }
  }

  // Distribute the rest in bounded round-robin chunks. The maximum difference
  // caused by input order is one chunk instead of the whole aggregate budget.
  progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (let index = 0; index < items.length && remaining > 0; index += 1) {
      const needed = items[index]!.result.length - allocations[index]!;
      if (needed <= 0) continue;
      const granted = Math.min(needed, chunkSize, remaining);
      allocations[index]! += granted;
      remaining -= granted;
      progress = true;
    }
  }

  return items.map((item, index) => {
    const allocation = allocations[index]!;
    if (item.result.length > 0 && allocation === 0) {
      return {
        ...item,
        result: "",
        truncated: true,
        omitted: true,
        omittedReason: "aggregate_budget_exhausted",
      };
    }
    const limited = limitText(item.result, allocation);
    return {
      ...item,
      result: limited.text,
      truncated: item.truncated || limited.truncated,
    };
  });
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function limitText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  if (maxCharacters <= 0) return { text: "", truncated: true };
  const suffix = "\n...[truncated by batch output limit]";
  if (maxCharacters <= suffix.length) {
    return { text: suffix.slice(0, maxCharacters), truncated: true };
  }
  return {
    text: `${text.slice(0, maxCharacters - suffix.length)}${suffix}`,
    truncated: true,
  };
}
