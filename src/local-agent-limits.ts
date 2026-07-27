import { createHash } from "node:crypto";

export const MAX_LOCAL_AGENT_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_LOCAL_AGENT_RESPONSE_BYTES = 256 * 1024;
export const MAX_LOCAL_AGENT_ERROR_BYTES = 64 * 1024;
export const MAX_LOCAL_AGENT_EVENT_BYTES = 1024 * 1024;

/**
 * Bounded UTF-8 head/tail collector with an integrity fingerprint.
 *
 * Provider output is untrusted and may be arbitrarily large. The collector
 * keeps exact text while it fits, then retains bounded orientation plus the
 * original byte count and SHA-256 digest.
 */
export class BoundedAgentTextCollector {
  private readonly hash = createHash("sha256");
  private exact = Buffer.alloc(0);
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private overflow = false;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
      throw new RangeError("A bounded agent text collector needs at least 256 bytes.");
    }
  }

  append(value: string | Buffer): void {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    if (bytes.length === 0) return;
    this.hash.update(bytes);
    this.totalBytes += bytes.length;

    if (!this.overflow) {
      const combined = Buffer.concat([this.exact, bytes]);
      if (combined.length <= this.maxBytes) {
        this.exact = combined;
        return;
      }
      this.overflow = true;
      const provisionalHeadBytes = Math.ceil(this.maxBytes / 2);
      const provisionalTailBytes = Math.floor(this.maxBytes / 2);
      this.head = combined.subarray(0, provisionalHeadBytes);
      this.tail = combined.subarray(Math.max(0, combined.length - provisionalTailBytes));
      this.exact = Buffer.alloc(0);
      return;
    }

    const provisionalTailBytes = Math.floor(this.maxBytes / 2);
    const combinedTail = Buffer.concat([this.tail, bytes]);
    this.tail = combinedTail.subarray(Math.max(0, combinedTail.length - provisionalTailBytes));
  }

  result(label: string): string {
    if (!this.overflow) return this.exact.toString("utf8");
    const digest = this.hash.copy().digest("hex");
    const notice = `\n...[${label} truncated; originalBytes=${this.totalBytes}; sha256=${digest}]...\n`;
    const noticeBytes = Buffer.byteLength(notice, "utf8");
    if (noticeBytes >= this.maxBytes) {
      return utf8Prefix(Buffer.from(notice, "utf8"), this.maxBytes).toString("utf8");
    }
    const payloadBytes = this.maxBytes - noticeBytes;
    const headBytes = Math.ceil(payloadBytes / 2);
    const tailBytes = Math.floor(payloadBytes / 2);
    return `${utf8Prefix(this.head, headBytes).toString("utf8")}${notice}${utf8Suffix(this.tail, tailBytes).toString("utf8")}`;
  }

  bytesSeen(): number {
    return this.totalBytes;
  }
}

export function boundedLocalAgentText(
  value: string,
  maxBytes: number,
  label: string,
): string {
  const collector = new BoundedAgentTextCollector(maxBytes);
  collector.append(value);
  return collector.result(label);
}

export function appendBoundedTailText(
  current: string,
  addition: string | Buffer,
  maxBytes: number,
): string {
  const combined = Buffer.concat([
    Buffer.from(current, "utf8"),
    Buffer.isBuffer(addition) ? addition : Buffer.from(addition, "utf8"),
  ]);
  if (combined.length <= maxBytes) return combined.toString("utf8");
  return utf8Suffix(combined, maxBytes).toString("utf8");
}

function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  let end = Math.min(bytes.length, Math.max(0, maxBytes));
  while (end > 0 && end < bytes.length && isUtf8ContinuationByte(bytes[end]!)) end -= 1;
  return bytes.subarray(0, end);
}

function utf8Suffix(bytes: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, bytes.length - Math.max(0, maxBytes));
  while (start < bytes.length && isUtf8ContinuationByte(bytes[start]!)) start += 1;
  return bytes.subarray(start);
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}
