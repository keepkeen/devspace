import * as z from "zod/v4";

export const MAX_OPERATION_ID_UTF8_BYTES = 128;

export function isValidOperationId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OPERATION_ID_UTF8_BYTES ||
    value.includes("\0")
  ) {
    return false;
  }
  const utf8 = Buffer.from(value, "utf8");
  return utf8.length <= MAX_OPERATION_ID_UTF8_BYTES &&
    utf8.toString("utf8") === value;
}

export function operationId(value: unknown, name = "operationId"): string {
  if (!isValidOperationId(value)) {
    throw new TypeError(
      `${name} must be a well-formed, non-empty Unicode string without NUL bytes and at most ` +
        `${MAX_OPERATION_ID_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export const operationIdSchema = z.string()
  .min(1)
  .max(MAX_OPERATION_ID_UTF8_BYTES)
  .refine(
    isValidOperationId,
    `Must be well-formed Unicode, non-empty, contain no NUL bytes, and use at most ${MAX_OPERATION_ID_UTF8_BYTES} UTF-8 bytes`,
  );
