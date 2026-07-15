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

test("a pending send survives a browser refresh (delivered-but-unconfirmed isn't lost)", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator("#msg").fill("queued while working");
  await page.locator("#sendbtn").click();
  await expect(page.locator(".msg.user.pending .bubble", { hasText: "queued while working" }).first()).toBeVisible();
  await expect.poll(() => env.readSendlog()).toContain("queued while working"); // send has completed (reached herdr)
  // reload — the transcript still doesn't contain it (Claude queued it), so a
  // purely in-memory pending would vanish here; the persisted one must not.
  await page.reload();
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".msg.user.pending .bubble", { hasText: "queued while working" }).first()).toBeVisible();
});

// Deterministic guard for the loading-window race (the prior test only caught it
// under real CI timing): a persisted pending send must render from localStorage
// immediately on mount, not wait for the first poll to return.
test("a persisted pending send shows during the post-reload loading window", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator("#msg").fill("queued while working");
  await page.locator("#sendbtn").click();
  await expect(page.locator(".msg.user.pending .bubble", { hasText: "queued while working" }).first()).toBeVisible();
  await expect.poll(() => env.readSendlog()).toContain("queued while working");

  // stall the post-reload poll (slow/loaded link) so the pane stays in "loading"
  const slow = async (r) => { await new Promise((x) => setTimeout(x, 6000)); await r.continue(); };
  await page.route("**/api/pane/transcript**", slow);
  await page.route("**/api/pane/read**", slow);

  await page.reload();
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".msg.user.pending .bubble", { hasText: "queued while working" }).first()).toBeVisible({ timeout: 4000 });
});

test("Shift+Enter sends; plain Enter stays a newline", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  const msg = page.locator("#msg");
  await msg.fill("shift send me");
  await msg.press("Enter");                       // newline — must NOT send
  await page.waitForTimeout(400);
  expect(env.readSendlog()).not.toContain("shift send me");
  await msg.press("Shift+Enter");                  // send
  await expect.poll(() => env.readSendlog()).toContain("shift send me");
});

test("a cached draft is restored when the pane is reopened", async ({ page }) => {
  await page.goto("/");
  // seed a draft directly (as if a prior failed send left it)
  await page.evaluate(() => localStorage.setItem("herdview:draft:w3:p1", "unsent draft"));
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator("#msg")).toHaveValue("unsent draft");
});
