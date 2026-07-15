# herdview

A phone-first web mirror of your [herdr](https://herdr.dev) session.

herdview reflects the agents already running in your herdr session into a
mobile-friendly web UI — see each agent's state, read its transcript as a chat,
send input, answer multiple-choice prompts, and drive menus. It **never spawns a
new agent on its own**: it reads and steers the sessions you already have, so
you're not creating throwaway "remote-control" sessions just to check in from
your phone.

It's a herdr **plugin**: a small Go binary that drives the herdr CLI / socket
(the documented plugin API) and serves an embedded web UI. No Node, no Python,
no runtime for users to install.

## Install

```sh
herdr plugin install Orchard-Robotics/herdview
herdr plugin pane open --plugin orchard.herdview --entrypoint server
```

The install step (`scripts/fetch.sh`) downloads the prebuilt binary for your
OS/arch from this repo's latest [GitHub Release](../../releases), verifies its
SHA-256, and places it at `./herdview`. So the install machine needs **network
access and `curl` (or `wget`)** — but no Go toolchain, and no auth (the repo is
public). Binaries are never committed to git; CI builds and publishes them on
each tagged release.

Then open `http://127.0.0.1:8848` in your terminal app's web preview — or set
`HERDVIEW_ADDR=<tailnet-ip>:8848` and browse it directly over Tailscale (pass it
with `--env HERDVIEW_ADDR=…` on the `pane open`).

### Viewing on the Moshi phone app (optional)

herdview works in any browser. If you use the [Moshi](https://getmoshi.app)
phone app, its in-app detection needs the `moshi-hook` daemon running on the
host. herdview does **not** install third-party software for you: if `moshi-hook`
is already present, the install step just ensures its daemon is up; otherwise it
prints a pointer. To link the app to a host, pair once (token from the app):
`moshi-hook pair --token <token> --store file`.

## What you see

- A live grid of every agent, **blocked agents sorted to the top** ("N need
  you"), each with a state pill, working directory, and git branch. Multiple
  herdr sessions are aggregated — pick a session, then its agents.
- Tap an agent for its **transcript as chat bubbles** (with markdown, tables,
  and fenced code), a compose box (Shift+Enter to send), tappable **multiple-choice
  answers** for `AskUserQuestion`/permission prompts, a **task checklist**, and a
  side list of any **artifact links** the agent produced.
- When you switch tabs, the **browser-tab title badges** the count of agents that
  need you — `(N) herdview` — and clears when you return.

## Reaching it from your phone

By default herdview binds to `127.0.0.1:8848` (loopback only). Two ways to view it:

- **Terminal-app web preview** — apps that detect local HTTP servers will surface it.
- **Tailscale** — set `HERDVIEW_ADDR` to a tailnet-reachable address, e.g.
  `HERDVIEW_ADDR=100.x.y.z:8848`, and allow that host with
  `HERDVIEW_ALLOW_HOSTS=<host>`. Keep it tailnet-gated; never bind to a public interface.

## Develop locally

herdr can load a working directory directly, no build/publish needed:

```sh
go build -o herdview ./cmd/herdview      # requires Go 1.22+ (build-time only)
herdr plugin link /path/to/herdview      # register this dir as a plugin
herdr plugin pane open --plugin orchard.herdview --entrypoint server
```

Run the tests (Go unit + Playwright browser e2e) with `sh scripts/test.sh`.

## How it works

| Layer   | Mechanism |
|---------|-----------|
| Read    | `herdr agent list` (grid) + `herdr pane read` (per-agent output) via `$HERDR_BIN_PATH` |
| Render  | embedded mobile web UI (`web/`, compiled into the binary via `go:embed`) |
| Steer   | `herdr pane send-text` + Enter (message), `herdr pane send-keys` (menus) into the existing pane |

### HTTP API

| Route | Purpose |
|-------|---------|
| `GET /api/agents` | live agent grid across all sessions (state, cwd, branch, session) |
| `GET /api/pane/read?pane=ID&session=S` | recent output for one pane (text) |
| `GET /api/pane/transcript?pane=ID&session=S` | structured conversation (chat bubbles); 404 → fall back to read |
| `GET /api/pane/choices?pane=ID&session=S` | parsed multiple-choice prompt, if the pane is sitting on one |
| `GET /api/pane/tasks?pane=ID&session=S` | parsed task checklist, if present |
| `POST /api/pane/send?pane=ID&session=S` | `{text}` → type + Enter into the pane |
| `POST /api/pane/key?pane=ID&session=S` | `{keys:[...]}` → raw keystrokes (menus) |

## Security

herdview steers terminals, so treat the port as sensitive:

- Binds **loopback** by default; reach it via an authenticated SSH/mosh port-forward
  or a tailnet ACL. **Never bind it to a public interface.**
- A **Host + Origin allowlist** blocks DNS-rebinding and cross-site (CSRF) POSTs
  even on loopback. If you bind to a tailnet name/IP, allow it with
  `HERDVIEW_ALLOW_HOSTS=host1,host2` (or `*` to rely purely on network gating).
- There is **no user login** — anyone who can reach the port (and pass the host
  check) can read transcripts and steer agents. That's fine behind loopback/SSH;
  it is *not* a substitute for network gating.

## Structured chat bubbles (no setup)

The chat view renders Claude's own JSONL transcript instead of the terminal.
herdr exposes each pane's **PID**, and Claude writes `~/.claude/sessions/<pid>.json`
(with `sessionId` + `cwd`) for every running session — so herdview resolves
**pane → PID → session → transcript with no Claude hook and no config edits.**
It walks the process tree, so it still works while the agent is mid tool-run.

If it can't resolve a pane, it falls back to the raw terminal read. (A legacy
`herdview hook` that writes an explicit pane→transcript map is still honored as a
fallback, but is not required.)

## Cutting a release (maintainers)

Binaries are distributed via GitHub Releases, built by CI:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` cross-compiles all four platforms
(`herdview_{linux,macos}_{amd64,arm64}`), writes `SHA256SUMS`, and publishes the
Release. `scripts/fetch.sh` pulls from `/releases/latest/`, so the newest release
is what new installs receive. Build the artifacts by hand with `sh scripts/build.sh`.

## Roadmap

- [x] Live agent grid with state
- [x] Tap into an agent: recent output + send a message + menu keys
- [x] **Structured JSONL transcript** (chat bubbles) — resolved hook-free via
      `~/.claude/sessions/<pid>.json`; no config; falls back to terminal text
- [x] **Multi-session view** — aggregate every running herdr session into one
      grid with a session tier, fanning out over each session's socket
- [x] Multiple-choice answering, task checklist, artifact links, off-tab badge
- [ ] Approve/deny buttons refined from `herdr agent explain`'s matched blocker
- [ ] Detached lifecycle (`--detach` / `--stop`) so the server can run without a pane

## License

MIT
