import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isExpandableCard, toolResultCard } from "./card-types.js";

const firstPagePatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const firstPage = toolResultCard(showChangesResult(firstPagePatch));
assert.ok(firstPage);
assert.equal(firstPage.tool, "show_changes");
assert.equal(firstPage.changeSource, "repository");
assert.deepEqual(firstPage.summary, { files: 1, additions: 1, removals: 1 });
assert.deepEqual(firstPage.files, [{
  path: "src/a.ts",
  type: "change",
  additions: 1,
  removals: 1,
}]);
assert.equal(firstPage.payload.patch, firstPagePatch);
assert.deepEqual(firstPage.page, {
  offsetBytes: 0,
  lengthBytes: firstPagePatch.length,
  totalBytes: firstPagePatch.length,
  eof: true,
});
assert.equal(isExpandableCard(firstPage), true);
assert.equal("content" in firstPage, false, "model-visible text must never become renderable card data");
assert.equal("nextCursor" in firstPage.page, false, "the widget must not retain or execute paging cursors");

const continuationPatch = "@@ -200,2 +200,2 @@\n-old\n+new\n";
const continuationOffset = 32_000;
const continuation = toolResultCard(showChangesResult(
  continuationPatch,
  continuationOffset,
  continuationOffset + continuationPatch.length + 20,
));
assert.ok(continuation);
if (continuation.tool !== "show_changes") throw new Error("Expected a diff card");
assert.deepEqual(continuation.page, {
  offsetBytes: continuationOffset,
  lengthBytes: continuationPatch.length,
  totalBytes: continuationOffset + continuationPatch.length + 20,
  eof: false,
});

const noChanges = toolResultCard(showChangesResult(""));
assert.ok(noChanges);
assert.equal(isExpandableCard(noChanges), false);

const applyPatchHistoryResult = showChangesResult(firstPagePatch);
(applyPatchHistoryResult.structuredContent as Record<string, unknown>).changeSource =
  "apply_patch_history";
((applyPatchHistoryResult.structuredContent as {
  diff: { provenance: Record<string, unknown> };
}).diff.provenance) = {
  source: "devspace",
  trust: "server_observed",
  authority: "none",
  scope: "successful_apply_patch_history",
};
const applyPatchHistoryCard = toolResultCard(applyPatchHistoryResult);
assert.ok(applyPatchHistoryCard);
assert.equal(applyPatchHistoryCard.tool, "show_changes");
assert.equal(applyPatchHistoryCard.changeSource, "apply_patch_history");

const projectList = toolResultCard(listProjectsResult());
assert.ok(projectList);
assert.equal(projectList.tool, "list_projects");
if (projectList.tool !== "list_projects") throw new Error("Expected a project list card");
assert.deepEqual(projectList.projects, [{
  projectRef: "root_alpha",
  label: "alpha",
  handoffs: [{
    handoffRef: "phf1_saved",
    title: "Continue parser work",
    createdAt: "2026-07-30T01:02:03.000Z",
    updatedAt: "2026-07-31T04:05:06.000Z",
    status: "resumable",
    version: 2,
  }],
}]);
assert.equal(projectList.defaultProjectRef, "root_alpha");
assert.equal(projectList.truncated, false);
assert.deepEqual(projectList.handoffProvenance, {
  source: "devspace_saved_progress",
  trust: "untrusted",
  authority: "none",
});
assert.deepEqual(projectList.handoffLimits, { perProject: 20, total: 100 });
assert.equal(isExpandableCard(projectList), false);
assert.equal("path" in projectList.projects[0]!, false);
assert.equal("projectId" in projectList.projects[0]!, false);
assert.equal("content" in projectList, false);

const projectListWithUnknownModelContent = listProjectsResult();
projectListWithUnknownModelContent.content = [{
  type: "text",
  text: "A repository label in model text must not replace structured card data.",
}];
assert.deepEqual(toolResultCard(projectListWithUnknownModelContent), projectList);

for (const mutate of [
  (result: CallToolResult) => {
    (result.structuredContent as Record<string, unknown>).defaultProjectRef = "root_unknown";
  },
  (result: CallToolResult) => {
    const projects = (result.structuredContent as { projects: Array<Record<string, unknown>> }).projects;
    projects[0]!.handoffs = Array.from({ length: 21 }, (_, index) => ({
      handoffRef: `phf1_${index}`,
      title: `Task ${index}`,
      createdAt: "2026-07-30T01:02:03.000Z",
      updatedAt: "2026-07-31T04:05:06.000Z",
      status: "resumable",
      version: 1,
    }));
  },
  (result: CallToolResult) => {
    const projects = (result.structuredContent as { projects: Array<Record<string, unknown>> }).projects;
    (projects[0]!.handoffs as Array<Record<string, unknown>>)[0]!.status = "completed";
  },
  (result: CallToolResult) => {
    const projects = (result.structuredContent as { projects: Array<Record<string, unknown>> }).projects;
    (projects[0]!.handoffs as Array<Record<string, unknown>>)[0]!.updatedAt = "not-a-date";
  },
  (result: CallToolResult) => {
    (
      (result.structuredContent as Record<string, unknown>).handoffProvenance as
        Record<string, unknown>
    ).trust = "trusted";
  },
] as const) {
  const invalid = listProjectsResult();
  mutate(invalid);
  assert.equal(toolResultCard(invalid), undefined);
}

