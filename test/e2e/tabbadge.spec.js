const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// Helper: fake the tab going to the background / foreground and fire the event
// the app listens for (Playwright has no direct document.hidden control).
async function setHidden(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { value: h, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("backgrounded tab title badges the count of agents needing you", async ({ page }) => {
  await page.goto("/");
  // let the agent list load (fixture has one blocked agent: w3:p1)
  await expect(page.locator('[data-pane="w3:p1"]')).toBeVisible();
  await expect(page).toHaveTitle("herdview"); // focused → plain title

  await setHidden(page, true);
  await expect(page).toHaveTitle("(1) herdview"); // backgrounded → badge

  await setHidden(page, false);
  await expect(page).toHaveTitle("herdview"); // back on tab → cleared
});

test("no badge when nothing needs you, even backgrounded", async ({ page }) => {
  // all agents idle → blocked count 0
  env.patchState({ agents: [env.mkAgent("w1:p1", "idle"), env.mkAgent("w1:p2", "working")] });
  await page.goto("/");
  await expect(page.locator('[data-pane="w1:p1"]')).toBeVisible();
  await setHidden(page, true);
  await expect(page).toHaveTitle("herdview");
});
