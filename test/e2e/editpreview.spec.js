const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// A blocked agent's pending Edit should show WHAT it wants to change (old→new as
// a diff) in the approval card, not just the file path.
test("a blocked Edit shows the proposed change as a diff", async ({ page }) => {
  const editTurn = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        name: "Edit",
        input: {
          file_path: "/mnt/storage/Code/fruitscope-camera-2/psrc/utilities/pconstants.py",
          old_string: "MAX_APPLES = 10",
          new_string: "MAX_APPLES = 20",
        },
      }],
    },
  };
  env.setTranscript([env.assistantTurn("updating that constant"), editTurn]);

  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click(); // blocked agent in the fixture

  await expect(page.locator(".permcard .permh")).toContainText("Waiting for you");
  await expect(page.locator(".permcard .permname")).toContainText("Edit");
  await expect(page.locator(".permcard .permpath")).toContainText("pconstants.py");
  await expect(page.locator(".permcard .diffbody .dl.ddel", { hasText: "MAX_APPLES = 10" })).toBeVisible();
  await expect(page.locator(".permcard .diffbody .dl.dadd", { hasText: "MAX_APPLES = 20" })).toBeVisible();
  // approve stays reachable (vertical-priority + .keys internal scroll)
  await expect(page.locator(".permbtns .key", { hasText: "Approve" })).toBeVisible();
});
