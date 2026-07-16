const { test, expect } = require("@playwright/test");
const env = require("../support/env");

const DIFF = {
  branch_name: "feat/thing",
  stat: " a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
  diff: [
    "diff --git a/a.txt b/a.txt",
    "index 1111111..2222222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    " a context line",
    "-an old line",
    "+a new line",
  ].join("\n"),
  untracked: ["newfile.js", "docs/todo.md"],
  truncated: false,
};

test.beforeEach(() => env.resetScenario());

test("the diff tool shows a colored working diff + untracked files", async ({ page }) => {
  await page.route("**/api/pane/diff**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(DIFF) }));
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator(".dtool").click();

  await expect(page.locator(".diffov")).toBeVisible();
  await expect(page.locator(".diffttl")).toContainText("feat/thing");
  await expect(page.locator(".diffstat")).toContainText("1 file changed");
  await expect(page.locator(".diffbody .dl.dgit", { hasText: "a.txt" })).toBeVisible();
  await expect(page.locator(".diffbody .dl.dadd", { hasText: "a new line" })).toBeVisible();
  await expect(page.locator(".diffbody .dl.ddel", { hasText: "an old line" })).toBeVisible();
  await expect(page.locator(".untr", { hasText: "newfile.js" })).toBeVisible();

  await page.locator(".diffov .minbtn").click();
  await expect(page.locator(".diffov")).toHaveCount(0);
});

test("diff content is rendered as text, never injected", async ({ page }) => {
  const evil = { branch_name: "x", stat: "", untracked: [], truncated: false,
    diff: "+<img src=x onerror=window.__pwned=1>" };
  await page.route("**/api/pane/diff**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(evil) }));
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator(".dtool").click();
  await expect(page.locator(".diffbody .dl.dadd")).toContainText("<img");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test("diff tool shows a friendly message when the agent has no git repo", async ({ page }) => {
  await page.route("**/api/pane/diff**", (r) => r.fulfill({ status: 404, body: "not a git repository" }));
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await page.locator(".dtool").click();
  await expect(page.locator(".diffov .sys", { hasText: /no git repo/i })).toBeVisible();
});
