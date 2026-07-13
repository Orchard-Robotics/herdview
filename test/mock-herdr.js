#!/usr/bin/env node
// Fake `herdr` CLI for herdview's tests. The server invokes this via
// HERDR_BIN_PATH and shells out per call, so tests get deterministic, offline
// behavior with zero backend changes. Scenario state is read fresh from
// $MOCKHERDR_STATE on every invocation; sends are recorded to $MOCKHERDR_SENDLOG.
//
// Multi-session: the server sets HERDR_SOCKET_PATH per session (aggregate view).
// state.sessions (array of {name,socket,agents,read,processInfo,...}) drives it;
// with no state.sessions we synthesize a single "default" session from the
// top-level agents/read/processInfo fields (back-compat with single-session specs).
const fs = require("fs");

const args = process.argv.slice(2);
const statePath = process.env.MOCKHERDR_STATE;
const sendlog = process.env.MOCKHERDR_SENDLOG;
const sock = process.env.HERDR_SOCKET_PATH || "";

function state() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; }
}
function out(v) { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); }

const s = state();

function sessions() {
  if (Array.isArray(s.sessions)) return s.sessions;
  return [{
    name: "default", socket: "MOCK_DEFAULT", running: true,
    agents: s.agents || [], read: s.read || {}, processInfo: s.processInfo || {},
    sendShouldFail: s.sendShouldFail, worktreeResult: s.worktreeResult,
  }];
}
function current() {
  const ss = sessions();
  return ss.find((x) => x.socket === sock) || ss[0] || {};
}
function record(line) { try { if (sendlog) fs.appendFileSync(sendlog, line + "\t" + (current().name || "") + "\n"); } catch {} }

const [a, b] = args;

if (a === "session" && b === "list") {
  out({ sessions: sessions().map((x) => ({ name: x.name, running: x.running !== false, socket_path: x.socket })) });
  process.exit(0);
}
if (a === "agent" && b === "list") {
  out({ id: "cli:agent:list", result: { agents: current().agents || [], type: "agent_list" } });
  process.exit(0);
}
if (a === "pane" && b === "read") {
  out((current().read && current().read[args[2]]) || "");
  process.exit(0);
}
if (a === "pane" && b === "send-text") {
  if (current().sendShouldFail) { process.stderr.write("mock: send-text failed\n"); process.exit(1); }
  record("SENDTEXT\t" + args[2] + "\t" + JSON.stringify(args[3]));
  process.exit(0);
}
if (a === "pane" && b === "send-keys") {
  record("SENDKEYS\t" + args[2] + "\t" + args.slice(3).join(" "));
  process.exit(0);
}
if (a === "pane" && b === "process-info") {
  const i = args.indexOf("--pane");
  const pane = i >= 0 ? args[i + 1] : "";
  const pid = current().processInfo && current().processInfo[pane];
  if (!pid) { out({ result: { process_info: {} } }); process.exit(0); }
  out({ result: { process_info: { shell_pid: pid, foreground_processes: [{ pid }] } } });
  process.exit(0);
}
if (a === "agent" && b === "rename") { process.exit(0); }
if (a === "worktree" && b === "create") {
  const ci = args.indexOf("--cwd"), bi = args.indexOf("--branch");
  record("WORKTREE\t" + (ci >= 0 ? args[ci + 1] : "") + "\t" + (bi >= 0 ? args[bi + 1] : ""));
  const wt = (current().worktreeResult !== undefined)
    ? current().worktreeResult
    : { root_pane: { pane_id: "w9:p1" }, worktree: { path: "/tmp/wt/" + (bi >= 0 ? args[bi + 1] : "x") } };
  out({ result: wt || {} });
  process.exit(0);
}
if (a === "tab" && b === "create") { record("TABCREATE\t" + (args.indexOf("--cwd") >= 0 ? args[args.indexOf("--cwd") + 1] : "")); out({ result: { root_pane: { pane_id: "w9:p2" } } }); process.exit(0); }
if (a === "pane" && b === "run") { record("PANERUN\t" + args[2] + "\t" + args.slice(3).join(" ")); process.exit(0); }

// unknown subcommand -> empty success
process.exit(0);
