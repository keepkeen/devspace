import assert from "node:assert/strict";
import { ProjectActivityHub } from "./project-activity-hub.js";

const hub = new ProjectActivityHub();
try {
  const waiting = hub.waitForAfter("thread-a", 3, 1_000);
  hub.publish({ threadId: "thread-a", sequence: 4 });
  assert.equal(await waiting, true);
  assert.equal(await hub.waitForAfter("thread-a", 4, 1), false);
  hub.publish({ threadId: "thread-a", sequence: 6 });
  assert.equal(await hub.waitForAfter("thread-a", 5, 1_000), true);
} finally {
  hub.close();
}

console.log("project activity hub tests passed");
