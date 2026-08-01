import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startAdminServer, type RunningAdminServer } from "../../src/admin-server.js";

interface Fixture {
  admin: RunningAdminServer;
  configPath: string;
  mcpServer: Server;
  root: string;
  hotAllowedRoot: string;
  restartCount(): number;
  rootsReloadCount(): number;
  setRootsCleanupPending(value: number): void;
}

let fixture: Fixture;

test.beforeEach(async () => {
  fixture = await createFixture();
});

test.afterEach(async () => {
  await fixture.admin.close();
  await new Promise<void>((resolveClose, rejectClose) => {
    fixture.mcpServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  rmSync(fixture.root, { recursive: true, force: true });
});

test("preserves local edits when a config revision conflicts", async ({ page }) => {
  await page.goto(fixture.admin.url);
  await expect(page.getByRole("heading", { name: "管理控制面板" })).toBeVisible();
  await page.locator("#widget-mode").selectOption("off");

  const external = JSON.parse(readFileSync(fixture.configPath, "utf8"));
  external.widgets = "changes";
  writeFileSync(fixture.configPath, JSON.stringify(external, null, 2));

  await page.getByRole("button", { name: "保存", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "无法保存设置" });
  await expect(alert).toBeVisible();
  await expect(page.locator("#widget-mode")).toHaveValue("off");

  await page.getByRole("button", { name: "放弃本地修改并载入最新配置" }).click();
  await expect(page.locator("#widget-mode")).toHaveValue("changes");
});

test("edits process-output quotas as bytes and retention as seconds", async ({ page }) => {
  await page.goto(fixture.admin.url);
  await expect(page.locator("#maxProcessOutputFileBytes")).toHaveValue("67108864");
  await expect(page.locator("#maxProcessOutputStorageBytes")).toHaveValue("1073741824");
  await expect(page.locator("#completedProcessOutputTtlMs")).toHaveValue("86400");

  await page.locator("#maxProcessOutputFileBytes").fill("1048576");
  await page.locator("#maxProcessOutputStorageBytes").fill("2097152");
  await page.locator("#completedProcessOutputTtlMs").fill("3600");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "设置已保存" })).toBeVisible();

  const persisted = JSON.parse(readFileSync(fixture.configPath, "utf8"));
  expect(persisted.resources.maxProcessOutputFileBytes).toBe(1_048_576);
  expect(persisted.resources.maxProcessOutputStorageBytes).toBe(2_097_152);
  expect(persisted.resources.completedProcessOutputTtlMs).toBe(3_600_000);
});

test("saves an explicit user instruction file and requires restart", async ({ page }) => {
  const instructionsPath = join(fixture.root, "USER_INSTRUCTIONS.md");
  writeFileSync(instructionsPath, "Use the explicit DevSpace user instructions.\n");
  await page.goto(fixture.admin.url);

  await expect(page.locator("#user-instructions-path")).toHaveValue("");
  await page.locator("#user-instructions-path").fill(instructionsPath);
  await expect(page.getByRole("button", { name: "保存并重启" })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByRole("status").filter({ hasText: "需要重启后才能完全生效" })).toBeVisible();
  expect(JSON.parse(readFileSync(fixture.configPath, "utf8")).userInstructionsPath).toBe(
    realpathSync(instructionsPath),
  );
  expect(fixture.restartCount()).toBe(0);
});

test("hot-reloads allowed roots without offering save and restart", async ({ page }) => {
  await page.goto(fixture.admin.url);
  await page.locator("#new-root").fill(fixture.hotAllowedRoot);
  await page.locator("#new-root").locator("xpath=..").getByRole("button", { name: "添加" }).click();
  await expect(page.getByRole("button", { name: "保存并重启" })).toBeHidden();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "新设置已经生效" })).toBeVisible();
  expect(fixture.rootsReloadCount()).toBe(1);
  expect(fixture.restartCount()).toBe(0);
  expect(JSON.parse(readFileSync(fixture.configPath, "utf8")).allowedRoots).toContain(
    realpathSync(fixture.hotAllowedRoot),
  );
});

test("keeps incomplete root cleanup visible after refresh", async ({ page }) => {
  fixture.setRootsCleanupPending(1);
  await page.goto(fixture.admin.url);
  await expect(page.getByRole("status").filter({ hasText: "后台清理尚未完成" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "后台清理尚未完成" })).toBeVisible();
});

test("traps keyboard focus and confirms a verified restart", async ({ page }) => {
  await page.goto(fixture.admin.url);
  const restart = page.getByRole("button", { name: "重启服务" });
  await restart.click();
  const dialog = page.getByRole("dialog", { name: "确认重启 DevSpace？" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "确认重启" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(restart).toBeFocused();

  await restart.click();
  await page.getByRole("button", { name: "确认重启" }).click();
  await expect(page.getByRole("status").filter({ hasText: "重启请求已提交" })).toBeVisible();
  expect(fixture.restartCount()).toBe(1);
});

test("keeps the mobile layout inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(fixture.admin.url);
  await expect(page.getByRole("navigation", { name: "设置区段" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
});

test("recovers after a status network failure", async ({ page }) => {
  await page.goto(fixture.admin.url);
  await expect(page.getByRole("heading", { name: "管理控制面板" })).toBeVisible();
  await page.route("**/api/status", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "状态刷新失败" })).toBeVisible();

  await page.unroute("**/api/status");
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "状态刷新失败" })).toBeHidden();
  await expect(page.getByText("已就绪", { exact: true })).toBeVisible();
});

