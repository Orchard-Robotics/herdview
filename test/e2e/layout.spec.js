// Wide-viewport master-detail layout. On phones (the default 390px viewport used
// by the other specs) the UI stays a stacked list → chat; on wide viewports the
// agent list and the chat detail must be visible SIMULTANEOUSLY, and selecting an
// agent must not hide the list.
const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

test("wide: agent list and selected chat are visible at the same time", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");

  // single session → lands straight on the two-pane layout with the agent list
  await expect(page.locator(".card[data-pane]").first()).toBeVisible();
  await expect(page.locator(".card[data-pane]")).toHaveCount(3);

  // pick an agent → its chat opens in the right pane
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator("#msg")).toBeVisible();
  await expect(page.locator("#sendbtn")).toBeVisible();

  // …and the list is STILL visible — it was not replaced by the detail
  await expect(page.locator('[data-pane="w3:p1"]')).toBeVisible();
  await expect(page.locator('[data-pane="w1:p5"]')).toBeVisible();
  await expect(page.locator(".card[data-pane]")).toHaveCount(3);

  // switching to a different agent keeps the list up and swaps the chat
  await page.locator('[data-pane="w1:p5"]').click();
  await expect(page.locator("#msg")).toBeVisible();
  await expect(page.locator(".card[data-pane]")).toHaveCount(3);
});

test("wide: the list keeps polling/updating while a chat is open", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator("#msg")).toBeVisible();

  // a live change to the agent list should appear without leaving the chat
  env.patchState({ agents: [...env.DEFAULT_STATE.agents, env.mkAgent("w2:p2", "idle", { name: "late-arrival" })] });
  await expect(page.locator('[data-pane="w2:p2"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#msg")).toBeVisible(); // chat still open alongside
});

test("wide: gated session pick lands in two-pane, back returns to the gate", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  env.setSessions([
    { name: "alpha", agents: [env.mkAgent("w1:p1", "working", { name: "a-builder" })] },
    { name: "beta", agents: [env.mkAgent("w1:p2", "idle", { name: "b-fixer" })] },
  ]);
  await page.goto("/");

  await page.locator('[data-session-name="beta"]').click();
  await page.locator('.card[data-pane="w1:p2"]').click();
  // list + chat together
  await expect(page.locator('.card[data-pane="w1:p2"]')).toBeVisible();
  await expect(page.locator("#msg")).toBeVisible();

  // back → the gate
  await page.locator("#back").click();
  await expect(page.locator('[data-session-name="alpha"]')).toBeVisible();
  await expect(page.locator('[data-session-name="beta"]')).toBeVisible();
  await expect(page.locator(".card[data-pane]")).toHaveCount(0);
});
