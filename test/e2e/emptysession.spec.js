const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// A herdr session with no agents yet is still a real session you want to reach —
// it's where you'd start the first agent. The grid is built from the agent list,
// so without /api/sessions such a session is invisible and unreachable.
test("a running session with no agents still appears in the gate", async ({ page }) => {
  env.setSessions([
    { name: "busy", agents: [env.mkAgent("w1:p1", "idle", { name: "worker" })] },
    { name: "fresh", agents: [] },
  ]);
  await page.goto("/");

  await expect(page.locator('[data-session-name="busy"]')).toContainText("1 agent");
  await expect(page.locator('[data-session-name="fresh"]')).toContainText("0 agents");

  // drilling in lands on the empty state, not a blank screen
  await page.locator('[data-session-name="fresh"]').click();
  await expect(page.locator(".empty")).toContainText("No agents in this session");
  await expect(page.locator("h1")).toContainText("fresh");
  // and the ＋ affordance is still there, so the session is actually usable
  await expect(page.locator("#newwt")).toBeVisible();
});

test("+ New agent in an empty session targets that session", async ({ page }) => {
  env.setSessions([
    { name: "busy", agents: [env.mkAgent("w1:p1", "idle", { focused: true })] },
    { name: "fresh", agents: [] },
  ]);
  await page.goto("/");
  await page.locator('[data-session-name="fresh"]').click();
  await expect(page.locator(".empty")).toBeVisible();

  page.on("dialog", (d) => d.accept("/tmp/fresh-repo"));
  await page.locator("#newwt").click();
  await page.locator('.sheet-b[data-act="agent"]').click();

  // the mock records the session it was invoked against — must be "fresh",
  // not "busy" (which holds the only focused agent)
  await expect.poll(() => env.readSendlog()).toContain("TABCREATE\t/tmp/fresh-repo\tfresh");
  expect(env.readSendlog()).not.toContain("\tbusy\n");
});

// Regression: the ＋ actions used to derive their target from the globally
// focused agent, so creating while inside session A could land in session B.
test("+ New agent uses the session you're in, not a focused agent elsewhere", async ({ page }) => {
  env.setSessions([
    { name: "alpha", agents: [env.mkAgent("w1:p1", "idle", { cwd: "/repo/alpha" })] },
    { name: "beta", agents: [env.mkAgent("w2:p1", "idle", { cwd: "/repo/beta", focused: true })] },
  ]);
  await page.goto("/");
  await page.locator('[data-session-name="alpha"]').click();
  await expect(page.locator('.card[data-pane="w1:p1"]')).toBeVisible();

  page.on("dialog", (d) => d.accept(d.defaultValue() || "/repo/alpha"));
  await page.locator("#newwt").click();
  await page.locator('.sheet-b[data-act="agent"]').click();

  await expect.poll(() => env.readSendlog()).toContain("TABCREATE\t/repo/alpha\talpha");
  expect(env.readSendlog()).not.toContain("beta");
});

// A session herdr won't answer for (in the field: a server older than the CLI)
// may be full of agents we can't read — it must not claim to be empty.
test("a session herdr won't answer for is flagged, not reported as empty", async ({ page }) => {
  env.setSessions([
    { name: "readable", agents: [env.mkAgent("w1:p1", "idle")] },
    { name: "stale", agents: [env.mkAgent("w9:p9", "working")], agentListShouldFail: true },
  ]);
  await page.goto("/");

  const card = page.locator('[data-session-name="stale"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".pill")).toContainText("unreadable");
  await expect(card).not.toContainText("0 agents");
  await expect(card.locator(".path")).toContainText("restart this session's server");
  // its agents are genuinely unreadable, so none leak into the readable session
  await expect(page.locator('[data-session-name="readable"]').locator(".pill")).toContainText("1 agent");
});

test("the grid still renders when the session list is unavailable", async ({ page }) => {
  await page.route("**/api/sessions", (r) => r.abort());
  await page.goto("/");
  // falls back to sessions derived from the agents themselves
  await expect(page.locator(".card[data-pane]").first()).toBeVisible();
  await expect(page.locator(".error")).toHaveCount(0);
});
