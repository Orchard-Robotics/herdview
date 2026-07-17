// Command herdview serves a phone-first web mirror of the current herdr session.
//
// It shells out to the herdr CLI (the documented plugin API surface, located via
// HERDR_BIN_PATH when launched as a plugin) to read live agent state, and serves
// an embedded mobile web UI. It never launches a new agent of its own — it only
// reflects and steers the agents that already exist in the session.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/orchard-robotics/herdview/web"
)

// paneRe guards the pane id before it reaches an exec argv (defense in depth;
// args aren't shell-interpreted, but we still reject anything unexpected).
// herdr workspace/pane ids are alphanumeric (e.g. w1:p2, wE:p3), not just digits.
var paneRe = regexp.MustCompile(`^w[0-9A-Za-z]+:p[0-9A-Za-z]+$`)

// allowHosts holds extra explicitly-permitted hostnames from HERDVIEW_ALLOW_HOSTS
// ("*" disables the host check entirely). loopback, this box's hostname, and
// private/tailnet IPs are always allowed by hostAllowed without being listed here.
var allowHosts = map[string]bool{}

// version is the build version, injected at release time via
// -ldflags "-X main.version=<tag>"; "dev" for local builds. Used by the
// version-aware --detach launcher to auto-upgrade a running server on reinstall.
var version = "dev"

// machineHost is this box's own hostname (lower-cased) — allowed so you can reach
// herdview by name (e.g. http://solo:8848) over the tailnet/LAN.
var machineHost = func() string { h, _ := os.Hostname(); return strings.ToLower(h) }()

// cgnat is Tailscale's 100.64.0.0/10 range (not covered by IP.IsPrivate).
var _, cgnat, _ = net.ParseCIDR("100.64.0.0/10")

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

// hostAllowed is the DNS-rebinding guard for a server that binds all interfaces
// by default and steers terminals. It accepts loopback, this box's own hostname
// (bare or as an FQDN prefix, e.g. solo / solo.tailnet.ts.net), and private/
// tailnet IP literals (RFC-1918 + CGNAT 100.64/10) — the addresses a phone on
// your LAN or tailnet actually uses — while rejecting arbitrary public domains.
// HERDVIEW_ALLOW_HOSTS adds explicit names, and "*" disables the check entirely.
func hostAllowed(h string) bool {
	if allowHosts["*"] {
		return true
	}
	h = strings.ToLower(hostOnly(h))
	if h == "" {
		return false
	}
	if allowHosts[h] {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || (cgnat != nil && cgnat.Contains(ip))
	}
	// A bare single-label name (no dot) — a LAN / mDNS / Tailscale-MagicDNS short
	// hostname like "solo" — can't be a public domain (no TLD), so it's not a
	// DNS-rebinding vector; allow it. (The OS hostname and the tailnet name often
	// differ, e.g. solo-orin vs solo, so matching only os.Hostname() isn't enough.)
	if !strings.Contains(h, ".") {
		return true
	}
	// Tailscale MagicDNS FQDNs (only resolvable on-tailnet) and this box's own FQDN.
	if strings.HasSuffix(h, ".ts.net") {
		return true
	}
	if machineHost != "" && (h == machineHost || strings.HasPrefix(h, machineHost+".")) {
		return true
	}
	return false
}

// guard is defense-in-depth for a server that steers terminals: the Host check
// blocks DNS-rebinding and the Origin check blocks cross-site POSTs (CSRF). It
// adds no login friction — loopback / same-host / tailnet traffic passes.
func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostAllowed(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" {
				if u, err := url.Parse(o); err != nil || !hostAllowed(u.Hostname()) {
					http.Error(w, "forbidden origin", http.StatusForbidden)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// noCache stops the browser caching the embedded UI, so a redeploy is always
// picked up on reload (the assets carry no ETag from embed.FS, and a fast-moving
// dev tool serving a stale index.html is a real trap).
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		next.ServeHTTP(w, r)
	})
}

// herdrBin resolves the herdr executable. herdr injects HERDR_BIN_PATH into
// runtime plugin processes; it's stripped from install-time build commands, and
// $PATH itself can be unusable — the cameras carry a literal, unexpanded
// "~/.local/bin" entry that never resolves — so fall back to a PATH lookup and
// then the usual install locations before giving up on a bare "herdr".
func herdrBin() string {
	if p := os.Getenv("HERDR_BIN_PATH"); p != "" {
		return p
	}
	if p, err := exec.LookPath("herdr"); err == nil {
		return p
	}
	for _, p := range []string{
		filepath.Join(os.Getenv("HOME"), ".local", "bin", "herdr"),
		"/usr/local/bin/herdr",
		"/usr/bin/herdr",
	} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return "herdr"
}

// runHerdr executes a herdr CLI subcommand against the ambient session and
// returns its stdout.
func runHerdr(args ...string) ([]byte, error) { return runHerdrOn("", args...) }

// runHerdrOn runs a herdr subcommand against a specific session socket (empty =
// the ambient HERDR_SOCKET_PATH). This is how the aggregate view fans out across
// sessions. A short timeout keeps a wedged socket from hanging HTTP handlers.
func runHerdrOn(socket string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, herdrBin(), args...)
	if socket != "" {
		env := make([]string, 0, len(os.Environ())+1)
		for _, e := range os.Environ() {
			if !strings.HasPrefix(e, "HERDR_SOCKET_PATH=") {
				env = append(env, e)
			}
		}
		cmd.Env = append(env, "HERDR_SOCKET_PATH="+socket)
	}
	return cmd.Output()
}

// herdrSession is one entry from `herdr session list --json`.
type herdrSession struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
	Socket  string `json:"socket_path"`
}

