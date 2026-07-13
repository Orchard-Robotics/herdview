const { defineConfig } = require("@playwright/test");
const env = require("./support/env");

// Tests share one stateful server (mock herdr scenario + fake transcript), so
// they run serially and each resets the scenario in beforeEach.
module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30000,
  globalSetup: require.resolve("./global-setup"),
  globalTeardown: require.resolve("./global-teardown"),
  use: {
    baseURL: env.BASE_URL,
    viewport: { width: 390, height: 844 }, // phone-shaped, since herdview is phone-first
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
