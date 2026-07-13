const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

test("transcript renders as chat bubbles", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(
    page.locator(".msg.assistant .bubble", { hasText: "hello from the transcript" }).first()
  ).toBeVisible();
});

// Regression guard for the vanishing-sent-message bug: the transcript file lags
// the live session, so a just-sent message must stay visible (as a pending
// bubble) until the transcript catches up — not get wiped by a refresh.
test("sent message stays visible until the transcript catches up", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".msg.assistant .bubble", { hasText: "hello from the transcript" }).first()).toBeVisible();

  // send — the transcript file does NOT yet contain this message
  await page.locator("#msg").fill("lag test message");
  await page.locator("#sendbtn").click();

  const pending = page.locator(".msg.user.pending .bubble", { hasText: "lag test message" }).first();
  await expect(pending).toBeVisible();
  // survives multiple refresh cycles (detail refreshes ~every 1.5s)
  await page.waitForTimeout(2200);
  await expect(pending).toBeVisible();

  // now the transcript catches up → the bubble resolves to a normal (non-pending) one
  env.appendTranscript(env.userTurn("lag test message"));
  await expect(
    page.locator(".msg.user:not(.pending) .bubble", { hasText: "lag test message" }).first()
  ).toBeVisible({ timeout: 6000 });
});
