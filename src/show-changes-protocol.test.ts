import assert from "node:assert/strict";
import test from "node:test";
import { buildModelVisibleDiffPage } from "./server.js";

test("show_changes pages diffs on UTF-8 and line boundaries", () => {
  const line = `+中文-${"x".repeat(96)}\n`;
  const patch = line.repeat(300);
  const first = buildModelVisibleDiffPage(patch, 0);
  assert.equal(Buffer.byteLength(first.content, "utf8") <= 12_000, true);
  assert.equal(first.content.endsWith("\n"), true);
  assert.equal(first.eof, false);
  assert.equal(first.offset, 0);

  const second = buildModelVisibleDiffPage(patch, first.nextOffset);
  assert.equal(second.offset, first.nextOffset);
  assert.equal(
    Buffer.from(first.content + second.content, "utf8")
      .subarray(0, first.nextOffset + Buffer.byteLength(second.content, "utf8"))
      .toString("utf8"),
    Buffer.from(patch, "utf8").subarray(0, second.nextOffset).toString("utf8"),
  );
});

test("show_changes emits an EOF page and rejects invalid offsets", () => {
  const patch = "diff --git a/a b/a\n+ok\n";
  const page = buildModelVisibleDiffPage(patch, 0);
  assert.equal(page.eof, true);
  assert.equal(page.nextOffset, Buffer.byteLength(patch, "utf8"));
  assert.throws(() => buildModelVisibleDiffPage(patch, page.totalBytes + 1), /offset exceeds/iu);
  assert.throws(() => buildModelVisibleDiffPage(patch, 0, 12_001), /limit is invalid/iu);
});