test("retries bootstrap after the browser comes online", async ({ page }) => {
  await page.route("**/api/session", (route) => route.abort("failed"));
  await page.goto(fixture.admin.url);
  await expect(page.getByRole("heading", { name: "无法打开管理面板" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试连接" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.unroute("**/api/session");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { name: "管理控制面板" })).toBeVisible();
  await page.locator("#widget-mode").selectOption("off");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#widget-mode")).toHaveValue("off");
});

test("links numeric validation errors to their fields", async ({ page }) => {
  await page.goto(fixture.admin.url);
  await page.locator("#maxProcessSessions").fill("1");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  const field = page.locator("#maxProcessSessionsPerWorkspace");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAttribute("aria-describedby", /maxProcessSessionsPerWorkspace-errors/);
  await expect(page.locator("#maxProcessSessionsPerWorkspace-errors")).toContainText(
    "Per-Project process sessions",
  );
});

test("distinguishes saved widget settings from the active backend configuration", async ({ page }) => {
  await page.goto(fixture.admin.url);
  await expect(page.getByRole("status").filter({ hasText: "后端已运行当前保存的结果卡片配置" })).toBeVisible();

  await page.locator("#widget-mode").selectOption("off");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const notice = page.getByRole("status").filter({ hasText: "后端仍运行：结果卡片 完整显示；需重启" });
  await expect(notice).toBeVisible();

  await page.getByRole("button", { name: "重启服务" }).click();
  await page.getByRole("button", { name: "确认重启" }).click();
  await expect(page.getByRole("status").filter({ hasText: "后端已运行当前保存的结果卡片配置" })).toBeVisible();
  await expect(notice).toBeHidden();
});

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "devspace-admin-browser-"));
  const configDir = join(root, "config");
  const allowedRoot = join(root, "project");
  const hotAllowedRoot = join(root, "hot-project");
  mkdirSync(configDir);
  mkdirSync(allowedRoot);
  mkdirSync(hotAllowedRoot);

  const mcpServer = createServer((request, response) => {
    if (request.url === "/readyz") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, status: "ready", generation: "browser-generation" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    mcpServer.once("error", rejectListen);
    mcpServer.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = mcpServer.address();
  if (!address || typeof address === "string") throw new Error("Missing MCP test address.");

  const configPath = join(configDir, "config.json");
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "browser-owner-token-that-is-long-enough",
  }));
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: address.port,
    allowedRoots: [allowedRoot],
    publicBaseUrl: `http://127.0.0.1:${address.port}`,
    toolMode: "codex",
    widgets: "full",
  }, null, 2));

  let restartCount = 0;
  let rootsReloadCount = 0;
  let rootsCleanupPending = 0;
  let runtimeConfig: {
    widgets: "full" | "changes" | "off";
  } = { widgets: "full" };
  const admin = await startAdminServer({
    env: { DEVSPACE_CONFIG_DIR: configDir },
    staticDir: resolve("dist/admin-ui"),
    runtimeManager: {
      backendStatus: async () => ({
        managed: true,
        state: "running",
        supervisor: "launchd",
        label: "com.keepkeen.devspace.browser-test",
        actions: ["restart"],
      }),
      restartBackend: async () => {
        restartCount += 1;
        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        runtimeConfig = { widgets: saved.widgets };
        return {
          id: `browser-restart-${restartCount}`,
          target: "backend",
          action: "restart",
          state: "accepted",
          requestedAt: new Date().toISOString(),
        };
      },
    },
    backendClient: {
      diagnostics: async () => ({
        generatedAt: new Date().toISOString(),
        generation: "browser-generation",
        runtimeConfig: { ...runtimeConfig, allowedRootsCleanupPending: rootsCleanupPending },
        usage: {
          mcpSessions: { active: 1, reserved: 0, limit: 8 },
          processSessions: { active: 0, limit: 16 },
          workspaces: { active: 1, resident: 1, closing: 0, limit: 32 },
          oauth: { clients: 1, accessTokens: 1, refreshTokens: 1, expiredRecords: 0 },
        },
        recentFailures: [],
      }),
      reloadAllowedRoots: async () => {
        rootsReloadCount += 1;
        return { ok: true };
      },
      revokeAllClientsAndTokens: async () => ({ ok: true }),
    },
  });

  return {
    admin,
    configPath,
    mcpServer,
    root,
    hotAllowedRoot,
    restartCount: () => restartCount,
    rootsReloadCount: () => rootsReloadCount,
    setRootsCleanupPending: (value) => { rootsCleanupPending = value; },
  };
}
