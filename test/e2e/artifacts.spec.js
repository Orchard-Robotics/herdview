const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

test("artifact links in the transcript are collected and open in a new tab", async ({ page }) => {
  const url = "https://claude.ai/code/artifact/abc123de-0000-1111-2222-333344445555";
  env.setTranscript([env.assistantTurn("All done — here's your artifact: " + url + " enjoy")]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const header = page.locator(".artifacts .art-h");
  await expect(header).toContainText("Artifacts (1)");
  await header.click(); // expand the collection

  const link = page.locator(".art-item");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", url);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("no artifact panel when there are no artifact links", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".msg").first()).toBeVisible(); // detail loaded
  await expect(page.locator(".artifacts")).toHaveCount(0);
});
