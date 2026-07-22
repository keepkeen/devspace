export const BATCH_MAX_ITEMS = 8;
export const BATCH_READ_DEFAULT_LINES = 400;
export const BATCH_READ_MAX_LINES = 2_000;
export const BATCH_ITEM_MAX_CHARACTERS = 16_000;
export const BATCH_TOTAL_MAX_CHARACTERS = 48_000;

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
  truncated: boolean;
}

export interface BatchResult {
  items: BatchItemResult[];
  result: string;
  truncated: boolean;
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
  execute: (item: T, index: number) => Promise<{ ok: boolean; result: string }>,
): Promise<BatchResult> {
  if (items.length === 0 || items.length > BATCH_MAX_ITEMS) {
    throw new Error(`Batch must contain between 1 and ${BATCH_MAX_ITEMS} items.`);
  }

  const seen = new Set<string>();
  const results = await Promise.all(items.map(async (item, index): Promise<BatchItemResult> => {
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
      const limited = limitText(response.result, BATCH_ITEM_MAX_CHARACTERS);
      return {
        index,
        operation: item.operation,
        path: item.path,
        ok: response.ok,
        result: limited.text,
        truncated: limited.truncated,
      };
    } catch (error) {
      const limited = limitText(
        error instanceof Error ? error.message : String(error),
        BATCH_ITEM_MAX_CHARACTERS,
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

  let remaining = BATCH_TOTAL_MAX_CHARACTERS;
  let aggregateTruncated = false;
  for (const item of results) {
    const limited = limitText(item.result, remaining);
    item.result = limited.text;
    item.truncated ||= limited.truncated;
    aggregateTruncated ||= limited.truncated;
    remaining = Math.max(0, remaining - item.result.length);
  }

  const formatted = limitText(
    results.map(formatBatchItem).join("\n\n"),
    BATCH_TOTAL_MAX_CHARACTERS,
  );
  return {
    items: results,
    result: formatted.text,
    truncated: formatted.truncated || aggregateTruncated || results.some((item) => item.truncated),
  };
}

function formatBatchItem(item: BatchItemResult): string {
  const status = item.ok ? "ok" : "error";
  const truncation = item.truncated ? ", truncated" : "";
  return `## ${item.index + 1}. ${item.operation} ${item.path} (${status}${truncation})\n${item.result}`;
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
