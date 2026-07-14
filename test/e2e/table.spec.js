const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

const TABLE = [
  "Phase 1a verification:",
  "",
  "| | Baseline (homography) | Treatment (reproject) |",
  "|---|---:|---:|",
  "| single-depth frames | 80 / 80 | 0 / 80 |",
  "| multi-depth frames | 0 / 80 | 80 / 80 |",
  "| rows | 3997 | 3997 |",
  "",
  "Every frame now carries per-OBB apple depths.",
].join("\n");

test("a GFM table renders as an HTML table, not raw pipes", async ({ page }) => {
  env.appendTranscript(env.assistantTurn(TABLE));
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const table = page.locator(".msg.assistant .bubble .md-table").last();
  await expect(table).toBeVisible();

  // header row (first cell empty) + 2 data columns
  await expect(table.locator("thead th")).toHaveCount(3);
  await expect(table.locator("thead th", { hasText: "Baseline (homography)" })).toBeVisible();
  // three body rows, each with three cells
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr", { hasText: "single-depth frames" }).locator("td")).toHaveCount(3);

  // alignment from the `---:` delimiter carried onto the numeric column
  await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveCSS("text-align", "right");

  // prose around the table still renders as normal bubbles
  await expect(page.locator(".msg.assistant .bubble", { hasText: "per-OBB apple depths" }).last()).toBeVisible();
  // and no raw pipe delimiter leaked into the text
  await expect(page.locator(".bubble", { hasText: "|---|" })).toHaveCount(0);
});
