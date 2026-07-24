import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  effectiveSkillPaths,
  effectiveSkillSources,
  formatPathForPrompt,
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillInputPath,
  resolveSkillPath,
  resolveSkillReadPath,
  SKILL_DISCOVERY_LIMITS,
  skillUriRoot,
} from "./skills.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-skills-test-")));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function writeSkill(
  directory: string,
  name: string,
  description: string,
  extraFrontmatter: string[] = [],
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(path, [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...extraFrontmatter,
    "---",
    "",
    `# ${name}`,
  ].join("\n"));
  return path;
}

function makeConfig(
  workspaceRoot: string,
  overrides: NodeJS.ProcessEnv = {},
): ServerConfig {
  return loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_ADMIN_SKILLS_DIR: join(root, "admin-skills"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    ...overrides,
  });
}

try {
  process.env.HOME = root;
  process.env.USERPROFILE = root;

  const repositoryRoot = join(root, "repository");
  const workspaceRoot = join(repositoryRoot, "packages", "app");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  await writeSkill(join(repositoryRoot, ".agents", "skills", "root"), "shared", "Repository root copy.");
  await writeSkill(join(repositoryRoot, "packages", ".agents", "skills", "package"), "package", "Package copy.");
  const workspaceManifest = await writeSkill(
    join(workspaceRoot, ".agents", "skills", "workspace"),
    "shared",
    "Workspace copy.",
  );
  await mkdir(join(workspaceRoot, ".agents", "skills", "workspace", "agents"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".agents", "skills", "workspace", "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: true\n",
  );
  await writeSkill(join(root, ".agents", "skills", "user"), "user", "User copy.");
  await writeSkill(join(root, "admin-skills", "admin"), "admin", "Admin copy.");
  await writeSkill(join(root, "config", "skills", "devspace"), "devspace", "DevSpace compatibility copy.");
  await writeSkill(join(root, "agent", "skills", "agent"), "agent", "Agent directory compatibility copy.");
  await writeSkill(join(workspaceRoot, "relative-skills", "explicit"), "shared", "Explicit copy.");

  const config = makeConfig(repositoryRoot, { DEVSPACE_SKILL_PATHS: "relative-skills" });
  const sources = effectiveSkillSources(config, workspaceRoot);
  assert.deepEqual(
    sources.slice(0, 6).map(({ source, scope }) => ({ source, scope })),
    [
      { source: "explicit", scope: "compatibility" },
      { source: "repo", scope: "repo" },
      { source: "repo", scope: "repo" },
      { source: "repo", scope: "repo" },
      { source: "user", scope: "user" },
      { source: "admin", scope: "admin" },
    ],
  );
  assert.equal(sources[0]?.path, join(workspaceRoot, "relative-skills"));
  assert.equal(resolveSkillPath("relative-skills", workspaceRoot), join(workspaceRoot, "relative-skills"));
  assert.equal(resolveSkillInputPath("relative-skills/explicit/SKILL.md", workspaceRoot), join(workspaceRoot, "relative-skills", "explicit", "SKILL.md"));
  assert.equal(effectiveSkillPaths(config, workspaceRoot).includes(join(root, "admin-skills")), true);

  const nestedAllowlistResult = loadWorkspaceSkills(
    makeConfig(workspaceRoot),
    workspaceRoot,
  );
  assert.deepEqual(
    nestedAllowlistResult.skills
      .filter((skill) => skill.scope === "repo")
      .map((skill) => skill.description),
    ["Workspace copy."],
  );
  const packageAllowlistResult = loadWorkspaceSkills(
    makeConfig(join(repositoryRoot, "packages")),
    workspaceRoot,
  );
  assert.deepEqual(
    packageAllowlistResult.skills
      .filter((skill) => skill.scope === "repo")
      .map((skill) => skill.description),
    ["Package copy.", "Workspace copy."],
  );

  const loaded = loadWorkspaceSkills(config, workspaceRoot);
  assert.deepEqual(
    loaded.skills.filter((skill) => skill.scope === "repo").map((skill) => skill.description),
    ["Repository root copy.", "Package copy.", "Workspace copy."],
  );
  for (const expected of ["user", "admin", "devspace", "agent"]) {
    assert.equal(loaded.skills.some((skill) => skill.name === expected), true);
  }
  const duplicates = loaded.skills.filter((skill) => skill.name === "shared");
  assert.equal(duplicates.length, 3);
  assert.equal(new Set(duplicates.map((skill) => skill.skillId)).size, 3);
  assert.deepEqual(
    duplicates.map((skill) => skill.source),
    ["explicit", "repo", "repo"],
  );
  assert.deepEqual(
    loadWorkspaceSkills(config, workspaceRoot).skills.map((skill) => skill.skillId),
    loaded.skills.map((skill) => skill.skillId),
  );
  assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.message.includes("collision")), false);

  const workspaceSkill = loaded.skills.find((skill) => skill.filePath === workspaceManifest);
  assert.ok(workspaceSkill);
  assert.equal(
    workspaceSkill.allowImplicitInvocation,
    false,
    "repository metadata cannot grant itself implicit model invocation",
  );
  assert.equal(loaded.skills.find((skill) => skill.name === "user")?.allowImplicitInvocation, true);
  assert.equal(loaded.skills.find((skill) => skill.name === "admin")?.allowImplicitInvocation, true);

  const allowlistedRepositorySkill = loadWorkspaceSkills(
    makeConfig(repositoryRoot, {
      DEVSPACE_SKILL_PATHS: ".agents/skills/workspace",
    }),
    workspaceRoot,
  ).skills.filter((skill) => skill.filePath === workspaceManifest);
  assert.equal(allowlistedRepositorySkill.length, 1, "an allowlisted repository Skill is not duplicated");
  assert.equal(allowlistedRepositorySkill[0]?.source, "explicit");
  assert.equal(
    allowlistedRepositorySkill[0]?.allowImplicitInvocation,
    true,
    "local DEVSPACE_SKILL_PATHS configuration can explicitly trust a repository Skill",
  );
  assert.match(formatPathForPrompt(workspaceSkill.filePath), /^~\//);
  assert.equal(
    resolveSkillReadPath(
      loaded.skills,
      new Set(),
      ".agents/skills/workspace/SKILL.md",
      workspaceRoot,
    )?.skill.skillId,
    workspaceSkill.skillId,
  );
  assert.equal(
    resolveSkillReadPath(loaded.skills, new Set(), ".agents/skills/workspace/SKILL.md"),
    undefined,
  );

  const referencePath = join(workspaceSkill.baseDir, "references.md");
  await writeFile(referencePath, "reference\n");
  assert.equal(resolveSkillReadPath(loaded.skills, new Set(), referencePath), undefined);
  const activated = new Set<string>();
  markSkillActivated(activated, workspaceSkill);
  assert.equal(
    resolveSkillReadPath(loaded.skills, activated, referencePath)?.isSkillFile,
    false,
  );
  assert.equal(
    resolveSkillReadPath(
      loaded.skills,
      activated,
      `${skillUriRoot(workspaceSkill.skillId)}references.md`,
      workspaceRoot,
    )?.absolutePath,
    referencePath,
  );
  for (const invalidPath of ["../outside.txt", "%2e%2e/outside.txt", "references%2Fsecret.md"]) {
    assert.throws(
      () => resolveSkillReadPath(
        loaded.skills,
        activated,
        `${skillUriRoot(workspaceSkill.skillId)}${invalidPath}`,
        workspaceRoot,
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "skill_path_invalid",
    );
  }
  const userSkill = loaded.skills.find((skill) => skill.name === "user");
  assert.ok(userSkill);
  const externalReferencePath = join(userSkill.baseDir, "external-reference.md");
  await writeFile(externalReferencePath, "external reference\n");
  assert.equal(resolveSkillReadPath(loaded.skills, new Set(), externalReferencePath), undefined);
  const activatedExternal = new Set<string>();
  markSkillActivated(activatedExternal, userSkill);
  assert.equal(
    resolveSkillReadPath(loaded.skills, activatedExternal, externalReferencePath)?.skill.skillId,
    userSkill.skillId,
  );

  const policyManifest = await writeSkill(
    join(workspaceRoot, "policies", "explicit-only"),
    "explicit-only",
    "Explicit invocation only.",
  );
  await mkdir(join(workspaceRoot, "policies", "explicit-only", "agents"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "policies", "explicit-only", "agents", "openai.yaml"),
    "interface:\n  display_name: Explicit only\npolicy:\n  allow_implicit_invocation: false\n",
  );
  await writeSkill(join(workspaceRoot, "policies", "implicit"), "implicit", "Implicit by default.");
  await writeSkill(join(workspaceRoot, "policies", "invalid-policy"), "invalid-policy", "Invalid policy defaults safely.");
  await mkdir(join(workspaceRoot, "policies", "invalid-policy", "agents"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "policies", "invalid-policy", "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: 'false'\n",
  );
  const policyConfig = makeConfig(workspaceRoot, { DEVSPACE_SKILL_PATHS: "policies" });
  const policyResult = loadWorkspaceSkills(policyConfig, workspaceRoot);
  const policySkills = policyResult.skills;
  const explicitOnly = policySkills.find((skill) => skill.filePath === policyManifest);
  assert.equal(explicitOnly?.allowImplicitInvocation, false);
  assert.equal(explicitOnly?.disableModelInvocation, true);
  assert.equal(explicitOnly?.openai?.policy !== undefined, true);
  assert.equal(policySkills.find((skill) => skill.name === "implicit")?.allowImplicitInvocation, true);
  assert.equal(policySkills.find((skill) => skill.name === "invalid-policy")?.allowImplicitInvocation, false);
  assert.equal(policyResult.diagnostics.some((diagnostic) => diagnostic.type === "warning"), true);

  const disabledConfig = makeConfig(workspaceRoot, {
    DEVSPACE_SKILL_PATHS: "policies",
    DEVSPACE_DISABLED_SKILL_PATHS: "policies/explicit-only/SKILL.md",
  });
  assert.equal(
    loadWorkspaceSkills(disabledConfig, workspaceRoot).skills.some((skill) => skill.name === "explicit-only"),
    false,
  );
  const disabledDirectoryConfig = makeConfig(workspaceRoot, {
    DEVSPACE_SKILL_PATHS: "policies",
    DEVSPACE_DISABLED_SKILL_PATHS: "policies/explicit-only",
  });
  assert.equal(
    loadWorkspaceSkills(disabledDirectoryConfig, workspaceRoot).skills.some((skill) => skill.name === "explicit-only"),
    false,
  );
  assert.deepEqual(
    loadWorkspaceSkills(makeConfig(workspaceRoot, { DEVSPACE_SKILLS: "0" }), workspaceRoot),
    { skills: [], diagnostics: [] },
  );

  const invalidRoot = join(workspaceRoot, "invalid-skills");
  await writeSkill(join(invalidRoot, "empty-name"), "''", "Has no usable name.");
  await writeFile(
    await writeSkill(join(invalidRoot, "missing-description"), "missing-description", "placeholder"),
    "---\nname: missing-description\n---\n",
  );
  await mkdir(join(invalidRoot, "invalid-yaml"), { recursive: true });
  await writeFile(join(invalidRoot, "invalid-yaml", "SKILL.md"), "---\nname: [\n---\n");
  const invalid = loadWorkspaceSkills(
    makeConfig(workspaceRoot, { DEVSPACE_SKILL_PATHS: "invalid-skills" }),
    workspaceRoot,
  );
  assert.equal(invalid.skills.some((skill) => ["empty-name", "missing-description"].includes(skill.name)), false);
  assert.equal(invalid.diagnostics.filter((diagnostic) => diagnostic.type === "error").length, 3);

  assert.equal(SKILL_DISCOVERY_LIMITS.maxSkillBytes, 65_536);
  const oversizedRoot = join(workspaceRoot, "oversized-skills");
  const oversizedManifest = await writeSkill(
    join(oversizedRoot, "too-large"),
    "too-large",
    "Must be rejected before its body enters model context.",
  );
  await writeFile(oversizedManifest, `---\nname: too-large\ndescription: Must be rejected.\n---\n${"x".repeat(SKILL_DISCOVERY_LIMITS.maxSkillBytes)}`);
  const oversized = loadWorkspaceSkills(
    makeConfig(workspaceRoot, { DEVSPACE_SKILL_PATHS: "oversized-skills" }),
    workspaceRoot,
  );
  assert.equal(oversized.skills.some((skill) => skill.name === "too-large"), false);
  assert.equal(
    oversized.diagnostics.some((diagnostic) => diagnostic.message.includes("exceeds the size limit")),
    true,
  );

  const symlinkRoot = join(workspaceRoot, "linked-skills");
  const externalRoot = join(root, "external");
  await mkdir(symlinkRoot, { recursive: true });
  await writeSkill(join(externalRoot, "direct-skill"), "linked", "Linked skill folder.");
  await mkdir(join(externalRoot, "collection", "nested"), { recursive: true });
  await writeSkill(join(externalRoot, "collection", "nested"), "escaped", "Must not be recursively discovered.");
  await symlink(join(externalRoot, "direct-skill"), join(symlinkRoot, "direct-skill"), "dir");
  await symlink(join(externalRoot, "collection"), join(symlinkRoot, "collection"), "dir");
  await symlink(symlinkRoot, join(symlinkRoot, "cycle"), "dir");
  await mkdir(join(symlinkRoot, "manifest-escape"), { recursive: true });
  await symlink(
    join(externalRoot, "direct-skill", "SKILL.md"),
    join(symlinkRoot, "manifest-escape", "SKILL.md"),
    "file",
  );
  const linked = loadWorkspaceSkills(
    makeConfig(workspaceRoot, { DEVSPACE_SKILL_PATHS: "linked-skills" }),
    workspaceRoot,
  );
  assert.equal(linked.skills.some((skill) => skill.name === "linked"), true);
  assert.equal(linked.skills.some((skill) => skill.name === "escaped"), false);
  assert.equal(
    linked.diagnostics.some((diagnostic) => diagnostic.message.includes("manifest symlink escapes")),
    true,
  );
  const disabledLinked = loadWorkspaceSkills(
    makeConfig(workspaceRoot, {
      DEVSPACE_SKILL_PATHS: "linked-skills",
      DEVSPACE_DISABLED_SKILL_PATHS: "linked-skills/direct-skill/SKILL.md",
    }),
    workspaceRoot,
  );
  assert.equal(disabledLinked.skills.some((skill) => skill.name === "linked"), false);

  const repoLinkedSkill = join(workspaceRoot, ".agents", "skills", "repo-escape");
  await symlink(join(externalRoot, "direct-skill"), repoLinkedSkill, "dir");
  const repoLinked = loadWorkspaceSkills(makeConfig(repositoryRoot), workspaceRoot);
  assert.equal(repoLinked.skills.some((skill) => skill.name === "linked"), false);
  assert.equal(
    repoLinked.diagnostics.some((diagnostic) => diagnostic.message.includes("canonical repository")),
    true,
  );

  const linkedRepositoryRoot = join(root, "linked-repository");
  await mkdir(join(linkedRepositoryRoot, ".git"), { recursive: true });
  await mkdir(join(linkedRepositoryRoot, ".agents"), { recursive: true });
  await symlink(externalRoot, join(linkedRepositoryRoot, ".agents", "skills"), "dir");
  const linkedRepoRoot = loadWorkspaceSkills(
    makeConfig(linkedRepositoryRoot),
    linkedRepositoryRoot,
  );
  assert.equal(linkedRepoRoot.skills.some((skill) => skill.name === "linked"), false);
  assert.equal(linkedRepoRoot.skills.some((skill) => skill.name === "escaped"), false);
  assert.equal(
    linkedRepoRoot.diagnostics.some((diagnostic) => diagnostic.message.includes("canonical repository")),
    true,
  );

  const deepRoot = join(workspaceRoot, "deep-skills");
  let deepDirectory = deepRoot;
  for (let index = 0; index < SKILL_DISCOVERY_LIMITS.maxDepth + 2; index += 1) {
    deepDirectory = join(deepDirectory, `level-${index}`);
  }
  await writeSkill(deepDirectory, "too-deep", "Outside discovery depth.");
  const deep = loadWorkspaceSkills(
    makeConfig(workspaceRoot, { DEVSPACE_SKILL_PATHS: "deep-skills" }),
    workspaceRoot,
  );
  assert.equal(deep.skills.some((skill) => skill.name === "too-deep"), false);
  assert.equal(deep.diagnostics.some((diagnostic) => diagnostic.message.includes("traversal limit")), true);

  const noisyRoot = join(workspaceRoot, "noisy-skills");
  for (let index = 0; index < SKILL_DISCOVERY_LIMITS.maxDiagnostics + 10; index += 1) {
    const directory = join(noisyRoot, `invalid-${String(index).padStart(3, "0")}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "---\nname: invalid\n---\n");
  }
  const noisy = loadWorkspaceSkills(
    makeConfig(workspaceRoot, { DEVSPACE_SKILL_PATHS: "noisy-skills" }),
    workspaceRoot,
  );
  assert.equal(noisy.diagnostics.length, SKILL_DISCOVERY_LIMITS.maxDiagnostics);
  assert.equal(noisy.diagnostics.at(-1)?.message.includes("omitted"), true);

  const bundled = loadWorkspaceSkills(
    makeConfig(workspaceRoot, { DEVSPACE_SUBAGENTS: "1" }),
    workspaceRoot,
  );
  const bundledSubagent = bundled.skills.find(
    (skill) => skill.name === "subagent-delegation" && skill.source === "bundled",
  );
  assert.ok(bundledSubagent);
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
}
