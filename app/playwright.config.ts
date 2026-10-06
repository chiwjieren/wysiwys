import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  workers: 2,
  timeout: 60000,
  expect: { timeout: 15000 },
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3105",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1080 },
      },
    },
  ],
  webServer: {
    // Browser specs still cover the opt-in standard group creation path.
    command:
      "OMNICOUNTER_NEXT_DIST=.next-browser NEXT_PUBLIC_ENABLE_STANDARD_GROUPS=true npm run dev -- --port 3105",
    url: "http://127.0.0.1:3105",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
