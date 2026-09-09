const { test, expect } = require("@playwright/test");
const env = require("../support/env");

test.beforeEach(() => env.resetScenario());

// herdr names a workspace (`herdr workspace list` → label) and a session; the
// mirror should show those names, not the raw w<N> id.
test("agent cards and the header carry herdr's workspace and session names", async ({ page }) => {
  await page.goto("/");

  const card = page.locator('[data-pane="w3:p1"]');
  await expect(card.locator(".meta")).toContainText("acme-api · pane 1");
  await expect(card.locator(".meta")).not.toContainText("workspace w3");
  // the raw id stays reachable as the tooltip
  await expect(card.locator(".meta span").first()).toHaveAttribute("title", "w3:p1");
  // a card in the other workspace gets that workspace's label
  await expect(page.locator('[data-pane="w1:p5"]').locator(".meta")).toContainText("acme-web · pane 5");

  // single session → the header names it instead of showing only the brand
  await expect(page.locator("h1")).toContainText("default");

  // detail view keeps the workspace name and adds the session
  await card.click();
  await expect(page.locator("h1 .hsub, .card.selected .meta").first()).toContainText("acme-api");
});

test("an unlabelled workspace falls back to the raw workspace id", async ({ page }) => {
  env.patchState({ workspaces: [] });
  await page.goto("/");
  await expect(page.locator('[data-pane="w3:p1"]').locator(".meta")).toContainText("workspace 3 · pane 1");
});

test("the session name shows per session in the aggregate view", async ({ page }) => {
  env.setSessions([
    {
      name: "achyut",
      agents: [env.mkAgent("w4:p1", "idle")],
      workspaces: [{ workspace_id: "w4", label: "fruitscope-ml" }],
      processInfo: {},
    },
    {
      name: "travis",
      agents: [env.mkAgent("w2:p1", "idle")],
      workspaces: [{ workspace_id: "w2", label: "camera-2" }],
      processInfo: {},
    },
  ]);
  await page.goto("/");

  // session gate first, then the picked session names the header
  await page.locator('[data-session-name="achyut"]').click();
  await expect(page.locator("h1")).toContainText("achyut");
  await expect(page.locator('[data-pane="w4:p1"]').locator(".meta")).toContainText("fruitscope-ml · pane 1");
});

// The terminal prints the inline diff of an Edit under the tool line; the mirror
// should too, for edits that already happened — not only for a blocked one.
const editTurn = (file, oldS, newS) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", name: "Edit", input: { file_path: file, old_string: oldS, new_string: newS } }],
  },
});

test("a completed Edit shows its inline code change in the chat", async ({ page }) => {
  env.setTranscript([
    env.assistantTurn("bumping the cap"),
    editTurn("/tmp/hvtest/psrc/pconstants.py", "MAX_APPLES = 10", "MAX_APPLES = 20"),
  ]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const d = page.locator(".msgs .tooldiff").last();
  await expect(d).toBeVisible();
  await expect(d.locator("summary")).toContainText("Edit");
  await expect(d.locator(".tdpath")).toContainText("pconstants.py");
  await expect(d.locator(".tdstat")).toContainText("+1");
  await expect(d.locator(".tdstat")).toContainText("1");
  await expect(d.locator(".diffbody .dl.ddel", { hasText: "MAX_APPLES = 10" })).toBeVisible();
  await expect(d.locator(".diffbody .dl.dadd", { hasText: "MAX_APPLES = 20" })).toBeVisible();
  // a short diff is expanded, matching what the terminal already showed
  await expect(d).toHaveAttribute("open", "");
});

test("a long inline diff starts collapsed so it can't bury the chat", async ({ page }) => {
  const many = Array.from({ length: 60 }, (_, i) => "line " + i).join("\n");
  env.setTranscript([
    env.assistantTurn("rewriting the block"),
    editTurn("/tmp/hvtest/big.py", many, many + "\nline 60"),
  ]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  const d = page.locator(".msgs .tooldiff").last();
  await expect(d).toBeVisible();
  expect(await d.getAttribute("open")).toBeNull();
  // expanding it reveals the diff
  await d.locator("summary").click();
  await expect(d.locator(".diffbody .dl.dadd").first()).toBeVisible();
});

test("a tool call with no diff adds no diff block", async ({ page }) => {
  env.setTranscript([
    env.assistantTurn("looking around"),
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
    },
  ]);
  await page.goto("/");
  await page.locator('[data-pane="w3:p1"]').click();

  await expect(page.locator(".msgs .sys", { hasText: "Bash" })).toBeVisible();
  await expect(page.locator(".msgs .tooldiff")).toHaveCount(0);
});
