import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupDetachedAgentPromptArtifacts,
  removeDetachedAgentPrompt,
} from "./detached-agent-cleanup.js";

const removable = await mkdtemp(join(tmpdir(), "devspace-agent-prompt-"));
const cleanupRoot = await mkdtemp(join(tmpdir(), "devspace-agent-cleanup-test-"));

try {
  const promptFile = join(removable, "prompt.txt");
  await writeFile(promptFile, "secret", { mode: 0o600 });
  assert.equal(await removeDetachedAgentPrompt(promptFile), true);
  await assert.rejects(access(removable));
  assert.equal(await removeDetachedAgentPrompt(join(cleanupRoot, "prompt.txt")), false);

  for (const name of ["devspace-agent-prompt-old-a", "devspace-agent-prompt-old-b"]) {
    const directory = join(cleanupRoot, name);
    await mkdir(directory);
    await writeFile(join(directory, "prompt.txt"), "secret");
    await utimes(directory, new Date(0), new Date(0));
  }
  const fresh = join(cleanupRoot, "devspace-agent-prompt-fresh");
  await mkdir(fresh);
  await writeFile(join(fresh, "prompt.txt"), "secret");
  await utimes(fresh, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await mkdir(join(cleanupRoot, "unrelated"));

  assert.equal(await cleanupDetachedAgentPromptArtifacts({
    tempRoot: cleanupRoot,
    olderThanMs: 1,
    limit: 1,
  }), 1);
  assert.equal((await readdir(cleanupRoot)).filter((name) => name.startsWith("devspace-agent-prompt-old-")).length, 1);
  assert.equal(await cleanupDetachedAgentPromptArtifacts({
    tempRoot: cleanupRoot,
    olderThanMs: 1,
    limit: 64,
  }), 1);
  assert.deepEqual((await readdir(cleanupRoot)).sort(), ["devspace-agent-prompt-fresh", "unrelated"]);
} finally {
  await rm(removable, { recursive: true, force: true });
  await rm(cleanupRoot, { recursive: true, force: true });
}
