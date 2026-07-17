const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// A tool-permission prompt has a ❯ cursor on a numbered option but NO
// "…to navigate…select…" footer — it used to fall through to the blind ↓/↑
// approve arrows. It should now render its REAL options as tappable buttons.
const BASH_PERM = [
  "Bash command",
  "  npm test",
  "  Run the test suite",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for npm commands in /repo",
  "  3. No, and tell Claude what to do differently (esc)",
].join("\n");

test("a permission prompt shows its real options, not the generic arrows", async ({ page }) => {
  env.patchState({ read: { "w3:p1": BASH_PERM } });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  // the prompt's own question + one button per real option
  await expect(page.locator(".keys .permh")).toContainText("Do you want to proceed?");
  await expect(page.locator(".permbtns.choices .key")).toHaveCount(3);
  await expect(page.locator(".permbtns.choices .key", { hasText: "Yes" }).first()).toBeVisible();
  await expect(page.locator(".permbtns.choices .key", { hasText: "No, and tell Claude" })).toBeVisible();

  // the blind up/down + generic Approve fallback is gone for a parsed prompt
  await expect(page.locator(".permbtns .key", { hasText: "↓" })).toHaveCount(0);
  await expect(page.locator(".permbtns .key", { hasText: "Approve" })).toHaveCount(0);

  // tapping "No" (option 3) sends the digit 3 — one decision, one keystroke
  await page.locator(".permbtns.choices .key", { hasText: "No, and tell Claude" }).click();
  await expect.poll(() => env.readSendlog()).toMatch(/SENDKEYS\tw3:p1\t3/);
});

// The same prompt drawn inside a box (vertical borders) must parse identically.
const BOXED_PERM = [
  "╭────────────────────────────────────────────────╮",
  "│ Edit file                                        │",
  "│                                                  │",
  "│ Do you want to make this edit to main.go?        │",
  "│ ❯ 1. Yes                                         │",
  "│   2. Yes, allow all edits this session           │",
  "│   3. No, and tell Claude what to do differently  │",
  "╰────────────────────────────────────────────────╯",
].join("\n");

test("a boxed permission prompt parses the same as an unboxed one", async ({ page }) => {
  env.patchState({ read: { "w3:p1": BOXED_PERM } });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  await expect(page.locator(".keys .permh")).toContainText("Do you want to make this edit to main.go?");
  await expect(page.locator(".permbtns.choices .key")).toHaveCount(3);
  await expect(page.locator(".permbtns .key", { hasText: "↓" })).toHaveCount(0);
});

// A numbered list the agent printed right before the prompt must NOT bleed into
// the options (that would add bogus buttons and mis-map the tapped digit).
const DECOY_PERM = [
  "Here's my plan:",
  "1. Refactor the parser",
  "2. Add tests",
  "3. Update docs",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do differently (esc)",
].join("\n");

test("a numbered list above the prompt does not leak into the options", async ({ page }) => {
  env.patchState({ read: { "w3:p1": DECOY_PERM } });
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  await expect(page.locator(".keys .permh")).toContainText("Do you want to proceed?");
  await expect(page.locator(".permbtns.choices .key")).toHaveCount(3); // not 6
  await expect(page.locator(".permbtns.choices .key", { hasText: "Refactor the parser" })).toHaveCount(0);

  // tapping "No" sends 3 — the real option's digit, not a decoy's
  await page.locator(".permbtns.choices .key", { hasText: "No, and tell Claude" }).click();
  await expect.poll(() => env.readSendlog()).toMatch(/SENDKEYS\tw3:p1\t3/);
});
