const { test, expect } = require("@playwright/test");
const env = require("../support/env");

const TASKS = [
  "some earlier output",
  "5 tasks (3 done, 2 open)",
  "  ✔ Add feature flag",
  "  ✔ Wire stage into pipeline",
  "  ✔ Phase 1a reproject",
  "  ◻ Verify Phase 1a on LFC scan",
  "  ◻ Phase 1b Tiny RoMa refine",
  "",
].join("\n");

test.beforeEach(() => env.resetScenario());

test("a todo checklist renders as a tidy Tasks panel", async ({ page }) => {
  env.patchState({ read: { "w3:p1": TASKS } });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".tasks .art-h")).toContainText("Tasks (3/5)");
  await expect(page.locator(".task-item")).toHaveCount(5);
  await expect(page.locator(".task-item.done")).toHaveCount(3);
  await expect(page.locator(".task-item.open", { hasText: "Verify Phase 1a on LFC scan" })).toBeVisible();
});

test("no Tasks panel when the terminal has no checklist", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".msg").first()).toBeVisible();
  await expect(page.locator(".tasks")).toHaveCount(0);
});