// listSessions enumerates herdr sessions for the aggregate multi-session view.
func listSessions() []herdrSession {
	out, err := runHerdr("session", "list", "--json")
	if err != nil {
		return nil
	}
	var res struct {
		Sessions []herdrSession `json:"sessions"`
	}
	if json.Unmarshal(out, &res) != nil {
		return nil
	}
	return res.Sessions
}

// sessionSocket resolves a session name to its socket (running sessions only).
func sessionSocket(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	for _, s := range listSessions() {
		if s.Name == name && s.Running {
			return s.Socket, true
		}
	}
	return "", false
}

// Agent is the subset of a herdr agent record the UI needs.
type Agent struct {
	Pane      string `json:"pane_id"`
	Workspace string `json:"workspace_id"`
	Tab       string `json:"tab_id"`
	Agent     string `json:"agent"`
	Name      string `json:"name,omitempty"`   // custom display name (herdr agent rename)
	Status    string `json:"agent_status"`
	Cwd       string `json:"cwd"`
	Branch    string `json:"branch,omitempty"` // git branch of the agent's cwd (worktree awareness)
	Session   string `json:"session,omitempty"` // herdr session the agent lives in (aggregate view)
	Focused   bool   `json:"focused"`
}

// gitBranch returns the current branch of a checkout, or "" if it isn't a repo.
func gitBranch(dir string) string {
	if dir == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// herdr wraps single-command results as {"result": {...}}.
type agentListResult struct {
	Result struct {
		Agents []Agent `json:"agents"`
	} `json:"result"`
}

// handleAgents returns the live agent list across every running herdr session
// (the aggregate view). Each agent is tagged with its session so the UI can
// group by it; a failing session is skipped rather than failing the whole grid.
func handleAgents(w http.ResponseWriter, r *http.Request) {
	branchByCwd := map[string]string{}
	agents := []Agent{}
	collect := func(raw []byte, session string) {
		var res agentListResult
		if json.Unmarshal(raw, &res) != nil {
			return
		}
		for i := range res.Result.Agents {
			a := res.Result.Agents[i]
			a.Session = session
			b, ok := branchByCwd[a.Cwd]
			if !ok {
				b = gitBranch(a.Cwd)
				branchByCwd[a.Cwd] = b
			}
			a.Branch = b
			agents = append(agents, a)
		}
	}

	sessions := listSessions()
	if len(sessions) == 0 {
		// No session enumeration available — fall back to the ambient session.
		out, err := runHerdr("agent", "list")
		if err != nil {
			http.Error(w, "herdr agent list failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		collect(out, "")
	} else {
		for _, s := range sessions {
			if !s.Running {
				continue
			}
			if out, err := runHerdrOn(s.Socket, "agent", "list"); err == nil {
				collect(out, s.Name)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(agents)
}

// resolveTarget reads ?session=&pane=, validates the pane id, and returns the
// herdr socket for that session ("" = ambient, for single-session use). Pane ids
// collide across sessions, so aggregate callers must pass ?session=.
func resolveTarget(w http.ResponseWriter, r *http.Request) (socket, pane string, ok bool) {
	pane = r.URL.Query().Get("pane")
	if !paneRe.MatchString(pane) {
		http.Error(w, "bad or missing pane id", http.StatusBadRequest)
		return "", "", false
	}
	if sess := r.URL.Query().Get("session"); sess != "" {
		s, found := sessionSocket(sess)
		if !found {
			http.Error(w, "unknown session", http.StatusBadRequest)
			return "", "", false
		}
		socket = s
	}
	return socket, pane, true
}

// handleRead returns a pane's recent output as plain text. Interim transcript
// source until the structured-JSONL view lands; it's Claude's own terminal text,
// not a framebuffer.
func handleRead(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	out, err := runHerdrOn(socket, "pane", "read", pane, "--source", "recent", "--lines", "200", "--format", "text")
	if err != nil {
		http.Error(w, "herdr pane read failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(out)
}

// handleSend types text into a pane and submits it (Enter) — a prompt to a
// running agent. This steers an existing session; it never starts a new one.
// --- dev key logging -------------------------------------------------------
// HERDVIEW_DEBUG_KEYS records every keystroke/text herdview sends into a pane —
// the tool that makes steering bugs (approvals, menu navigation) debuggable,
// since it captures EXACTLY what herdview emitted and when. Unset = disabled
// (zero overhead). Set to a file path to log there, or to "1"/"true"/"on" to
// log to <stateDir>/keys.log. HERDVIEW_DEBUG_KEYS_PROMPT=1 additionally snapshots
// the pane's parsed prompt just before each send, so you can see what the user
// was answering — this costs one extra herdr read per send, so it slightly
// perturbs timing; only enable it when chasing a prompt-correlation bug. Do NOT
// enable on a shared deploy: the log contains text typed to agents.
var (
	dbgMu     sync.Mutex
	dbgFile   *os.File
	dbgOpened bool
)

func debugKeysPath() string {
	switch v := os.Getenv("HERDVIEW_DEBUG_KEYS"); v {
	case "":
		return ""
	case "1", "true", "on", "yes":
		return filepath.Join(stateDir(), "keys.log")
	default:
		return v // an explicit path
	}
}

var dbgSanitize = strings.NewReplacer("\n", "\\n", "\r", "\\r", "\t", "\\t")

// logSend appends one dev-log line for a steering action. No-op unless
// HERDVIEW_DEBUG_KEYS is set; it never blocks or fails the send.
func logSend(r *http.Request, socket, event, pane, payload string) {
	path := debugKeysPath()
	if path == "" {
		return
	}
	// Snapshot the on-screen prompt BEFORE logging so the line records what the
	// keystroke was answering (opt-in; adds a herdr read per send).
	var prompt string
	if os.Getenv("HERDVIEW_DEBUG_KEYS_PROMPT") != "" {
		prompt = snapshotPrompt(socket, pane)
	}
	dbgMu.Lock()
	defer dbgMu.Unlock()
	if !dbgOpened {
		dbgOpened = true
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
			dbgFile, _ = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		}
	}
	if dbgFile == nil {
		return
	}
	session, from := "", ""
	if r != nil {
		session = r.URL.Query().Get("session")
		from = r.RemoteAddr
	}
	line := fmt.Sprintf("%s\t%s\tpane=%s\tsession=%s\tfrom=%s\t%s",
		time.Now().Format("2006-01-02T15:04:05.000"), event, pane, session, from, dbgSanitize.Replace(payload))
	if prompt != "" {
		line += "\ton-screen=[" + dbgSanitize.Replace(prompt) + "]"
	}
	fmt.Fprintln(dbgFile, line)
}

// snapshotPrompt returns a compact description of the selector currently on the
// pane, for correlating a keystroke with what it answered. Best-effort.
func snapshotPrompt(socket, pane string) string {
	out, err := runHerdrOn(socket, "pane", "read", pane, "--source", "visible", "--lines", "60", "--format", "text")
	if err != nil {
		return ""
	}
	q, opts, ok := parseChoices(string(out))
	if !ok {
		return "no-selector"
	}
	parts := make([]string, 0, len(opts))
	for _, o := range opts {
		mark := ""
		if o.Selected {
			mark = "*" // the ❯ cursor
		}
		parts = append(parts, fmt.Sprintf("%s%d:%s", mark, o.N, o.Label))
	}
	return q + " :: " + strings.Join(parts, " | ")
}

// handleDebugKeys tails the dev key log so it's viewable from the browser/phone
// without SSH. 404 when logging is disabled.
func handleDebugKeys(w http.ResponseWriter, r *http.Request) {
	path := debugKeysPath()
	if path == "" {
		http.Error(w, "key logging disabled — start herdview with HERDVIEW_DEBUG_KEYS=1", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(w, "(no keystrokes logged yet)")
		return
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if n := len(lines); n > 300 {
		lines = lines[n-300:]
	}
	fmt.Fprintln(w, strings.Join(lines, "\n"))
}

func handleSend(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Text == "" {
		http.Error(w, "expected JSON {text}", http.StatusBadRequest)
		return
	}
	logSend(r, socket, "send-text", pane, body.Text)
	if _, err := runHerdrOn(socket, "pane", "send-text", pane, body.Text); err != nil {
		http.Error(w, "send failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	if _, err := runHerdrOn(socket, "pane", "send-keys", pane, "Enter"); err != nil {
		http.Error(w, "submit failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleKey sends raw keystrokes to a pane — for driving menus (approve/deny a
// permission prompt, Esc to cancel, digit to pick an option).
func handleKey(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Keys []string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Keys) == 0 {
		http.Error(w, "expected JSON {keys:[...]}", http.StatusBadRequest)
		return
	}
	logSend(r, socket, "send-keys", pane, strings.Join(body.Keys, " "))
	args := append([]string{"pane", "send-keys", pane}, body.Keys...)
	if _, err := runHerdrOn(socket, args...); err != nil {
		http.Error(w, "send-keys failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// choice is one option in a Claude multiple-choice prompt (AskUserQuestion,
// permission menu, plan approval — all rendered as a numbered, ↑/↓-navigable
// selector where pressing the digit selects AND submits).
type choice struct {
	N        int    `json:"n"`
	Label    string `json:"label"`
	Selected bool   `json:"selected"`
}

// choiceRe matches a selector option line: an optional ❯ cursor, then "N. label".
// The space after the dot is optional — Claude Code sometimes renders an option
// with no gap (e.g. "2.Yes, and always allow…"); requiring the space silently
// dropped that option, and the sequential anchoring then dropped the rest of the
// run after the gap, so the user saw only a subset of the options.
var choiceRe = regexp.MustCompile(`^\s*(\x{276F})?\s*(\d+)\.\s*(.*\S)\s*$`)

// stripBox removes a leading and/or trailing vertical box-drawing border (and the
// padding spaces beside it) from a line, so a selector drawn inside a box parses
// the same as an unboxed one. Non-boxed lines pass through unchanged.
func stripBox(s string) string {
	s = strings.TrimRight(s, " ")
	for _, b := range []string{"│", "┃"} {
		if strings.HasSuffix(s, b) {
			s = strings.TrimRight(strings.TrimSuffix(s, b), " ")
			break
		}
	}
	t := strings.TrimLeft(s, " ")
	for _, b := range []string{"│", "┃"} {
		if strings.HasPrefix(t, b) {
			return strings.TrimLeft(strings.TrimPrefix(t, b), " ")
		}
	}
	return s
}

// parseChoices extracts the question + numbered options from a pane's terminal
// text when it's sitting on a Claude selector. ok=false if it isn't one.
func parseChoices(read string) (question string, opts []choice, ok bool) {
	// Normalize away any box-drawing border so a boxed prompt (permission / plan
	// approval) parses the same as an unboxed one (AskUserQuestion picker).
	lines := strings.Split(read, "\n")
	for i := range lines {
		lines[i] = stripBox(lines[i])
	}
	// Collect every numbered-option line in the visible window, remembering its
	// source line and whether the ❯ cursor sits on it.
	type cand struct {
		line     int
		n        int
		label    string
		selected bool
	}
	var cands []cand
	for i, ln := range lines {
		m := choiceRe.FindStringSubmatch(ln)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[2])
		cands = append(cands, cand{i, n, strings.TrimSpace(m[3]), m[1] != ""})
	}
	if len(cands) == 0 {
		return "", nil, false
	}
	// A pane is on a selector when it shows the navigation footer (the
	// AskUserQuestion picker) OR a ❯ cursor sits on one of the numbered options
	// (permission and plan-approval prompts, which have no footer). Requiring one
	// of these keeps an ordinary numbered list in agent output from being
	// mistaken for a prompt.
	joined := strings.Join(lines, "\n")
	footer := strings.Contains(joined, "to navigate") && strings.Contains(joined, "select")
	anchor := -1
	for i, c := range cands {
		if c.selected {
			anchor = i
			break
		}
	}
	if anchor < 0 {
		if !footer {
			return "", nil, false
		}
		// No cursor but a footer is present: anchor on the last option so we take
		// the option block that ends at the prompt (bottom of the window).
		anchor = len(cands) - 1
	}
	// The real options form a run numbered 1,2,3,… around the anchor. Content the
	// agent printed just before the prompt (e.g. a markdown ordered list) must not
	// be merged in, so expand outward from the anchor only while the option number
	// stays sequential (±1); this drops stray numbered lines that aren't part of
	// the actual selector.
	lo, hi := anchor, anchor
	for lo > 0 && cands[lo-1].n == cands[lo].n-1 {
		lo--
	}
	for hi < len(cands)-1 && cands[hi+1].n == cands[hi].n+1 {
		hi++
	}
	for _, c := range cands[lo : hi+1] {
		opts = append(opts, choice{N: c.n, Label: c.label, Selected: c.selected})
	}
	firstOpt := cands[lo].line
	// The question is the last meaningful line above the first option (skipping
	// separators, box drawing, the ☐ header, and the ❯ input echo).
	skip := func(s string) bool {
		if s == "" {
			return true
		}
		switch s[0:1] {
		case "$":
			return true
		}
		for _, p := range []string{"─", "☐", "❯", "│", "╭", "╰", "├", "└", "┌"} {
			if strings.HasPrefix(s, p) {
				return true
			}
		}
		return false
	}
	for i := 0; i < firstOpt; i++ {
		if t := strings.TrimSpace(lines[i]); !skip(t) {
			question = t
		}
	}
	return question, opts, true
}

// handleChoices returns the parsed multiple-choice options for a pane on a
// selector, so the UI can render tappable answers. Empty options = not a picker.
func handleChoices(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	out, err := runHerdrOn(socket, "pane", "read", pane, "--source", "visible", "--lines", "60", "--format", "text")
	if err != nil {
		http.Error(w, "herdr pane read failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	question, opts, found := parseChoices(string(out))
	if !found {
		opts = []choice{}
	}
	index, total := parseProgress(string(out)) // multi-part: which question of how many
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"question": question, "options": opts, "index": index, "total": total})
}

// parseProgress reads the multi-question tab bar (e.g. "☒ Fruit  ☐ Color") that
// Claude shows for a multi-part AskUserQuestion, returning the current question
// number and the total. Returns 0,0 for a single-question prompt (no tab bar).
func parseProgress(read string) (index, total int) {
	for _, ln := range strings.Split(read, "\n") {
		if !strings.ContainsAny(ln, "☐☒") { // ☐ ☒
			continue
		}
		done := strings.Count(ln, "☒") // ☒ answered
		pend := strings.Count(ln, "☐") // ☐ pending
		if done+pend >= 2 {                 // a real multi-question tab bar
			total = done + pend
			index = done + 1
			if index > total {
				index = total
			}
			return
		}
	}
	return 0, 0
}

// task is one item in Claude's todo list (rendered in the terminal as a
// "N tasks (X done, Y open)" block with ✔/◻ markers).
type task struct {
	Text   string `json:"text"`
	Status string `json:"status"` // "done" | "open" | "active"
}

var taskHeadRe = regexp.MustCompile(`\b\d+ tasks? \(\d+ done`)
var taskItemRe = regexp.MustCompile(`^\s*([✔✓☑◻☐◐▶●])\s+(.*\S)\s*$`)

// parseTasks extracts Claude's todo checklist from a pane's terminal text.
func parseTasks(read string) (items []task, ok bool) {
	lines := strings.Split(read, "\n")
	start := -1
	for i, ln := range lines {
		if taskHeadRe.MatchString(ln) {
			start = i
			break
		}
	}
	if start < 0 {
		return nil, false
	}
	for _, ln := range lines[start+1:] {
		m := taskItemRe.FindStringSubmatch(ln)
		if m == nil {
			break // first non-item line ends the block
		}
		st := "open"
		switch m[1] {
		case "✔", "✓", "☑":
			st = "done"
		case "◐", "▶", "●":
			st = "active"
		}
		items = append(items, task{Text: strings.TrimSpace(m[2]), Status: st})
	}
	return items, len(items) > 0
}

// handleTasks returns the pane's current todo checklist for a tidy UI render.
func handleTasks(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	out, err := runHerdrOn(socket, "pane", "read", pane, "--source", "visible", "--lines", "80", "--format", "text")
	if err != nil {
		http.Error(w, "herdr pane read failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	items, found := parseTasks(string(out))
	if !found {
		items = []task{}
	}
	done := 0
	for _, t := range items {
		if t.Status == "done" {
			done++
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tasks": items, "done": done, "total": len(items)})
}

// ---- pane → transcript mapping (populated by the `herdview hook` Claude hook) ----

func stateDir() string {
	if d := os.Getenv("HERDVIEW_STATE_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("HERDR_PLUGIN_STATE_DIR"); d != "" { // herdr-provided (runtime cmds)
		return d
	}
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "herdview")
	}
	return filepath.Join(os.Getenv("HOME"), ".local", "state", "herdview")
}

func mapPath(pane string) string {
	safe := strings.NewReplacer(":", "_", "/", "_").Replace(pane)
	return filepath.Join(stateDir(), "panes", safe+".json")
}

// paneMap links a herdr pane to the Claude session running inside it.
type paneMap struct {
	Pane           string `json:"pane"`
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
	Updated        int64  `json:"updated"`
}

// runHook is invoked as a Claude Code hook (`herdview hook`). It reads the hook
// payload on stdin and records which transcript belongs to the herdr pane the
// agent runs in (HERDR_PANE_ID). It must never fail loudly or block Claude.
func runHook() {
	pane := os.Getenv("HERDR_PANE_ID")
	if pane == "" {
		return // not inside herdr; nothing to map
	}
	var p struct {
		SessionID      string `json:"session_id"`
		TranscriptPath string `json:"transcript_path"`
		Cwd            string `json:"cwd"`
	}
	_ = json.NewDecoder(os.Stdin).Decode(&p)
	if p.TranscriptPath == "" {
		return
	}
	rec, _ := json.Marshal(paneMap{
		Pane: pane, SessionID: p.SessionID, TranscriptPath: p.TranscriptPath,
		Cwd: p.Cwd, Updated: time.Now().Unix(),
	})
	dst := mapPath(pane)
	if os.MkdirAll(filepath.Dir(dst), 0o755) != nil {
		return
	}
	// atomic per-pane write avoids cross-hook races.
	tmp := dst + ".tmp"
	if os.WriteFile(tmp, rec, 0o644) == nil {
		_ = os.Rename(tmp, dst)
	}
}

// readTail returns up to maxBytes from the end of a file, starting at the first
// complete line, bounding cost on multi-MB transcripts.
func readTail(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var start int64
	if st.Size() > maxBytes {
		start = st.Size() - maxBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	if start > 0 {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		}
	}
	return data, nil
}

// uiMsg is a rendered conversation turn.
type uiMsg struct {
	Role  string     `json:"role"` // "user" | "assistant"
	Text  string     `json:"text,omitempty"`
	Tools []toolInfo `json:"tools,omitempty"` // tool_use calls in an assistant turn
}

// toolInfo is a tool call with the field most relevant to deciding whether to
// approve it (the Bash command, the file path, …), so a blocked agent's pending
// action is visible in the UI.
type toolInfo struct {
	Name    string `json:"name"`
	Summary string `json:"summary,omitempty"`
	Diff    string `json:"diff,omitempty"` // proposed change for Edit/Write/MultiEdit (so a blocked edit shows WHAT it'll do)
}

// toolEditPreview renders the proposed change of an Edit/Write/MultiEdit as a
// simple diff (old lines as "-", new/content lines as "+") so a blocked agent's
// pending edit shows what it will change, not just the file path. Size-capped.
func toolEditPreview(name string, input json.RawMessage) string {
	if len(input) == 0 {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(input, &m) != nil {
		return ""
	}
	str := func(k string) string { s, _ := m[k].(string); return s }
	block := func(prefix, text string) string {
		if text == "" {
			return ""
		}
		var b strings.Builder
		for _, ln := range strings.Split(text, "\n") {
			b.WriteString(prefix)
			b.WriteString(ln)
			b.WriteByte('\n')
		}
		return b.String()
	}
	var sb strings.Builder
	switch name {
	case "Edit":
		sb.WriteString(block("-", str("old_string")))
		sb.WriteString(block("+", str("new_string")))
	case "MultiEdit":
		edits, _ := m["edits"].([]any)
		for i, e := range edits {
			em, _ := e.(map[string]any)
			if em == nil {
				continue
			}
			if i > 0 {
				sb.WriteString("@@\n")
			}
			o, _ := em["old_string"].(string)
			n, _ := em["new_string"].(string)
			sb.WriteString(block("-", o))
			sb.WriteString(block("+", n))
		}
	case "Write":
		sb.WriteString(block("+", str("content")))
	default:
		return ""
	}
	s := strings.TrimRight(sb.String(), "\n")
	if len(s) > 20000 {
		s = s[:20000] + "\n… (truncated)"
	}
	return s
}

func toolSummary(name string, input json.RawMessage) string {
	if len(input) == 0 {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(input, &m) != nil {
		return ""
	}
	pick := func(keys ...string) string {
		for _, k := range keys {
			if s, ok := m[k].(string); ok && s != "" {
				return s
			}
		}
		return ""
	}
	var s string
	switch name {
	case "Bash":
		s = pick("command")
	case "Edit", "MultiEdit", "Write", "Read", "NotebookEdit":
		s = pick("file_path", "notebook_path", "path")
	case "Glob", "Grep":
		s = pick("pattern", "query")
	}
	if s == "" {
		b, _ := json.Marshal(m)
		s = string(b)
	}
	if len(s) > 4000 {
		s = s[:4000] + "…"
	}
	return s
}

// parseTranscript turns transcript JSONL into simple user/assistant turns.
// isSystemInjected reports whether a type:"user" transcript turn is actually a
// system-injected message (task-notification, system-reminder, slash-command
// echo, command output) rather than something the human typed. Claude writes
// these as user-role turns, so without this they'd render as the user's own
// chat bubbles in the mirror.
func isSystemInjected(s string) bool {
	t := strings.TrimSpace(s)
	return strings.HasPrefix(t, "<task-notification>") ||
		strings.HasPrefix(t, "<system-reminder>") ||
		strings.HasPrefix(t, "<command-name>") ||
		strings.HasPrefix(t, "<command-message>") ||
		strings.HasPrefix(t, "<local-command-stdout>") ||
		strings.HasPrefix(t, "Caveat: The messages below") ||
		strings.Contains(t, "[SYSTEM NOTIFICATION")
}

func parseTranscript(data []byte) []uiMsg {
	out := []uiMsg{}
	for _, raw := range bytes.Split(data, []byte{'\n'}) {
		if len(bytes.TrimSpace(raw)) == 0 {
			continue
		}
		var l struct {
			Type    string `json:"type"`
			IsMeta  bool   `json:"isMeta"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(raw, &l) != nil {
			continue
		}
		if l.IsMeta {
			// Injected/meta content (skill bodies, slash-command expansions, etc.)
			// is written as a user-role turn but isn't something the human typed.
			continue
		}
		switch l.Type {
		case "user":
			var s string
			if json.Unmarshal(l.Message.Content, &s) == nil {
				if strings.TrimSpace(s) != "" && !isSystemInjected(s) {
					out = append(out, uiMsg{Role: "user", Text: s})
				}
				continue
			}
			var blocks []struct{ Type, Text string }
			if json.Unmarshal(l.Message.Content, &blocks) == nil {
				var txt []string
				for _, b := range blocks {
					if b.Type == "text" && b.Text != "" {
						txt = append(txt, b.Text)
					}
				}
				if joined := strings.Join(txt, "\n"); len(txt) > 0 && !isSystemInjected(joined) {
					out = append(out, uiMsg{Role: "user", Text: joined})
				}
			}
		case "assistant":
			var blocks []struct {
				Type  string
				Text  string
				Name  string
				Input json.RawMessage
			}
			if json.Unmarshal(l.Message.Content, &blocks) == nil {
				var txt []string
				var tools []toolInfo
				for _, b := range blocks {
					if b.Type == "text" && b.Text != "" {
						txt = append(txt, b.Text)
					}
					if b.Type == "tool_use" && b.Name != "" {
						tools = append(tools, toolInfo{Name: b.Name, Summary: toolSummary(b.Name, b.Input), Diff: toolEditPreview(b.Name, b.Input)})
					}
				}
				if len(txt) > 0 || len(tools) > 0 {
					out = append(out, uiMsg{Role: "assistant", Text: strings.Join(txt, "\n"), Tools: tools})
				}
			}
		}
	}
	return out
}

// ---- hook-free pane → transcript resolution ----
//
// Claude writes <config>/sessions/<pid>.json (sessionId + cwd) for each running
// session, where <config> is CLAUDE_CONFIG_DIR (default ~/.claude). herdr gives us
// a pane's PID, so we resolve the transcript hook-free: pane → pid → sessions file
// → transcript. On a shared account, developers isolate Claude with a per-process
// CLAUDE_CONFIG_DIR (e.g. ~/.claude-alice), so we read each pane process's own env
// rather than assuming ~/.claude — otherwise every pane falls back to raw terminal.

type sessionFile struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
}

// claudeConfigDir returns the Claude config dir a process uses: its own
// CLAUDE_CONFIG_DIR (read from /proc/<pid>/environ on Linux), else ~/.claude.
// (macOS has no /proc, so it falls back to the default there — fine, the
// shared-account setup this targets is Linux.)
func claudeConfigDir(pid int) string {
	def := filepath.Join(os.Getenv("HOME"), ".claude")
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		return def
	}
	return configDirFromEnviron(b, def)
}

// configDirFromEnviron extracts CLAUDE_CONFIG_DIR from a NUL-separated /proc
// environ blob, returning def when it's absent or empty. If it holds multiple
// comma-separated dirs, the first (Claude's primary) is used.
func configDirFromEnviron(environ []byte, def string) string {
	for _, kv := range strings.Split(string(environ), "\x00") {
		if v, ok := strings.CutPrefix(kv, "CLAUDE_CONFIG_DIR="); ok {
			v = strings.TrimSpace(v)
			if v == "" {
				return def
			}
			if i := strings.IndexByte(v, ','); i >= 0 {
				v = strings.TrimSpace(v[:i])
			}
			return v
		}
	}
	return def
}

// readSessionFile reads <config>/sessions/<pid>.json using pid's own config dir,
// returning that dir so the transcript is looked up in the same place.
func readSessionFile(pid int) (sessionFile, string, bool) {
	dir := claudeConfigDir(pid)
	b, err := os.ReadFile(filepath.Join(dir, "sessions", strconv.Itoa(pid)+".json"))
	if err != nil {
		return sessionFile{}, "", false
	}
	var sf sessionFile
	if json.Unmarshal(b, &sf) != nil || sf.SessionID == "" {
		return sessionFile{}, "", false
	}
	return sf, dir, true
}

// ppid reads the parent pid from /proc/<pid>/stat (comm can contain spaces, so
// parse after the last ')').
func ppid(pid int) int {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 2 {
		return 0
	}
	p, _ := strconv.Atoi(f[1]) // state, ppid, ...
	return p
}

// paneSession resolves the Claude session running in a pane. The foreground
// process may be a tool subprocess, so we walk up the process tree to the
// claude process that owns a sessions file.
func paneSession(socket, pane string) (sessionFile, string, bool) {
	out, err := runHerdrOn(socket, "pane", "process-info", "--pane", pane)
	if err != nil {
		return sessionFile{}, "", false
	}
	var pi struct {
		Result struct {
			ProcessInfo struct {
				ShellPID int `json:"shell_pid"`
				Fg       []struct {
					PID int `json:"pid"`
				} `json:"foreground_processes"`
			} `json:"process_info"`
		} `json:"result"`
	}
	if json.Unmarshal(out, &pi) != nil {
		return sessionFile{}, "", false
	}
	seeds := []int{}
	for _, f := range pi.Result.ProcessInfo.Fg {
		seeds = append(seeds, f.PID)
	}
	seeds = append(seeds, pi.Result.ProcessInfo.ShellPID)
	for _, pid := range seeds {
		for p, hops := pid, 0; p > 1 && hops < 8; hops++ {
			if sf, dir, ok := readSessionFile(p); ok {
				return sf, dir, true
			}
			p = ppid(p)
		}
	}
	return sessionFile{}, "", false
}

// findTranscript locates a session's JSONL under <config>/projects (session ids
// are unique, so a glob avoids depending on Claude's dir-slug rules). configDir
// is the same config dir the sessions file was found in.
func findTranscript(configDir, sessionID string) string {
	m, _ := filepath.Glob(filepath.Join(configDir, "projects", "*", sessionID+".jsonl"))
	if len(m) > 0 {
		return m[0]
	}
	return ""
}

// handleTranscript renders the structured conversation for a pane. 404 tells the
// UI to fall back to the raw pane read.
func handleTranscript(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	var tpath, sid string
	if sf, dir, ok := paneSession(socket, pane); ok { // hook-free primary path
		sid = sf.SessionID
		tpath = findTranscript(dir, sf.SessionID)
	}
	if tpath == "" { // fallback: legacy hook-populated map, if present
		if raw, err := os.ReadFile(mapPath(pane)); err == nil {
			var m paneMap
			if json.Unmarshal(raw, &m) == nil {
				tpath, sid = m.TranscriptPath, m.SessionID
			}
		}
	}
	if tpath == "" {
		http.Error(w, "no transcript for pane", http.StatusNotFound)
		return
	}
	tail, err := readTail(tpath, 512*1024)
	if err != nil {
		http.Error(w, "read transcript failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	msgs := parseTranscript(tail)
	if len(msgs) > 80 {
		msgs = msgs[len(msgs)-80:]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"session_id": sid, "messages": msgs})
}

// handleRename sets (or, with an empty name, clears) an agent's custom name.
func handleRename(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "expected JSON {name}", http.StatusBadRequest)
		return
	}
	var err error
	if name := strings.TrimSpace(body.Name); name == "" {
		_, err = runHerdrOn(socket, "agent", "rename", pane, "--clear")
	} else {
		_, err = runHerdrOn(socket, "agent", "rename", pane, name)
	}
	if err != nil {
		http.Error(w, "rename failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// paneCwd resolves a pane's working directory from the session's agent list.
func paneCwd(socket, pane string) string {
	out, err := runHerdrOn(socket, "agent", "list")
	if err != nil {
		return ""
	}
	var res agentListResult
	if json.Unmarshal(out, &res) != nil {
		return ""
	}
	for _, a := range res.Result.Agents {
		if a.Pane == pane {
			return a.Cwd
		}
	}
	return ""
}

// gitIn runs a git subcommand in cwd with a short timeout, returning trimmed
// stdout and whether it succeeded.
func gitIn(cwd string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...).Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// capDiff truncates a diff to at most max bytes on a line boundary, reporting
// whether it was cut — so one giant diff can't blow up the phone payload.
func capDiff(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	s = s[:max]
	if i := strings.LastIndexByte(s, '\n'); i > 0 {
		s = s[:i]
	}
	return s, true
}

// handleDiff returns the agent repo's uncommitted changes: the working diff
// (staged+unstaged vs HEAD) plus a --stat summary and the untracked file names.
// (Branch-vs-base was dropped: git records no fork point, and repos with several
// unrelated mainlines can't be auto-based reliably.)
func handleDiff(w http.ResponseWriter, r *http.Request) {
	socket, pane, ok := resolveTarget(w, r)
	if !ok {
		return
	}
	cwd := paneCwd(socket, pane)
	if cwd == "" {
		http.Error(w, "no working directory for pane", http.StatusNotFound)
		return
	}
	if _, ok := gitIn(cwd, "rev-parse", "--is-inside-work-tree"); !ok {
		http.Error(w, "not a git repository", http.StatusNotFound)
		return
	}
	const cap = 400 * 1024
	wstat, _ := gitIn(cwd, "diff", "--stat", "HEAD")
	wdiff, _ := gitIn(cwd, "diff", "HEAD")
	diff, truncated := capDiff(wdiff, cap)
	var untracked []string
	if u, ok := gitIn(cwd, "ls-files", "--others", "--exclude-standard"); ok && u != "" {
		untracked = strings.Split(u, "\n")
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"branch_name": gitBranch(cwd),
		"stat":        wstat,
		"diff":        diff,
		"untracked":   untracked,
		"truncated":   truncated,
	})
}

// targetSocket resolves a session name (from a request body) to its herdr
// socket; "" means the ambient session. Writes a 400 for an unknown session.
func targetSocket(w http.ResponseWriter, session string) (string, bool) {
	if session == "" {
		return "", true
	}
	s, found := sessionSocket(session)
	if !found {
		http.Error(w, "unknown session", http.StatusBadRequest)
		return "", false
	}
	return s, true
}

// branchRe is a conservative guard for a branch name reaching the git/herdr CLI.
var branchRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$`)

// handleNewWorktree creates a git worktree for the given repo (cwd) on a new
// branch via herdr, then launches a Claude agent in it. It appears in the grid
// as a new workspace on that branch.
func handleNewWorktree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd     string `json:"cwd"`
		Name    string `json:"name"`
		Session string `json:"session"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "expected JSON {cwd,name}", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if body.Cwd == "" || !branchRe.MatchString(name) || strings.Contains(name, "..") {
		http.Error(w, "need a repo cwd and a valid branch name", http.StatusBadRequest)
		return
	}
	socket, ok := targetSocket(w, body.Session)
	if !ok {
		return
	}
	out, err := runHerdrOn(socket, "worktree", "create", "--cwd", body.Cwd, "--branch", name, "--json")
	if err != nil {
		http.Error(w, "worktree create failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	var res struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
			Worktree struct {
				Path string `json:"path"`
			} `json:"worktree"`
		} `json:"result"`
	}
	_ = json.Unmarshal(out, &res)
	pane := res.Result.RootPane.PaneID
	if pane != "" {
		_, _ = runHerdrOn(socket, "pane", "run", pane, "claude") // launch an agent in the fresh worktree
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"pane": pane, "branch": name, "path": res.Result.Worktree.Path})
}

// handleNewAgent starts a plain Claude agent in an existing directory (no
// worktree/branch) — a fresh tab running claude.
func handleNewAgent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd     string `json:"cwd"`
		Session string `json:"session"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Cwd) == "" {
		http.Error(w, "need a cwd", http.StatusBadRequest)
		return
	}
	socket, ok := targetSocket(w, body.Session)
	if !ok {
		return
	}
	out, err := runHerdrOn(socket, "tab", "create", "--cwd", body.Cwd, "--no-focus")
	if err != nil {
		http.Error(w, "agent start failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	var res struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	_ = json.Unmarshal(out, &res)
	pane := res.Result.RootPane.PaneID
	if pane != "" {
		_, _ = runHerdrOn(socket, "pane", "run", pane, "claude")
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"pane": pane})
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	// `herdview hook` runs as a Claude Code hook, not the server.
	if len(os.Args) > 1 && os.Args[1] == "hook" {
		runHook()
		return
	}

	addr := flag.String("addr", envOr("HERDVIEW_ADDR", "0.0.0.0:8848"),
		"listen address (default all interfaces so it's reachable over your tailnet/LAN)")
	detach := flag.Bool("detach", false,
		"start the server as a detached background process (idempotent) and exit")
	flag.Parse()

	if *detach {
		if err := ensureDetached(*addr); err != nil {
			log.Fatalf("herdview --detach: %v", err)
		}
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, version)
	})
	mux.HandleFunc("/api/agents", handleAgents)
	mux.HandleFunc("/api/pane/read", handleRead)
	mux.HandleFunc("/api/pane/transcript", handleTranscript)
	mux.HandleFunc("/api/pane/send", handleSend)
	mux.HandleFunc("/api/pane/key", handleKey)
	mux.HandleFunc("/api/pane/choices", handleChoices)
	mux.HandleFunc("/api/pane/tasks", handleTasks)
	mux.HandleFunc("/api/pane/diff", handleDiff)
	mux.HandleFunc("/api/pane/rename", handleRename)
	mux.HandleFunc("/api/worktree", handleNewWorktree)
	mux.HandleFunc("/api/agent", handleNewAgent)
	mux.HandleFunc("/api/debug/keys", handleDebugKeys)
	mux.Handle("/", noCache(http.FileServer(http.FS(web.FS))))

	// loopback, this box's hostname, and private/tailnet IPs are always allowed
	// (see hostAllowed); HERDVIEW_ALLOW_HOSTS adds explicit names, "*" disables.
	for _, h := range strings.Split(os.Getenv("HERDVIEW_ALLOW_HOSTS"), ",") {
		if h = strings.TrimSpace(strings.ToLower(h)); h != "" {
			allowHosts[h] = true
		}
	}

	srv := &http.Server{
		Addr:         *addr,
		Handler:      guard(mux),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
	}
	reach := *addr
	if h := hostOnly(*addr); h == "0.0.0.0" || h == "::" || h == "" {
		_, port, _ := net.SplitHostPort(*addr)
		reach = net.JoinHostPort(orDefault(machineHost, "127.0.0.1"), port) // reachable by name over the tailnet/LAN
	}
	fmt.Printf("herdview → http://%s  (herdr: %s)\n", reach, herdrBin())
	log.Fatal(srv.ListenAndServe())
}

// orDefault returns s, or def when s is empty.
func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// portListening reports whether something already accepts connections on addr's
// port (checked on loopback, which a 0.0.0.0 bind also covers).
func portListening(addr string) bool {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// serverVersion returns the version reported by a herdview already serving on
// addr's port ("" if it's unreachable or a build old enough to lack /api/version).
func serverVersion(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	c := &http.Client{Timeout: 700 * time.Millisecond}
	resp, err := c.Get("http://127.0.0.1:" + port + "/api/version")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 128))
	return strings.TrimSpace(string(b))
}

// stopByPidfile SIGTERMs the server recorded in pidPath (one WE launched) and
// waits for the port to free. Returns false if there's no live pidfile process
// or the port never freed — i.e. it isn't ours to replace, so don't launch over it.
func stopByPidfile(pidPath, addr string) bool {
	b, err := os.ReadFile(pidPath)
	if err != nil {
		return false
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil || p.Signal(syscall.Signal(0)) != nil {
		return false
	}
	_ = p.Signal(syscall.SIGTERM)
	for i := 0; i < 25; i++ {
		if !portListening(addr) {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return !portListening(addr)
}

// ensureDetached starts the server as a detached background process, idempotently
// and version-aware. If a server is already on the port it no-ops when that's THIS
// build; otherwise (a different or pre-versioning build) it stops the one WE
// launched and starts the new build — so a plain reinstall auto-upgrades a running
// camera. It returns fast (safe from the install build step and the high-frequency
// pane-focus hook). The child is a fresh session (setsid) with stdio redirected to
// a logfile, so it survives the launching shell and herdr, and never holds a herdr
// command slot.
func ensureDetached(addr string) error {
	dir := stateDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	// Serialize concurrent launches — several focus events can fire at once.
	lf, err := os.OpenFile(filepath.Join(dir, "detach.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer lf.Close()
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil // another launcher holds the lock; it's handling startup
	}
	defer syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)

	pidPath := filepath.Join(dir, "herdview.pid")
	if portListening(addr) {
		v := serverVersion(addr)
		if v == version {
			return nil // this exact build is already serving
		}
		// A different (or pre-versioning) build holds the port. Replace it — but
		// only one we launched (live pidfile), so we never kill an unrelated
		// process squatting on the port.
		if !stopByPidfile(pidPath, addr) {
			fmt.Printf("herdview: %s held by a build we didn't start (running=%q, this=%q); leaving it — it updates on reboot\n", addr, v, version)
			return nil
		}
		fmt.Printf("herdview: upgrading server on %s (%q → %q)\n", addr, v, version)
		// port is now free; fall through to launch the new build
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logf, err := os.OpenFile(filepath.Join(dir, "herdview.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer logf.Close()
	cmd := exec.Command(exe, "--addr", addr)
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // new session: detach from the launcher + herdr
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid // capture before Release() (which resets it to -1)
	_ = os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0o644)
	_ = cmd.Process.Release()
	fmt.Printf("herdview: started detached (pid %d) on %s\n", pid, addr)
	return nil
}
