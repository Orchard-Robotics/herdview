#!/usr/bin/env node
// Fake `herdr` CLI for herdview's tests. The server invokes this via
// HERDR_BIN_PATH and shells out per call, so tests get deterministic, offline
// behavior with zero backend changes. Scenario state is read fresh from
// $MOCKHERDR_STATE on every invocation (so a test can change behavior at
// runtime just by rewriting that file); sends are recorded to $MOCKHERDR_SENDLOG.
const fs = require("fs");

const args = process.argv.slice(2);
const statePath = process.env.MOCKHERDR_STATE;
const sendlog = process.env.MOCKHERDR_SENDLOG;

function state() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; }
}
function out(v) { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); }
function record(line) { try { if (sendlog) fs.appendFileSync(sendlog, line + "\n"); } catch {} }

const s = state();
const [a, b] = args;

if (a === "agent" && b === "list") {
  out({ id: "cli:agent:list", result: { agents: s.agents || [], type: "agent_list" } });
  process.exit(0);
}
if (a === "pane" && b === "read") {
  const pane = args[2];
  out((s.read && s.read[pane]) || "");
  process.exit(0);
}
if (a === "pane" && b === "send-text") {
  const pane = args[2], text = args[3];
  if (s.sendShouldFail) { process.stderr.write("mock: send-text failed\n"); process.exit(1); }
  record("SENDTEXT\t" + pane + "\t" + JSON.stringify(text));
  process.exit(0);
}
if (a === "pane" && b === "send-keys") {
  record("SENDKEYS\t" + args[2] + "\t" + args.slice(3).join(" "));
  process.exit(0);
}
if (a === "pane" && b === "process-info") {
  const i = args.indexOf("--pane");
  const pane = i >= 0 ? args[i + 1] : "";
  const pid = s.processInfo && s.processInfo[pane];
  if (!pid) { out({ result: { process_info: {} } }); process.exit(0); }
  out({ result: { process_info: { shell_pid: pid, foreground_processes: [{ pid }] } } });
  process.exit(0);
}
if (a === "agent" && b === "rename") { process.exit(0); }
if (a === "worktree" && b === "create") {
  const ci = args.indexOf("--cwd"), bi = args.indexOf("--branch");
  record("WORKTREE\t" + (ci >= 0 ? args[ci + 1] : "") + "\t" + (bi >= 0 ? args[bi + 1] : ""));
  // configurable result; default includes a root_pane so `pane run` fires
  const wt = ("worktreeResult" in s)
    ? s.worktreeResult
    : { root_pane: { pane_id: "w9:p1" }, worktree: { path: "/tmp/wt/" + (bi >= 0 ? args[bi + 1] : "x") } };
  out({ result: wt || {} });
  process.exit(0);
}
if (a === "tab" && b === "create") { record("TABCREATE\t" + (args.indexOf("--cwd") >= 0 ? args[args.indexOf("--cwd") + 1] : "")); out({ result: { root_pane: { pane_id: "w9:p2" } } }); process.exit(0); }
if (a === "pane" && b === "run") { record("PANERUN\t" + args[2] + "\t" + args.slice(3).join(" ")); process.exit(0); }

// unknown subcommand -> empty success
process.exit(0);
