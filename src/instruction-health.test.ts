import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstructionHealth } from "./instruction-health.js";

test("instruction health reports paging, chain, repetition, and scope risks", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-health-"));
  try {
    await mkdir(join(root, "src", "deep"), { recursive: true });
    const repeated = "For src/deep files, keep generated fixtures deterministic and scoped.\n";
    await writeFile(join(root, "AGENTS.md"), `${repeated.repeat(80)}${"x".repeat(4_000)}\n`);
    await writeFile(join(root, "src", "AGENTS.md"), `${"nested policy\n".repeat(900)}`);
    await writeFile(join(root, "src", "deep", "AGENTS.md"), `${"z".repeat(9_000)}\n`);

    const report = await inspectInstructionHealth([root]);
    const codes = new Set(report.issues.map((issue) => issue.code));
    assert.equal(report.instructionFiles, 3);
    assert.equal(codes.has("instruction_file_large"), true);
    assert.equal(codes.has("instruction_line_large"), true);
    assert.equal(codes.has("instruction_chain_near_limit"), true);
    assert.equal(codes.has("instruction_repeated_template"), true);
    assert.equal(codes.has("root_instruction_scope_candidate"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instruction health scan is bounded and skips dependency trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-health-bounded-"));
  try {
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(root, "node_modules", "ignored", "AGENTS.md"), "ignored\n");
    for (let index = 0; index < 4; index += 1) {
      await mkdir(join(root, `dir-${index}`), { recursive: true });
    }
    const report = await inspectInstructionHealth([root], [], { maxDirectories: 2 });
    assert.equal(report.truncated, true);
    assert.equal(report.instructionFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
