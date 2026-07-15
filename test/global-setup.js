// Playwright globalSetup: build the herdview server, stand up a fake $HOME with a
// controllable Claude transcript, and launch the server against the mock herdr.
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const env = require("./support/env");

// Prefer $GO, then this Jetson's Go under ~/.local/go, else `go` on PATH (CI).
const LOCAL_GO = path.join(process.env.HOME || "", ".local", "go", "bin", "go");
const GO = process.env.GO || (fs.existsSync(LOCAL_GO) ? LOCAL_GO : "go");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function ping() {
  return new Promise((res) => {
    const req = http.get(env.BASE_URL + "/api/agents", (r) => { r.resume(); res(r.statusCode); });
    req.on("error", () => res(0));
    req.setTimeout(1000, () => { req.destroy(); res(0); });
  });
}

module.exports = async () => {
  fs.rmSync(env.RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(env.HOME, { recursive: true });

  // build the server from current source (embeds the current web/index.html)
  execFileSync(GO, ["build", "-o", env.SERVER_BIN, "./cmd/herdview"], { cwd: env.REPO, stdio: "inherit" });

  // fake $HOME transcript chain: sessions/<pid>.json -> sessionId -> jsonl
  fs.mkdirSync(path.join(env.HOME, ".claude", "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(env.HOME, ".claude", "sessions", env.SESSION_PID + ".json"),
    JSON.stringify({ sessionId: env.SESSION_ID, cwd: env.CWD })
  );

  env.resetScenario();
  fs.chmodSync(env.MOCK, 0o755);

  // launch the server against the mock herdr, detached so it survives setup
  const log = fs.openSync(env.SERVER_LOG, "w");
  const child = spawn(env.SERVER_BIN, ["--addr", "127.0.0.1:" + env.PORT], {
    env: {
      ...process.env,
      HOME: env.HOME,
      HERDR_BIN_PATH: env.MOCK,
      MOCKHERDR_STATE: env.STATE,
      MOCKHERDR_SENDLOG: env.SENDLOG,
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(env.PIDFILE, String(child.pid));

  for (let i = 0; i < 50; i++) {
    if ((await ping()) === 200) return;
    await wait(100);
  }
  throw new Error("herdview test server did not become ready — see " + env.SERVER_LOG);
};
