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
up at `http://127.0.0.1:8848`. To reach it from your phone, see
[Reaching it from your phone](#reaching-it-from-your-phone).

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
  herdr sessions are aggregated — pick a session, then its agents. **Every
  running session is listed, including one with no agents yet** (`0 agents`), so
  a session you just started is somewhere you can go and start the first agent.
- Agents are named the way the terminal names them: each card and the detail
  header carry **herdr's own workspace label** (`oncall · pane 3`, not
  `workspace 25 · pane 3`), and the header names the **herdr session** you're
  looking at. The raw `w<N>:p<N>` id stays available as the tooltip.
- Tap an agent for its **transcript as chat bubbles** (with markdown, tables,
  and fenced code), a compose box (Shift+Enter to send), tappable **multiple-choice
  answers** for `AskUserQuestion`/permission prompts, a **task checklist**, and a
  side list of any **artifact links** the agent produced.
- **⑂ diff** — a colored view of the agent's **uncommitted changes** (working diff
  + `--stat` summary + untracked files), rendered on the phone.
- **Inline code changes** — every completed `Edit`/`Write`/`MultiEdit` in the
  transcript shows its diff under the tool line, the way the terminal prints it,
  with a `+n −n` tally. Short diffs are expanded; a long one starts collapsed so
  one big edit can't bury the chat.
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

By default herdview binds **loopback only** (`127.0.0.1:8848`), and every request
must carry a **pairing token**. A terminal app's web preview of `localhost:8848`
works as is. To reach it over your tailnet, bind a tailnet interface:

```sh
export HERDVIEW_ADDR=100.x.y.z:8848   # this box's tailnet IP (or 0.0.0.0:8848 for all interfaces)
```

Set it in the environment herdr starts from, then reinstall (or stop the running
server) so it restarts on the new address.

**Pairing.** On first run herdview generates a random token in `<stateDir>/token`
(mode `0600`; `<stateDir>` is herdr's plugin state dir, else
`~/.local/state/herdview`) and prints the pairing URL to the server log:

```
pair a browser once: http://<host>:8848/?token=<token>
```

Open that URL once on each device: it sets an `HttpOnly` cookie and redirects to
the clean URL. Scripts send `Authorization: Bearer <token>` instead. Set
`HERDVIEW_TOKEN` to choose the token yourself. To rotate it, delete the token file
and restart the server; every paired device must then pair again.

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

### Debugging what herdview sends (dev tool)

Steering bugs (approvals, menu navigation) are only debuggable if you know
*exactly* what herdview typed into a pane and when. Set **`HERDVIEW_DEBUG_KEYS`**
to turn on a keystroke log:

```sh
HERDVIEW_DEBUG_KEYS=1 herdview                       # → <stateDir>/keys.log
HERDVIEW_DEBUG_KEYS=/tmp/keys.log herdview …          # → an explicit path
```

Every `send-text`/`send-keys` is logged with a millisecond timestamp, pane,
session, client IP, and payload — so "one tap = one keystroke" is verifiable at
a glance. Add **`HERDVIEW_DEBUG_KEYS_PROMPT=1`** to also snapshot the on-screen
selector just before each send (what the keystroke was answering); this costs one
extra herdr read per send, so enable it only while chasing a prompt-correlation
bug. Tail the log from a browser/phone at **`/api/debug/keys`** (404 when
disabled). Unset = off, zero overhead. Don't enable on a shared deploy — the log
records text typed to agents.

## How it works

| Layer   | Mechanism |
|---------|-----------|
| Read    | `herdr agent list` (grid) + `herdr workspace list` (workspace names) + `herdr pane read` (per-agent output) via `$HERDR_BIN_PATH` |
| Render  | embedded mobile web UI (`web/`, compiled into the binary via `go:embed`) |
| Steer   | `herdr pane send-text` + Enter (message), `herdr pane send-keys` (menus) into the existing pane |

### HTTP API

