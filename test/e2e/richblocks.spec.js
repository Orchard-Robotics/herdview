const { test, expect } = require("@playwright/test");
const env = require("../support/env");

const RICH = [
  "Here are the results:",
  "",
  "```herdview-card",
  JSON.stringify({ title: "Phase 1a verification", status: "ok",
    rows: [{ label: "single-depth frames", value: "80/80" }, { label: "tracking", value: "3997 rows" }],
    progress: [{ label: "apples localized", value: 2035, max: 3997 }] }),
  "```",
  "",
  "```herdview-chart",
  JSON.stringify({ type: "bar", title: "runtime (s)", data: [{ label: "baseline", value: 33.5 }, { label: "treatment", value: 47.9 }] }),
  "```",
  "",
  "```herdview-chart",
  JSON.stringify({ type: "line", title: "loss", points: [0.9, 0.7, 0.55, 0.4, 0.31] }),
  "```",
  "",
  "```html-widget",
  "<div style='padding:10px;border:1px solid #888;border-radius:8px'>hello <b>widget</b></div>",
  "```",
].join("\n");

test.beforeEach(() => env.resetScenario());

test("agent-emitted rich blocks render as card / chart / widget", async ({ page }) => {
  env.setTranscript([env.assistantTurn(RICH)]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  // card
  await expect(page.locator(".hv-card .hv-cardt")).toContainText("Phase 1a verification");
  await expect(page.locator(".hv-card .hv-st-ok")).toBeVisible();
  await expect(page.locator(".hv-kv", { hasText: "single-depth frames" })).toBeVisible();
  await expect(page.locator(".hv-card .hv-barf")).toBeVisible(); // progress bar

  // charts: a bar chart with labeled rows + a line sparkline
  await expect(page.locator(".hv-chart .hv-brow", { hasText: "baseline" })).toBeVisible();
  await expect(page.locator("svg.hv-spark")).toBeVisible();

  // sandboxed widget
  const w = page.locator("iframe.hv-widget");
  await expect(w).toBeVisible();
  await expect(w).toHaveAttribute("sandbox", "allow-scripts"); // no allow-same-origin
  await expect(w).toHaveAttribute("srcdoc", /hello/);

  await page.screenshot({ path: process.env.HV_SHOT || "/tmp/richblocks.png", fullPage: true });
});

test("a ```diff fence renders colorized", async ({ page }) => {
  env.setTranscript([env.assistantTurn(["```diff", "@@ -1 +1 @@", "-old line", "+new line", "```"].join("\n"))]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".diffbody .dl.dadd", { hasText: "new line" })).toBeVisible();
  await expect(page.locator(".diffbody .dl.ddel", { hasText: "old line" })).toBeVisible();
});

test("GitHub callouts render as styled admonitions", async ({ page }) => {
  env.setTranscript([env.assistantTurn("> [!WARNING]\n> radio sleep can drop the link")]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".callout.callout-warning .callout-h")).toContainText(/warning/i);
  await expect(page.locator(".callout.callout-warning", { hasText: "radio sleep" })).toBeVisible();
});

test("bad JSON falls back to a raw code block (never lost)", async ({ page }) => {
  env.setTranscript([env.assistantTurn("```herdview-card\n{not valid json,}\n```")]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".hv-card")).toHaveCount(0);
  await expect(page.locator("pre.md-code", { hasText: "not valid json" })).toBeVisible();
});

test("the ⚙ toggle switches rich blocks off (raw) and back on", async ({ page }) => {
  env.setTranscript([env.assistantTurn(RICH)]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".hv-card")).toBeVisible();

  await page.locator("#settings").click();
  await page.locator(".sheet-b", { hasText: "Render rich blocks" }).click(); // flips + reloads
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".hv-card")).toHaveCount(0);
  await expect(page.locator("pre.md-code").first()).toBeVisible(); // now raw
});
