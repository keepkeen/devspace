import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireStateDirectorySingleton,
  StateDirectoryAlreadyInUseError,
} from "./state-directory-singleton.js";

const root = await mkdtemp(join(tmpdir(), "devspace-state-singleton-"));
try {
  const first = acquireStateDirectorySingleton({ stateDir: root });
  assert.throws(
    () => acquireStateDirectorySingleton({ stateDir: root }),
    StateDirectoryAlreadyInUseError,
    "an active OS-backed lock must block a competing server",
  );

  first.release();
  first.release();

  const replacement = acquireStateDirectorySingleton({ stateDir: root });
  assert.throws(
    () => acquireStateDirectorySingleton({ stateDir: root }),
    StateDirectoryAlreadyInUseError,
    "a released predecessor must not affect the replacement lock",
  );
  replacement.release();

  const afterRelease = acquireStateDirectorySingleton({ stateDir: root });
  afterRelease.release();
} finally {
  await rm(root, { recursive: true, force: true });
}
