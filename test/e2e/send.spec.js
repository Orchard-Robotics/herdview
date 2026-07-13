const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

test("sending a message reaches herdr and shows a bubble", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator("#msg").fill("hello world");
  await page.locator("#sendbtn").click();

  // the message shows immediately as a bubble
  await expect(page.locator(".msg.user .bubble", { hasText: "hello world" }).first()).toBeVisible();
  // and herdr actually received it (send-text + submit Enter)
  await expect.poll(() => env.readSendlog()).toContain("hello world");
  await expect.poll(() => env.readSendlog()).toContain("SENDKEYS\tw3:p1\tEnter");
});

test("failed send keeps the text in the box and caches a draft", async ({ page }) => {
  env.patchState({ sendShouldFail: true });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator("#msg").fill("boom message");
  await page.locator("#sendbtn").click();

  // text restored to the composer, not lost
  await expect(page.locator("#msg")).toHaveValue("boom message");
  // reassuring toast
  await expect(page.locator("#hv-toast")).toContainText(/kept/i);
  // and persisted so a reload/reconnect can't lose it
  const draft = await page.evaluate(() => localStorage.getItem("herdview:draft:w3:p1"));
  expect(draft).toBe("boom message");
});

test("a cached draft is restored when the pane is reopened", async ({ page }) => {
  await page.goto("/");
  // seed a draft directly (as if a prior failed send left it)
  await page.evaluate(() => localStorage.setItem("herdview:draft:w3:p1", "unsent draft"));
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator("#msg")).toHaveValue("unsent draft");
});
