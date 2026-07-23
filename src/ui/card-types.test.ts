import assert from "node:assert/strict";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isShellTool,
  isToolName,
  toolResultCard,
  toolResultText,
  workspacePayloadText,
} from "./card-types.js";

for (const tool of ["apply_patch", "exec_command", "write_stdin"]) {
  assert.equal(isToolName(tool), true, `${tool} should be a recognized card tool`);
}

assert.equal(isPatchTool("apply_patch"), true);
assert.equal(isEditTool("apply_patch"), false);
assert.equal(isShellTool("exec_command"), true);
assert.equal(isShellTool("write_stdin"), true);
assert.equal(isEditTool("exec_command"), false);
assert.equal(isShellTool("apply_patch"), false);

assert.equal(
  isExpandableCard({ tool: "apply_patch", payload: { patch: "diff --git a/a b/a" } }),
  true,
);
assert.equal(isExpandableCard({ tool: "apply_patch" }), false);

for (const tool of ["batch_read", "batch_inspect", "read_process_output"]) {
  assert.equal(isToolName(tool), true, `${tool} should be a recognized result card tool`);
}

const topLevelCard = toolResultCard({
  content: [{ type: "text", text: "top-level body" }],
  structuredContent: { path: "src/a.ts", lines: 1 },
  _meta: {
    tool: "read",
    card: {
      path: "stale.ts",
      summary: { lines: 0 },
      payload: { content: [{ type: "text", text: "legacy duplicate" }] },
    },
  },
});
assert.ok(topLevelCard);
assert.equal(topLevelCard.path, "src/a.ts", "structuredContent should override card metadata");
assert.equal(toolResultText(topLevelCard), "top-level body");
assert.equal(topLevelCard.payload, undefined, "model-visible content must not remain in payload");

const legacyCard = toolResultCard({
  content: [],
  _meta: {
    tool: "read",
    card: { payload: { content: [{ type: "text", text: "legacy body" }] } },
  },
});
assert.ok(legacyCard);
assert.equal(toolResultText(legacyCard), "legacy body");
assert.equal(legacyCard.payload, undefined);

const batchCard = toolResultCard({
  content: [{ type: "text", text: "Read 2 files." }],
  structuredContent: {
    items: [
      { ok: true, result: "alpha" },
      { ok: false, result: "not found" },
    ],
    instructions: "Follow nested instructions.",
  },
  _meta: {
    tool: "batch_read",
    card: {
      summary: { items: 2 },
      batchItems: [
        { index: 0, operation: "read", path: "a.ts" },
        { index: 1, operation: "read", path: "b.ts" },
      ],
    },
  },
});
assert.ok(batchCard);
assert.equal(
  toolResultText(batchCard),
  "a.ts\nalpha\n\n[failed] b.ts\nnot found\n\nFollow nested instructions.",
);

const processCard = toolResultCard({
  content: [{ type: "text", text: "test output\n[process exited with code 0]" }],
  structuredContent: {},
  _meta: {
    tool: "exec_command",
    card: { outputId: "output-1", summary: { command: "npm test", exitCode: 0 } },
  },
});
assert.ok(processCard);
assert.equal(toolResultText(processCard), "test output\n[process exited with code 0]");
assert.equal(processCard.outputId, "output-1");

const patchCard = toolResultCard({
  content: [{ type: "text", text: "Applied patch." }],
  _meta: {
    tool: "apply_patch",
    card: {
      files: [{ path: "a.ts", operation: "update" }],
      payload: { patch: "diff --git a/a.ts b/a.ts", content: [] },
    },
  },
});
assert.ok(patchCard);
assert.equal(patchCard.payload?.patch, "diff --git a/a.ts b/a.ts");
assert.equal(patchCard.payload?.content, undefined);

const reviewCard = toolResultCard({
  content: [{ type: "text", text: "Changed 2 files." }],
  _meta: {
    tool: "show_changes",
    card: {
      files: [
        { path: "a.ts", operation: "update" },
        { path: "b.ts", operation: "update" },
      ],
      payload: { patch: "diff --git a/a.ts b/a.ts" },
    },
  },
});
assert.ok(reviewCard);
assert.equal(reviewCard.files?.length, 2, "UI-only review files must survive summary field names");

const skillCard = toolResultCard({
  content: [{ type: "text", text: "loaded" }],
  _meta: { tool: "load_skill" },
});
assert.ok(skillCard);
assert.equal(toolResultText(skillCard), "loaded");

const closeCard = toolResultCard({
  content: [{ type: "text", text: "Workspace closed." }],
  _meta: {
    tool: "close_workspace",
    card: { summary: { closed: true, processesTerminated: 0 } },
  },
});
assert.ok(closeCard);
assert.equal(toolResultText(closeCard), "Workspace closed.");

const retainedOutputCard = toolResultCard({
  content: [{ type: "text", text: "page body" }],
  structuredContent: { nextOffset: 9, status: "active" },
  _meta: {
    tool: "read_process_output",
    card: { outputId: "output-2", storedBytes: 20, totalBytes: 20 },
  },
});
assert.ok(retainedOutputCard);
assert.equal(retainedOutputCard.outputId, "output-2");
assert.equal(retainedOutputCard.storedBytes, 20);
assert.equal(retainedOutputCard.nextOffset, 9);

const repeatedWorkspaceCard = toolResultCard({
  content: [{ type: "text", text: "Workspace context unchanged." }],
  structuredContent: {
    workspaceId: "workspace-1",
    instructionsIncluded: false,
    agentsFiles: [],
    skillsIncluded: false,
    skills: [],
  },
  _meta: { tool: "open_workspace", card: { root: "/tmp/project" } },
});
assert.ok(repeatedWorkspaceCard);
assert.match(workspacePayloadText(repeatedWorkspaceCard), /Skills: unchanged \(not repeated\)/);
assert.match(workspacePayloadText(repeatedWorkspaceCard), /Project instructions: unchanged \(not repeated\)/);
assert.doesNotMatch(workspacePayloadText(repeatedWorkspaceCard), /Skills: none|AGENTS\.md: none loaded/);
