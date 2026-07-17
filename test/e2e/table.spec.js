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

test("a wide table scrolls inside its bubble, not off the chat window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 }); // phone width
  const wide = [
    "| " + Array.from({ length: 8 }, (_, i) => "column header " + (i + 1)).join(" | ") + " |",
    "|" + "---|".repeat(8),
    "| " + Array.from({ length: 8 }, (_, i) => "long-ish cell value " + (i + 1)).join(" | ") + " |",
  ].join("\n");
  env.appendTranscript(env.assistantTurn(wide));
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const wrap = page.locator(".md-table-wrap").last();
  await expect(wrap).toBeVisible();
  const m = await wrap.evaluate((el) => ({
    wrapClient: el.clientWidth, wrapScroll: el.scrollWidth,
    bubbleClient: el.closest(".bubble").clientWidth,
    docScroll: document.documentElement.scrollWidth, win: window.innerWidth,
  }));
  expect(m.wrapScroll).toBeGreaterThan(m.wrapClient);       // table overflows the wrap → scrolls inside it
  expect(m.wrapClient).toBeLessThanOrEqual(m.bubbleClient); // wrap constrained to the bubble
  expect(m.docScroll).toBeLessThanOrEqual(m.win + 1);       // no page-level horizontal overflow
});
