import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile",
  workers: 1,
  timeout: 45_000,
  projects: [
    {
      name: "mobile-chromium",
      use: {
        viewport: { width: 393, height: 851 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite preview --config vite.mobile.config.ts",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
  },
});