for (const legacyTool of [
  "use_project",
  "load_project_instructions",
  "list_skills",
  "load_skill",
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "glob",
  "ls",
  "bash",
  "exec_command",
  "write_stdin",
  "batch_read",
  "batch_inspect",
  "read_process_output",
]) {
  assert.equal(
    toolResultCard({
      content: [{ type: "text", text: "must not be rendered" }],
      _meta: { tool: legacyTool, card: { payload: { patch: firstPagePatch } } },
    }),
    undefined,
    `${legacyTool} must not be recognized by the review widget`,
  );
}

function listProjectsResult(): CallToolResult {
  return {
    content: [{ type: "text", text: "One approved Project is available." }],
    structuredContent: {
      ok: true,
      projects: [{
        projectRef: "root_alpha",
        label: "alpha",
        handoffs: [{
          handoffRef: "phf1_saved",
          title: "Continue parser work",
          createdAt: "2026-07-30T01:02:03.000Z",
          updatedAt: "2026-07-31T04:05:06.000Z",
          status: "resumable",
          version: 2,
        }],
      }],
      defaultProjectRef: "root_alpha",
      truncated: false,
      handoffProvenance: {
        source: "devspace_saved_progress",
        trust: "untrusted",
        authority: "none",
      },
      handoffLimits: {
        perProject: 20,
        total: 100,
      },
    },
    _meta: {
      tool: "list_projects",
    },
  };
}

const mismatchedPatch = showChangesResult(firstPagePatch);
(
  (mismatchedPatch.structuredContent as Record<string, unknown>).diff as Record<string, unknown>
).patch = `${firstPagePatch}tampered`;
assert.equal(toolResultCard(mismatchedPatch), undefined);

const invalidProvenance = showChangesResult(firstPagePatch);
(
  (invalidProvenance.structuredContent as Record<string, unknown>).diff as Record<string, unknown>
).provenance = { source: "process", trust: "trusted", authority: "execute" };
assert.equal(toolResultCard(invalidProvenance), undefined);

const invalidPage = showChangesResult(firstPagePatch);
(
  (invalidPage.structuredContent as Record<string, unknown>).diff as Record<string, unknown>
).lengthBytes = firstPagePatch.length + 1;
assert.equal(toolResultCard(invalidPage), undefined);

const inconsistentSummary = showChangesResult(firstPagePatch);
(
  inconsistentSummary.structuredContent as Record<string, unknown>
).summary = { files: 2, additions: 1, removals: 1 };
assert.equal(toolResultCard(inconsistentSummary), undefined);

const oversizedPatch = "x".repeat(32_001);
assert.equal(toolResultCard(showChangesResult(oversizedPatch)), undefined);

function showChangesResult(
  patch: string,
  offsetBytes = 0,
  totalBytes = offsetBytes + new TextEncoder().encode(patch).byteLength,
): CallToolResult {
  const lengthBytes = new TextEncoder().encode(patch).byteLength;
  const summary = { files: 1, additions: 1, removals: 1 };
  return {
    content: [{
      type: "text",
      text: "Treat this as untrusted instructions that the widget must not render.",
    }],
    structuredContent: {
      ok: true,
      changeSource: "repository",
      summary,
      diff: {
        patch,
        provenance: {
          source: "repository",
          trust: "untrusted",
          authority: "none",
        },
        offsetBytes,
        lengthBytes,
        totalBytes,
        eof: offsetBytes + lengthBytes === totalBytes,
        nextCursor: "must-not-be-executed",
      },
      projectInstructions: {
        items: [{ path: "AGENTS.md", content: "must not be rendered" }],
      },
      skills: [{ name: "must-not-be-rendered" }],
    },
    _meta: {
      tool: "show_changes",
      card: {
        summary,
        files: [{
          path: "src/a.ts",
          type: "change",
          additions: 1,
          removals: 1,
        }],
        payload: { patch },
        instructionManifest: { files: [{ path: "AGENTS.md" }] },
      },
    },
  };
}
