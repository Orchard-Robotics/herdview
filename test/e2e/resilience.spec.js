const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// A transient network blip (mobile radio sleep, a herdview redeploy) must not
// blank a pane that already loaded — the "can't read pane" flicker the user hit.
test("a transient fetch failure keeps the last-good transcript", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  const bubble = page.locator(".msg.assistant .bubble", { hasText: "hello from the transcript" }).first();
  await expect(bubble).toBeVisible();

  // simulate the link dropping for a couple of poll cycles (poll is ~1.5s)
  await page.route("**/api/pane/**", route => route.abort());
  await page.waitForTimeout(3500);

  // content survives — no whole-pane wipe, no error text
  await expect(bubble).toBeVisible();
  await expect(page.locator(".convo", { hasText: "can't read pane" })).toHaveCount(0);

  // link recovers → still healthy on the next tick
  await page.unroute("**/api/pane/**");
  await expect(bubble).toBeVisible({ timeout: 4000 });
});

// A pane that has NEVER loaded should still surface the error (not silently blank).
test("a never-loaded pane surfaces the read error", async ({ page }) => {
  await page.route("**/api/pane/**", route => route.abort());
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".convo, .term", { hasText: "can't read pane" }).first()).toBeVisible({ timeout: 5000 });
});
