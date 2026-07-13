// Stop the test server started in global-setup.
const fs = require("fs");
const env = require("./support/env");

module.exports = async () => {
  try {
    const pid = parseInt(fs.readFileSync(env.PIDFILE, "utf8"), 10);
    if (pid) process.kill(pid);
  } catch {}
};
