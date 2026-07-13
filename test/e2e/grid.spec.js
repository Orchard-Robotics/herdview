const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

test("grid renders every agent, blocked sorted first", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator(".card");
  await expect(cards).toHaveCount(3);
  // blocked agent floats to the top and is styled as blocked
  await expect(cards.first()).toHaveClass(/blocked/);
  await expect(cards.first().locator(".name")).toContainText("needs-you");
});

test("each card exposes its pane and opens the detail view", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-pane="w1:p5"] .name')).toContainText("builder");
  await page.locator('[data-pane="w3:p1"]').click();
  // detail view has the composer
  await expect(page.locator("#msg")).toBeVisible();
  await expect(page.locator("#sendbtn")).toBeVisible();
});

test("empty agent list shows the empty state", async ({ page }) => {
  env.patchState({ agents: [] });
  await page.goto("/");
  await expect(page.locator(".empty")).toBeVisible();
});
