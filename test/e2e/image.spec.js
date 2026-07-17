const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// 1x1 transparent PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a herdview-image with a data: URI renders an <img> + caption", async ({ page }) => {
  const block = ["```herdview-image", JSON.stringify({ src: PNG, caption: "depth map" }), "```"].join("\n");
  env.setTranscript([env.assistantTurn(block)]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const img = page.locator("figure.hv-image img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", PNG);
  await expect(page.locator("figure.hv-image figcaption")).toContainText("depth map");
});

test("a herdview-image with {path} builds a same-origin /api/pane/image URL", async ({ page }) => {
  const block = ["```herdview-image", JSON.stringify({ path: "/mnt/storage/tmp/plot.png", caption: "plot" }), "```"].join("\n");
  env.setTranscript([env.assistantTurn(block)]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const img = page.locator("figure.hv-image img");
  await expect(img).toBeVisible();
  const src = await img.getAttribute("src");
  expect(src).toContain("/api/pane/image?");
  expect(src).toContain("pane=w3%3Ap1");
  expect(src).toContain("path=" + encodeURIComponent("/mnt/storage/tmp/plot.png"));
});

test("an external image URL is refused (falls back to a code block, no <img>)", async ({ page }) => {
  const block = ["```herdview-image", JSON.stringify({ src: "https://evil.example/x.png" }), "```"].join("\n");
  env.setTranscript([env.assistantTurn(block)]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  await expect(page.locator("figure.hv-image")).toHaveCount(0);
  await expect(page.locator("pre.md-code", { hasText: "evil.example" })).toBeVisible();
});