| Route | Purpose |
|-------|---------|
| `GET /api/version` | the running build's version (used by `--detach` to auto-upgrade) |
| `GET /api/agents` | live agent grid across all sessions (state, cwd, branch, session, workspace name) |
| `GET /api/sessions` | names of the running herdr sessions, so one with no agents yet is still listed |
| `GET /api/pane/read?pane=ID&session=S` | recent output for one pane (text) |
| `GET /api/pane/transcript?pane=ID&session=S` | structured conversation (chat bubbles); 404 → fall back to read |
| `GET /api/pane/choices?pane=ID&session=S` | parsed multiple-choice prompt, if the pane is sitting on one |
| `GET /api/pane/tasks?pane=ID&session=S` | parsed task checklist, if present |
| `GET /api/pane/diff?pane=ID&session=S` | the agent repo's uncommitted working diff (+ `--stat`, untracked) |
| `GET /api/pane/image?pane=ID&session=S&path=P` | a raster image the agent referenced in a `herdview-image` block (path must appear in the pane's transcript) |
| `POST /api/pane/send?pane=ID&session=S` | `{text}` → type + Enter into the pane |
| `POST /api/pane/key?pane=ID&session=S` | `{keys:[...]}` → raw keystrokes (menus) |
| `GET /api/debug/keys` | tail of the dev keystroke log (404 unless `HERDVIEW_DEBUG_KEYS` is set) |

## Rich blocks (agent-emitted)

Agents produce rich output by writing a fenced code block in their normal message;
herdview upgrades it to a live element in the chat bubble (no artifact, no new tab):

- ` ```herdview-card ` — JSON `{title, status, rows:[{label,value}], progress:[{label,value,max}]}`
- ` ```herdview-chart ` — JSON `{type:"bar", data:[{label,value}]}` or `{type:"line", points:[…]}`
- ` ```html-widget ` — raw HTML/SVG/canvas, rendered in a **sandboxed iframe**
  (`sandbox="allow-scripts"`, CSP `default-src 'none'` → no network, no page access),
  auto-sized to its content.
- ` ```herdview-image ` — an embedded plot/image. JSON `{path}` (herdview loads
  the file out-of-band via `/api/pane/image`, keeping big images out of the
  transcript) or a small inline `{src:"data:image/…"}`. External URLs and SVG are
  refused; only a path the agent referenced in that message is served.
- ` ```diff ` — a colorized diff (green adds, red deletes, dimmed hunk/file headers).
- **Callouts** — `> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]` render
  as colored admonition boxes.
- ` ```mermaid ` — Mermaid diagrams → SVG (`securityLevel: strict`, adopted via
  DOMParser, no innerHTML). The ~3.5 MB Mermaid build is **vendored and lazy-loaded**
  — fetched only the first time a diagram appears.

JSON blocks become DOM nodes; malformed input falls back to a plain code block, so
nothing is lost. Turn rendering off (view raw) with **⚙ → Render rich blocks**.

**Teaching agents to use them:** the `herdview-blocks` **skill** (in this repo at
`.claude/skills/herdview-blocks/`) documents the formats and when to use them. It
ships with the plugin — `herdr plugin install` clones the whole repo, so the skill
lands at `~/.config/herdr/plugins/github/orchard.herdview-*/.claude/skills/herdview-blocks/`.
It is **not auto-loaded**; point your project's `CLAUDE.md` at it (glob that path,
the hash suffix changes per install) so agents load it when herdview is present. The
skill keys off `HERDR_ENV`, so it only kicks in inside a herdr session.

Drop this into your repo's `CLAUDE.md`:

````markdown
## herdview rich output (when your session is mirrored)

When running in a herdr session (`HERDR_ENV` is set) with the **herdview** plugin
installed, prefer herdview's **rich blocks** for visual output — they render inline
in the phone/desktop mirror instead of as a wall of text or a heavy artifact.

- The format guide isn't auto-discovered, so **read it once when it's relevant**
  (summarizing results/metrics, a comparison, progress, or a small widget). Find it
  via glob — check the github-install path and your local checkout, if any (the
  hash suffix changes per install):
  ```
  ls ~/.config/herdr/plugins/github/orchard.herdview-*/.claude/skills/herdview-blocks/SKILL.md \
     /path/to/herdview/.claude/skills/herdview-blocks/SKILL.md 2>/dev/null | head -1
  ```
  Read that file and follow it. If the glob doesn't resolve, herdview isn't
  installed → skip this and write normally.
- It documents several fences: ` ```herdview-card ` (titled card + progress bars),
  ` ```herdview-chart ` (bar/line), ` ```herdview-image ` (an embedded plot/image
  by file path), ` ```html-widget ` (arbitrary HTML in a sandboxed iframe), plus
  ` ```diff `, ` ```mermaid `, and `> [!NOTE]` callouts. Keep them compact; they
  render inline in a chat bubble.
- To turn this off: delete this section, or toggle it off in the viewer
  (⚙ → "Render rich blocks").
````

## Security

herdview steers terminals, so treat the port and the token as sensitive.

- **Loopback by default.** A fresh install listens on `127.0.0.1` only. Binding
  any other address is an explicit choice (`HERDVIEW_ADDR`).
- **Token on every request.** Every route except `GET /api/version` returns `401`
  without the pairing token (bearer header, or the cookie the pairing URL sets).
  The server refuses to start if it can't load or create a token. Anyone holding
  the token can read transcripts and drive your agents, so never paste the
  pairing URL anywhere shared.
- **Host + Origin allowlist.** Blocks browser DNS-rebinding and cross-site (CSRF)
  POSTs: it accepts loopback, this box's hostname, and private/tailnet IPs, and
  rejects arbitrary public domains.
- **Plain HTTP.** On a tailnet, WireGuard encrypts the traffic; on a LAN, the
  token crosses the network in clear text. Prefer a tailnet IP over `0.0.0.0`, and
  limit who can reach the port with tailnet ACLs.

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
      re-ensured on `pane.focused`; no manual step
- [ ] Approve/deny buttons refined from `herdr agent explain`'s matched blocker
- [ ] **Boot-persistent service** (systemd user unit) so it survives a reboot unattended

## License

MIT
