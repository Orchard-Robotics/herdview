const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

const post = (page, body) => page.request.post(env.BASE_URL + "/api/worktree", { data: body });

test("valid worktree create calls herdr and launches an agent in it", async ({ page }) => {
  const r = await post(page, { cwd: "/repo", name: "sp/feature-x" });
  expect(r.ok()).toBeTruthy();
  const log = env.readSendlog();
  expect(log).toContain("WORKTREE\t/repo\tsp/feature-x"); // create on the given repo + branch
  expect(log).toContain("PANERUN\tw9:p1\tclaude");        // agent launched in the new worktree's pane
});

test("invalid branch names are rejected before touching herdr", async ({ page }) => {
  const bad = ["", "-lead", "/lead", ".hidden", "has space", "a;rm -rf /", "a$(x)", "a..b", "x".repeat(90)];
  for (const name of bad) {
    env.resetSendlog();
    const r = await post(page, { cwd: "/repo", name });
    expect(r.status(), `name=${JSON.stringify(name)}`).toBe(400);
    expect(env.readSendlog(), `name=${JSON.stringify(name)}`).not.toContain("WORKTREE");
  }
});

test("missing cwd is rejected", async ({ page }) => {
  const r = await post(page, { name: "ok-branch" });
  expect(r.status()).toBe(400);
});

test("a worktree result without a root pane doesn't try to run an agent", async ({ page }) => {
  env.patchState({ worktreeResult: {} }); // herdr returned no root_pane
  const r = await post(page, { cwd: "/repo", name: "no-pane" });
  expect(r.ok()).toBeTruthy();
  const log = env.readSendlog();
  expect(log).toContain("WORKTREE\t/repo\tno-pane");
  expect(log).not.toContain("PANERUN"); // gracefully skipped, no crash
});

test("UI: + menu → New worktree prompts for a branch and creates it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".card").first()).toBeVisible(); // grid loaded → lastAgents populated
  page.on("dialog", (d) => d.accept("ui-branch")); // the branch-name prompt()
  await page.locator("#newwt").click();
  await page.locator('.sheet-b[data-act="worktree"]').click();
  // derives the repo from the focused agent (w3:p1 → /tmp/hvtest)
  await expect.poll(() => env.readSendlog()).toContain("WORKTREE\t/tmp/hvtest\tui-branch");
});
