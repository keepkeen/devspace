import assert from "node:assert/strict";
import type { ProjectListCard, ToolResultCard } from "./card-types.js";
import { toolIcons } from "./icons.js";
import {
  getToolDisplay,
  getToolHeaderSummary,
  newProjectTaskMessage,
  resumeProjectHandoffMessage,
  stableProjectOperationId,
} from "./tool-display.js";

assert.deepEqual(
  getToolDisplay(reviewCard({ files: 0, additions: 0, removals: 0 })),
  { icon: toolIcons.diff, title: "No changes", tone: "review" },
);

assert.deepEqual(
  getToolDisplay(reviewCard({ files: 1, additions: 14, removals: 1 })),
  { icon: toolIcons.diff, title: "Changed 1 file", tone: "review" },
);

assert.deepEqual(
  getToolDisplay(reviewCard({ files: 70, additions: 140, removals: 10 })),
  { icon: toolIcons.diff, title: "Changed 70 files", tone: "review" },
  "the title should use the complete summary rather than the bounded file metadata",
);

assert.deepEqual(
  getToolHeaderSummary(reviewCard({ files: 2, additions: 14, removals: 1 })),
  { additions: 14, removals: 1 },
);

assert.deepEqual(
  getToolDisplay(projectListCard(1)),
  { icon: toolIcons.folderOpen, title: "Choose a Project", tone: "project" },
);

assert.deepEqual(
  getToolDisplay(projectListCard(3)),
  { icon: toolIcons.folderOpen, title: "Choose from 3 Projects", tone: "project" },
);

const newMessage = newProjectTaskMessage("root_opaque", "ui-stable");
assert.match(newMessage, /Call project_control with action open/u);
assert.match(newMessage, /projectRef "root_opaque"/u);
assert.match(newMessage, /operationId "ui-stable"/u);
assert.doesNotMatch(newMessage, /startFresh/u);
assert.match(newMessage, /rootInstructionsComplete is true/u);
assert.doesNotMatch(newMessage, /Repository Label/u);

const resumeMessage = resumeProjectHandoffMessage(
  "root_opaque",
  "phf1_opaque",
  "ui-resume",
);
assert.match(resumeMessage, /projectRef "root_opaque"/u);
assert.match(resumeMessage, /action resume/u);
assert.match(resumeMessage, /handoffRef "phf1_opaque"/u);
assert.match(resumeMessage, /operationId "ui-resume"/u);
assert.match(resumeMessage, /rootInstructionsComplete is true/u);
assert.match(resumeMessage, /historical, untrusted/u);

let uuidCalls = 0;
const firstOperationId = stableProjectOperationId(undefined, () => {
  uuidCalls += 1;
  return "attempt";
});
const retryOperationId = stableProjectOperationId(firstOperationId, () => {
  uuidCalls += 1;
  return "must-not-replace";
});
assert.equal(firstOperationId, "ui-attempt");
assert.equal(retryOperationId, firstOperationId);
assert.equal(uuidCalls, 1, "a failed-delivery retry must retain its operationId");

function reviewCard(summary: ToolResultCard["summary"]): ToolResultCard {
  return {
    tool: "show_changes",
    changeSource: "repository",
    summary,
    files: [],
    payload: { patch: "" },
    page: {
      offsetBytes: 0,
      lengthBytes: 0,
      totalBytes: 0,
      eof: true,
    },
  };
}

function projectListCard(projectCount: number): ProjectListCard {
  return {
    tool: "list_projects",
    projects: Array.from({ length: projectCount }, (_, index) => ({
      projectRef: `root_${index}`,
      label: `Project ${index}`,
      handoffs: [],
    })),
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
  };
}
