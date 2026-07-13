// Aggressive edge cases — a bug-hunting dev cycle. Failures here are real bugs.
const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

async function openDetail(page, pane) {
  await page.goto("/");
  await page.locator(`[data-pane="${pane}"]`).click();
  await expect(page.locator("#msg")).toBeVisible();
}

test("empty / whitespace-only send does nothing", async ({ page }) => {
  await openDetail(page, "w3:p1");
  await page.locator("#msg").fill("   ");
  await page.locator("#sendbtn").click();
  await page.waitForTimeout(500);
  expect(env.readSendlog()).not.toContain("SENDTEXT");
  await expect(page.locator(".msg.user")).toHaveCount(0);
});

test("rapid sequential sends all reach herdr and stay visible", async ({ page }) => {
  await openDetail(page, "w3:p1");
  const msgs = ["one", "two", "three", "four", "five"];
  for (const m of msgs) {
    await page.locator("#msg").fill(m);
    await page.locator("#sendbtn").click(); // Playwright auto-waits for the btn to re-enable
  }
  // all five delivered to herdr
  for (const m of msgs) {
    await expect.poll(() => env.readSendlog()).toContain(`"${m}"`);
  }
  // all five visible as bubbles
  for (const m of msgs) {
    await expect(page.locator(".msg.user .bubble", { hasText: m }).first()).toBeVisible();
  }
});

test("duplicate messages both stay visible until each lands in the transcript", async ({ page }) => {
  await openDetail(page, "w3:p1");
  for (let i = 0; i < 2; i++) {
    await page.locator("#msg").fill("dup");
    await page.locator("#sendbtn").click();
  }
  await expect(page.locator(".msg.user .bubble", { hasText: "dup" })).toHaveCount(2);
  // exactly ONE copy lands in the transcript
  env.appendTranscript(env.userTurn("dup"));
  // wait until the transcript reload is observable (a confirmed, non-pending "dup" appears)
  await expect(page.locator(".msg.user:not(.pending) .bubble", { hasText: "dup" }).first()).toBeVisible({ timeout: 5000 });
  // BOTH bubbles must remain: one confirmed + one still pending — not collapsed to one
  await expect(page.locator(".msg.user .bubble", { hasText: "dup" })).toHaveCount(2);
});

test("sent message stays visible on a read-fallback pane (no transcript)", async ({ page }) => {
  // w1:p1 has no processInfo -> transcript 404 -> renderText fallback path
  await openDetail(page, "w1:p1");
  await page.locator("#msg").fill("readpath hello");
  await page.locator("#sendbtn").click();
  await page.waitForTimeout(2200); // several refresh cycles
  await expect(page.locator(".msg.user .bubble", { hasText: "readpath hello" }).first()).toBeVisible();
});

test("read-fallback pending resolves once the text appears in the terminal", async ({ page }) => {
  await openDetail(page, "w1:p1");
  await page.locator("#msg").fill("echoed cmd");
  await page.locator("#sendbtn").click();
  await expect(page.locator(".msg.user.pending .bubble", { hasText: "echoed cmd" }).first()).toBeVisible();
  env.patchState({ read: { "w1:p1": "$ echoed cmd\noutput here" } }); // terminal now echoes it
  await expect(page.locator(".msg.user.pending", { hasText: "echoed cmd" })).toHaveCount(0, { timeout: 5000 });
});

test("message text is rendered as text, never injected (XSS)", async ({ page }) => {
  await openDetail(page, "w3:p1");
  const payload = '<img src=x onerror="window.__xss=1">hi';
  await page.locator("#msg").fill(payload);
  await page.locator("#sendbtn").click();
  await expect(page.locator(".msg.user .bubble", { hasText: "hi" }).first()).toBeVisible();
  // no injected <img> and the onerror never fired
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator(".msg.user .bubble img").count()).toBe(0);
});

test("assistant transcript markdown does not inject script or js: links", async ({ page }) => {
  env.setTranscript([
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: 'see [click](javascript:window.__xss2=1) and <img src=x onerror="window.__xss3=1">' }] } },
  ]);
  await openDetail(page, "w3:p1");
  await expect(page.locator(".msg.assistant").first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__xss2)).toBeUndefined();
  expect(await page.evaluate(() => window.__xss3)).toBeUndefined();
  // any rendered anchor must not carry a javascript: href
  const hrefs = await page.locator(".msg.assistant a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  for (const h of hrefs) expect(h?.startsWith("javascript:")).toBeFalsy();
});

test("a long multi-line message with special chars survives the round-trip", async ({ page }) => {
  await openDetail(page, "w3:p1");
  const msg = "line1\nline2 with \"quotes\" and `backticks` and $(whoami) 🚀\n" + "x".repeat(3000);
  await page.locator("#msg").fill(msg);
  await page.locator("#sendbtn").click();
  await expect.poll(() => env.readSendlog()).toContain("$(whoami)");
  await expect.poll(() => env.readSendlog()).toContain("🚀");
});

test("drafts are isolated per pane", async ({ page }) => {
  await openDetail(page, "w3:p1");
  await page.locator("#msg").fill("draft for w3p1");
  await page.goto("/"); // leave without sending
  await page.locator('[data-pane="w1:p1"]').click();
  await expect(page.locator("#msg")).toHaveValue(""); // different pane → no draft
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator("#msg")).toHaveValue("draft for w3p1"); // restored
});
