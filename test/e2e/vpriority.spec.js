const { test, expect } = require("@playwright/test");
const env = require("../support/env");

// A blocked agent whose read is a big task block: parseChoices sees no picker →
// generic approve/deny keys show, parseTasks fills a large Tasks panel.
const BIG_TASKS = ["14 tasks (2 done, 12 open)"]
  .concat(Array.from({ length: 14 }, (_, i) => (i < 2 ? "  ✔ " : "  ◻ ") + "task item number " + (i + 1) + " — a reasonably long label"))
  .join("\n");

test.beforeEach(() => env.resetScenario());

// Regression guard: tasks + artifacts must never push the compose box / approve
// module off-screen. They shrink-with-scroll; the textbox + approve are pinned.
test("textbox + approve stay in the viewport when tasks/artifacts crowd a short screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 430 }); // deliberately cramped
  env.patchState({ read: { "w3:p1": BIG_TASKS } });        // w3:p1 is blocked in the fixture
  await page.addInitScript(() => {
    const arts = Array.from({ length: 12 }, (_, i) => "https://claude.ai/code/artifact/seed-artifact-link-number-" + i);
    try { localStorage.setItem("herdview:artifacts:default:w3:p1", JSON.stringify(arts)); } catch {}
  });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  // both big panels are present (and capped/scrollable, not consuming everything)
  await expect(page.locator(".tasks")).toBeVisible();
  await expect(page.locator(".artifacts")).toBeVisible();

  // the whole point: these stay reachable
  await expect(page.locator("#msg")).toBeInViewport();
  await expect(page.locator("#sendbtn")).toBeInViewport();
  await expect(page.locator(".permbtns .key", { hasText: "Approve" })).toBeInViewport();
});
