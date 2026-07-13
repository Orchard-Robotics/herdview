// Shared paths + scenario helpers for herdview's browser tests. Tests import
// this to drive the mock herdr (agent list / read / send behavior) and the fake
// $HOME transcript at runtime. Everything lives under test/.runtime (gitignored).
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");        // test/
const REPO = path.resolve(ROOT, "..");             // repo root
const RUNTIME = path.join(ROOT, ".runtime");
const HOME = path.join(RUNTIME, "home");
const STATE = path.join(RUNTIME, "state.json");
const SENDLOG = path.join(RUNTIME, "sendlog.txt");
const SERVER_BIN = path.join(RUNTIME, "herdview-test");
const PIDFILE = path.join(RUNTIME, "server.pid");
const SERVER_LOG = path.join(RUNTIME, "server.log");
const MOCK = path.join(ROOT, "mock-herdr.js");
const PORT = 8899;
const BASE_URL = "http://127.0.0.1:" + PORT;

// transcript chain: pane w3:p1 -> pid 999001 -> sessionId testsid001 -> jsonl
const CWD = "/tmp/hvtest";
const SESSION_PID = 999001;
const SESSION_ID = "testsid001";
const TRANSCRIPT = path.join(HOME, ".claude", "projects", "testproj", SESSION_ID + ".jsonl");

const DEFAULT_STATE = {
  agents: [
    { agent: "claude", agent_status: "blocked", name: "needs-you", cwd: CWD, foreground_cwd: CWD, pane_id: "w3:p1", tab_id: "w3:t1", workspace_id: "w3", focused: true },
    { agent: "claude", agent_status: "working", name: "builder", cwd: CWD, foreground_cwd: CWD, pane_id: "w1:p5", tab_id: "w1:t5", workspace_id: "w1", focused: false },
    { agent: "claude", agent_status: "idle", cwd: CWD, foreground_cwd: CWD, pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: false },
  ],
  read: { "w3:p1": "recent output line 1\nrecent output line 2" },
  processInfo: { "w3:p1": SESSION_PID },
  sendShouldFail: false,
};

const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const readState = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const patchState = (patch) => writeState({ ...readState(), ...patch });
const resetState = () => writeState(JSON.parse(JSON.stringify(DEFAULT_STATE)));
const resetSendlog = () => fs.writeFileSync(SENDLOG, "");
const readSendlog = () => { try { return fs.readFileSync(SENDLOG, "utf8"); } catch { return ""; } };

const userTurn = (text) => ({ type: "user", message: { role: "user", content: text } });
const assistantTurn = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

function setTranscript(objs) {
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  fs.writeFileSync(TRANSCRIPT, objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
}
const appendTranscript = (obj) => fs.appendFileSync(TRANSCRIPT, JSON.stringify(obj) + "\n");

// Reset all mutable scenario state to defaults (call in beforeEach).
function resetScenario() {
  resetState(); // DEFAULT_STATE has no `sessions` key → mock falls back to a single "default" session
  resetSendlog();
  setTranscript([assistantTurn("hello from the transcript")]);
}

// Build an agent record for a fixture.
function mkAgent(pane, status, extra = {}) {
  const ws = pane.split(":")[0];
  return {
    agent: "claude", agent_status: status,
    cwd: extra.cwd || CWD, foreground_cwd: extra.cwd || CWD,
    pane_id: pane, tab_id: ws + ":t" + pane.split(":p")[1], workspace_id: ws,
    focused: !!extra.focused, ...(extra.name ? { name: extra.name } : {}),
  };
}

// Replace the single-session state with several sessions (aggregate view).
// list: [{name, agents, read?, processInfo?, sendShouldFail?}] — sockets synthesized.
function setSessions(list) {
  const sessions = list.map((x) => ({
    name: x.name, socket: "MOCK_" + x.name, running: x.running !== false,
    agents: x.agents || [], read: x.read || {}, processInfo: x.processInfo || {},
    sendShouldFail: !!x.sendShouldFail,
  }));
  const st = readState();
  st.sessions = sessions;
  writeState(st);
}

module.exports = {
  ROOT, REPO, RUNTIME, HOME, STATE, SENDLOG, SERVER_BIN, PIDFILE, SERVER_LOG, MOCK, PORT, BASE_URL,
  CWD, SESSION_PID, SESSION_ID, TRANSCRIPT, DEFAULT_STATE,
  writeState, readState, patchState, resetState, resetSendlog, readSendlog,
  setTranscript, appendTranscript, userTurn, assistantTurn, resetScenario,
  mkAgent, setSessions,
};
