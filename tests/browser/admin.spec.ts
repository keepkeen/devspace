import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startAdminServer, type RunningAdminServer } from "../../src/admin-server.js";

interface Fixture {
  admin: RunningAdminServer;
  configPath: string;
  mcpServer: Server;
  root: string;
  restartCount(): number;
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
  await page.locator("#tool-mode").selectOption("full");

  const external = JSON.parse(readFileSync(fixture.configPath, "utf8"));
  external.toolMode = "minimal";
  writeFileSync(fixture.configPath, JSON.stringify(external, null, 2));

  await page.getByRole("button", { name: "保存", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "无法保存设置" });
  await expect(alert).toBeVisible();
  await expect(page.locator("#tool-mode")).toHaveValue("full");

  await page.getByRole("button", { name: "放弃本地修改并载入最新配置" }).click();
  await expect(page.locator("#tool-mode")).toHaveValue("minimal");
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

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "devspace-admin-browser-"));
  const configDir = join(root, "config");
  const allowedRoot = join(root, "project");
  mkdirSync(configDir);
  mkdirSync(allowedRoot);

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
        usage: {
          mcpSessions: { active: 1, reserved: 0, limit: 8 },
          processSessions: { active: 0, limit: 16 },
          workspaces: { active: 1, resident: 1, closing: 0, limit: 32 },
          oauth: { clients: 1, accessTokens: 1, refreshTokens: 1, expiredRecords: 0 },
        },
        recentFailures: [],
      }),
      revokeAllClientsAndTokens: async () => ({ ok: true }),
    },
  });

  return { admin, configPath, mcpServer, root, restartCount: () => restartCount };
}
