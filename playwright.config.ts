import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 20_000,
  fullyParallel: false,
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    ...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {}),
  },
});
