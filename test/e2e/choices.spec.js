const { test, expect } = require("@playwright/test");
const env = require("../support/env");

// A real AskUserQuestion-style picker as it appears in the terminal read.
const PICKER = [
  " ☐ Fruit", "", "Which fruit?", "",
  "❯ 1. Apple", "     A crisp, common orchard fruit.",
  "  2. Banana", "     A soft, yellow tropical fruit.",
  "  3. Cherry", "     A small, red stone fruit.",
  "─────────────────────────────",
  "  4. Chat about this", "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

test.beforeEach(() => env.resetScenario());

test("a blocked picker renders tappable options; tapping sends the digit", async ({ page }) => {
  // w3:p1 is the blocked agent in the default fixture; give it a picker as its read.
  env.patchState({ read: { "w3:p1": PICKER } });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  // question + one button per option
  await expect(page.locator(".keys .permh")).toContainText("Which fruit?");
  await expect(page.locator(".permbtns.choices .key")).toHaveCount(4);
  await expect(page.locator(".permbtns.choices .key", { hasText: "Apple" })).toBeVisible();

  // tap Cherry (option 3) → the digit "3" is sent (selects + submits)
  await page.locator(".permbtns.choices .key", { hasText: "Cherry" }).click();
  await expect.poll(() => env.readSendlog()).toMatch(/SENDKEYS\tw3:p1\t3/);

  // chosen option highlighted, the rest greyed out and non-interactive (sent state)
  await expect(page.locator(".permbtns.choices .key.chosen", { hasText: "Cherry" })).toBeVisible();
  await expect(page.locator(".permbtns.choices .key.dimmed", { hasText: "Apple" })).toBeVisible();
  await expect(page.locator(".permbtns.choices .key", { hasText: "Apple" })).toBeDisabled();
  await expect(page.locator(".keys .hint")).toContainText(/waiting/i);
});

function picker(question, opts) {
  const lines = [" ☐ Q", "", question, ""];
  opts.forEach((o, i) => { lines.push((i === 0 ? "❯ " : "  ") + (i + 1) + ". " + o, "     a description"); });
  lines.push("  " + (opts.length + 1) + ". Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel");
  return lines.join("\n");
}

test("multi-part: after answering one question, the next one is answerable", async ({ page }) => {
  env.patchState({ read: { "w3:p1": picker("Which fruit?", ["Apple", "Banana"]) } });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".keys .permh")).toContainText("Which fruit?");

  await page.locator(".permbtns.choices .key", { hasText: "Apple" }).click();
  await expect(page.locator(".permbtns.choices .key", { hasText: "Banana" })).toBeDisabled(); // chosen → greyed

  // agent advances to part 2 (the terminal now shows the next question)
  env.patchState({ read: { "w3:p1": picker("Which color?", ["Red", "Blue"]) } });
  await expect(page.locator(".keys .permh")).toContainText("Which color?");
  await expect(page.locator(".permbtns.choices .key", { hasText: "Red" })).toBeEnabled(); // re-enabled, not stuck greyed
  await page.locator(".permbtns.choices .key", { hasText: "Blue" }).click();
  await expect.poll(() => env.readSendlog()).toMatch(/SENDKEYS\tw3:p1\t2/); // Blue = option 2
});

test("without a picker, the generic approve/deny keys still show for a blocked agent", async ({ page }) => {
  // default read is plain terminal text (not a picker)
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();
  await expect(page.locator(".permbtns.choices")).toHaveCount(0);
  await expect(page.locator(".permbtns .key", { hasText: "Approve" })).toBeVisible();
});
