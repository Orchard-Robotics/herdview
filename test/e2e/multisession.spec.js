const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

test("a single session skips the gate and lands on its agents", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".card[data-pane]").first()).toBeVisible(); // agent cards
  await expect(page.locator("[data-session-name]")).toHaveCount(0);      // no gate
});

test("2+ sessions land on the gate, drill in, and back returns to the gate", async ({ page }) => {
  env.setSessions([
    { name: "alpha", agents: [env.mkAgent("w1:p1", "working", { name: "a-builder" })] },
    { name: "beta", agents: [env.mkAgent("w1:p1", "blocked", { name: "b-fixer" })] },
  ]);
  await page.goto("/");
  // gate: one card per session, no agent cards yet
  await expect(page.locator('[data-session-name="alpha"]')).toBeVisible();
  await expect(page.locator('[data-session-name="beta"]')).toBeVisible();
  await expect(page.locator(".card[data-pane]")).toHaveCount(0);

  // drill into beta → only beta's agents
  await page.locator('[data-session-name="beta"]').click();
  await expect(page.locator('.card[data-pane="w1:p1"]', { hasText: "b-fixer" })).toBeVisible();
  await expect(page.locator(".card", { hasText: "a-builder" })).toHaveCount(0);

  // back → gate
  await page.locator("#back").click();
  await expect(page.locator('[data-session-name="alpha"]')).toBeVisible();
  await expect(page.locator(".card[data-pane]")).toHaveCount(0);
});

test("colliding pane ids: a send routes to the drilled-into session", async ({ page }) => {
  env.setSessions([
    { name: "alpha", agents: [env.mkAgent("w1:p1", "idle", { name: "a" })] },
    { name: "beta", agents: [env.mkAgent("w1:p1", "idle", { name: "b" })] },
  ]);
  await page.goto("/");
  await page.locator('[data-session-name="beta"]').click();
  await page.locator('.card[data-pane="w1:p1"]').click();
  await page.locator("#msg").fill("hi beta");
  await page.locator("#sendbtn").click();
  // recorded against beta (trailing field in the mock log), never alpha
  await expect.poll(() => env.readSendlog()).toMatch(/SENDTEXT\tw1:p1\t"hi beta"\tbeta/);
  expect(env.readSendlog()).not.toMatch(/"hi beta"\talpha/);
});

test("the gate shows per-session agent counts", async ({ page }) => {
  env.setSessions([
    { name: "busy", agents: [env.mkAgent("w1:p1", "idle", { name: "x" }), env.mkAgent("w1:p2", "blocked", { name: "y" })] },
    { name: "solo", agents: [env.mkAgent("w1:p1", "working", { name: "z" })] },
  ]);
  await page.goto("/");
  await expect(page.locator('[data-session-name="busy"]')).toContainText("2 agents");
  await expect(page.locator('[data-session-name="solo"]')).toContainText("1 agent");
});
