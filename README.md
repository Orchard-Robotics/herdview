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
```

That's it — **no separate start step.** Installing downloads the binary and
starts the server, and it re-ensures itself whenever you focus a pane, so it's
up and reachable at `http://<this-host>:8848` (by tailnet name/IP — see below).

The install step (`scripts/fetch.sh`) downloads the prebuilt binary for your
OS/arch from this repo's latest [GitHub Release](../../releases), verifies its
SHA-256, and places it at `./herdview`. So the install machine needs **network
access and `curl` (or `wget`)** — but no Go toolchain, and no auth (the repo is
public). Binaries are never committed to git; CI builds and publishes them on
each tagged release.

To run it in a **visible pane** instead (its lifetime = the server's):
`herdr plugin pane open --plugin orchard.herdview --entrypoint server`.

**Updating** is just a reinstall: the launcher is version-aware, so `herdr plugin
install …` again detects a running older build and **auto-swaps in the new one**
(no kill, no reboot) — a plain reinstall upgrades a whole fleet.

> ⚠️ **Reboot caveat:** the server runs as a detached background process, not a
> system service. It survives your herdr session, but **not a machine reboot** —
> after a reboot it comes back the next time you interact with a herdr pane (the
> `pane.focused` event re-starts it), or immediately on a reinstall. A
> boot-persistent systemd service is on the roadmap.

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
- **⑂ diff** — a colored view of the agent's **uncommitted changes** (working diff
  + `--stat` summary + untracked files), rendered on the phone.
- When an agent is **blocked wanting to Edit/Write a file**, the approval card
  shows the **proposed change as a diff** (old→new), so you approve knowing what
  it'll do — not just the filename.
- **Rich blocks** — agents can emit fenced blocks that render inline as live UI:
  `herdview-card` (titled card + progress bars), `herdview-chart` (bar/line), and
  `html-widget` (arbitrary HTML in a sandboxed, network-blocked iframe). Toggle
  rendering off (show raw) via **⚙ → Render rich blocks**. See "Rich blocks" below.
- When you switch tabs, the **browser-tab title badges** the count of agents that
  need you — `(N) herdview` — and clears when you return.

## Reaching it from your phone

By default herdview binds **`0.0.0.0:8848`** (all interfaces), so on a machine on
your tailnet you just browse `http://<host>:8848` — e.g. `http://solo:8848` by its
MagicDNS name, or its `100.x` tailnet IP. No env, no port-forward. (A terminal
app's web preview of `localhost:8848` works too.)

Override the bind with `HERDVIEW_ADDR` (e.g. `127.0.0.1:8848` to force loopback).
The host allowlist auto-accepts loopback, this box's hostname, and private/tailnet
IPs; add others with `HERDVIEW_ALLOW_HOSTS=host1,host2` (or `*` to disable the check).

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
| `GET /api/version` | the running build's version (used by `--detach` to auto-upgrade) |
| `GET /api/agents` | live agent grid across all sessions (state, cwd, branch, session) |
| `GET /api/pane/read?pane=ID&session=S` | recent output for one pane (text) |
| `GET /api/pane/transcript?pane=ID&session=S` | structured conversation (chat bubbles); 404 → fall back to read |
| `GET /api/pane/choices?pane=ID&session=S` | parsed multiple-choice prompt, if the pane is sitting on one |
| `GET /api/pane/tasks?pane=ID&session=S` | parsed task checklist, if present |
| `GET /api/pane/diff?pane=ID&session=S` | the agent repo's uncommitted working diff (+ `--stat`, untracked) |
| `POST /api/pane/send?pane=ID&session=S` | `{text}` → type + Enter into the pane |
| `POST /api/pane/key?pane=ID&session=S` | `{keys:[...]}` → raw keystrokes (menus) |

## Rich blocks (agent-emitted)

Agents produce rich output by writing a fenced code block in their normal message;
herdview upgrades it to a live element in the chat bubble (no artifact, no new tab):

- ` ```herdview-card ` — JSON `{title, status, rows:[{label,value}], progress:[{label,value,max}]}`
- ` ```herdview-chart ` — JSON `{type:"bar", data:[{label,value}]}` or `{type:"line", points:[…]}`
- ` ```html-widget ` — raw HTML/SVG/canvas, rendered in a **sandboxed iframe**
  (`sandbox="allow-scripts"`, CSP `default-src 'none'` → no network, no page access),
  auto-sized to its content.

JSON blocks become DOM nodes; malformed input falls back to a plain code block, so
nothing is lost. Turn rendering off (view raw) with **⚙ → Render rich blocks**.

**Teaching agents to use them:** the `herdview-blocks` **skill** (in this repo at
`.claude/skills/herdview-blocks/`) documents the formats and when to use them. It
ships with the plugin — `herdr plugin install` clones the whole repo, so the skill
lands at `~/.config/herdr/plugins/github/orchard.herdview-*/.claude/skills/herdview-blocks/`.
It is **not auto-loaded**; point your project's `CLAUDE.md` at it (glob that path,
the hash suffix changes per install) so agents load it when herdview is present. The
skill keys off `HERDR_ENV`, so it only kicks in inside a herdr session.

## Security

herdview steers terminals, so treat the port as sensitive.

> ⚠️ **It binds all interfaces (`0.0.0.0`) by default** so it's reachable over
> your tailnet with zero config. That means anyone who can reach `:8848` on any
> network the host is attached to — **and there is no login** — can read
> transcripts and drive your agents. **Only run it on a machine whose network is
> gated** (a tailnet with ACLs, a trusted LAN, or behind a firewall). On an
> untrusted network, set `HERDVIEW_ADDR=127.0.0.1:8848` to bind loopback-only and
> reach it via an SSH/mosh port-forward instead.

- The **Host + Origin allowlist** blocks browser DNS-rebinding / cross-site (CSRF)
  POSTs: it accepts loopback, this box's hostname, and private/tailnet IPs, and
  rejects arbitrary public domains. It is **not** authentication — it doesn't stop
  a direct attacker on a network that can already reach the port.
- No user login. The allowlist and the network gating are the whole story — size
  your deployment accordingly.

## Structured chat bubbles (no setup)

The chat view renders Claude's own JSONL transcript instead of the terminal.
herdr exposes each pane's **PID**, and Claude writes `<config>/sessions/<pid>.json`
(with `sessionId` + `cwd`) for every running session — so herdview resolves
**pane → PID → session → transcript with no Claude hook and no config edits.**
It walks the process tree, so it still works while the agent is mid tool-run.
`<config>` is each pane process's own `CLAUDE_CONFIG_DIR` (default `~/.claude`),
so it works on **shared accounts** where developers isolate Claude with per-user
config dirs (e.g. `~/.claude-alice`).

If it can't resolve a pane, it falls back to the raw terminal read. (A legacy
`herdview hook` that writes an explicit pane→transcript map is still honored as a
fallback, but is not required.)

## Cutting a release (maintainers)

Binaries are distributed via GitHub Releases, built by CI:

```sh
git tag v0.3.0 && git push origin v0.3.0
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
- [x] **Auto-start** — `--detach` background launcher started at install and
      re-ensured on `pane.focused`; reachable over the tailnet by default, no manual step
- [ ] Approve/deny buttons refined from `herdr agent explain`'s matched blocker
- [ ] **Boot-persistent service** (systemd user unit) so it survives a reboot unattended

## License

MIT
