# herdview

A phone-first web mirror of your [herdr](https://herdr.dev) session.

herdview reflects the agents already running in your herdr session into a
mobile-friendly web UI — see each agent's state (working / blocked / idle),
and (coming) read its transcript and send input back. It **never spawns a new
agent**: it reads and steers the sessions you already have, so you're not
creating throwaway "remote-control" sessions just to check in from your phone.

It's a herdr **plugin**: a small Go binary that drives the herdr CLI / socket
(the documented plugin API) and serves an embedded web UI. No Node, no Python,
no runtime for users to install.

## Install (herdr marketplace)

```sh
herdr plugin install orchard-robotics/herdview
```

Then start it and open the URL on your phone (via your terminal app's
web-preview, or over your tailnet):

```sh
herdr plugin action invoke orchard.herdview.start
```

## What you see

A live grid of every agent in the session, **blocked agents sorted to the top**
("N need you"), each with a state pill and its working directory. Refreshes every
couple of seconds.

## Reaching it from your phone

By default herdview binds to `127.0.0.1:8848` (loopback only). Two ways to view it:

- **Terminal-app web preview** — apps that detect local HTTP servers will surface it.
- **Tailscale** — set `HERDVIEW_ADDR` to a tailnet-reachable address, e.g.
  `HERDVIEW_ADDR=100.x.y.z:8848`. Keep it tailnet-gated; never bind to a public interface.

## Develop locally

herdr can load a working directory directly, no build/publish needed:

```sh
go build -o herdview ./cmd/herdview      # requires Go 1.22+ (build-time only)
herdr plugin link /path/to/herdview      # register this dir as a plugin
herdr plugin action invoke orchard.herdview.start
```

## How it works

| Layer   | Mechanism |
|---------|-----------|
| Read    | `herdr agent list` (grid) + `herdr pane read` (per-agent output) via `$HERDR_BIN_PATH` |
| Render  | embedded mobile web UI (`web/`, compiled into the binary via `go:embed`) |
| Steer   | `herdr pane send-text` + Enter (message), `herdr pane send-keys` (menus) into the existing pane |

### HTTP API

| Route | Purpose |
|-------|---------|
| `GET /api/agents` | live agent grid (state, cwd, focus) |
| `GET /api/pane/read?pane=ID` | recent output for one pane (text) |
| `GET /api/pane/transcript?pane=ID` | structured conversation (chat bubbles) when a hook mapping exists; 404 → fall back to read |
| `POST /api/pane/send?pane=ID` | `{text}` → type + Enter into the pane |
| `POST /api/pane/key?pane=ID` | `{keys:[...]}` → raw keystrokes (menus) |

## Security

herdview steers terminals, so treat the port as sensitive:

- Binds **loopback** by default; reach it via an authenticated SSH/mosh port-forward
  or a tailnet ACL. **Never bind it to a public interface.**
- A **Host + Origin allowlist** blocks DNS-rebinding and cross-site (CSRF) POSTs
  even on loopback. If you bind to a tailnet name/IP, allow it with
  `HERDVIEW_ALLOW_HOSTS=host1,host2`.
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

## Roadmap

- [x] Live agent grid with state
- [x] Tap into an agent: recent output + send a message + menu keys
- [x] **Structured JSONL transcript** (chat bubbles) — resolved hook-free via
      `~/.claude/sessions/<pid>.json`; no config; falls back to terminal text
- [ ] Approve/deny buttons refined from `herdr agent explain`'s matched blocker
- [ ] Detached lifecycle (`--detach` / `--stop`) + push updates

## License

MIT
