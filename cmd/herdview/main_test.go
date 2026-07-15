package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestHerdrBin covers herdr resolution when HERDR_BIN_PATH is unset and $PATH is
// unusable (the cameras' literal, unexpanded "~/.local/bin") — it must still find
// herdr via a PATH lookup or the known install locations under $HOME.
func TestHerdrBin(t *testing.T) {
	t.Setenv("HERDR_BIN_PATH", "/custom/herdr") // explicit wins
	if got := herdrBin(); got != "/custom/herdr" {
		t.Fatalf("HERDR_BIN_PATH: got %q", got)
	}

	dir := t.TempDir() // empty env → resolved off PATH
	onpath := filepath.Join(dir, "herdr")
	if err := os.WriteFile(onpath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", "")
	t.Setenv("PATH", dir)
	if got := herdrBin(); got != onpath {
		t.Errorf("PATH lookup: got %q want %q", got, onpath)
	}

	home := t.TempDir() // broken PATH → $HOME/.local/bin fallback
	lb := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(lb, 0o755); err != nil {
		t.Fatal(err)
	}
	hb := filepath.Join(lb, "herdr")
	if err := os.WriteFile(hb, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/no/such/dir")
	t.Setenv("HOME", home)
	if got := herdrBin(); got != hb {
		t.Errorf("HOME fallback: got %q want %q", got, hb)
	}
}

// TestPaneRe guards the pane-id validation that feeds an exec argv. The
// alphanumeric-workspace case (wE:p3) is the one that regressed once already.
func TestPaneRe(t *testing.T) {
	valid := []string{"w1:p1", "wE:p3", "w1:p10", "wABC:p0", "w2:p14"}
	invalid := []string{"", "p1", "w1", "w1:p", "w:p1", "w1p1", "w1:p1;rm -rf /", "w1:p1 x", "../etc"}
	for _, s := range valid {
		if !paneRe.MatchString(s) {
			t.Errorf("expected %q to be accepted", s)
		}
	}
	for _, s := range invalid {
		if paneRe.MatchString(s) {
			t.Errorf("expected %q to be rejected", s)
		}
	}
}

func TestHostOnly(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:8848": "127.0.0.1",
		"localhost:80":   "localhost",
		"example.com":    "example.com",
	}
	for in, want := range cases {
		if got := hostOnly(in); got != want {
			t.Errorf("hostOnly(%q)=%q want %q", in, got, want)
		}
	}
}

// TestHostAllowed covers the default-open-bind guard: loopback, this box's own
// hostname (bare + FQDN), and private/tailnet IPs pass; public domains/IPs don't.
func TestHostAllowed(t *testing.T) {
	oldAH, oldMH := allowHosts, machineHost
	allowHosts, machineHost = map[string]bool{}, "solo"
	defer func() { allowHosts, machineHost = oldAH, oldMH }()

	allow := []string{
		"127.0.0.1", "127.0.0.1:8848", "::1", "[::1]:8848",
		"10.0.0.5", "192.168.1.20", "172.16.3.4:8848", "100.100.1.1", // 100.64/10 tailnet
		"solo", "solo:8848", "solo-orin", "earthquake", "SOLO", // single-label LAN/MagicDNS names (dotless)
		"solo.tailnet.ts.net", "other.corp.ts.net", // Tailscale MagicDNS FQDNs
	}
	for _, h := range allow {
		if !hostAllowed(h) {
			t.Errorf("expected %q to be allowed", h)
		}
	}
	// Public-looking domains and public IPs are rejected (DNS-rebinding guard).
	deny := []string{"evil.com", "attacker.example:8848", "8.8.8.8", "1.2.3.4:8848", "phish.io"}
	for _, h := range deny {
		if hostAllowed(h) {
			t.Errorf("expected %q to be denied", h)
		}
	}
	allowHosts["*"] = true // wildcard disables the check
	if !hostAllowed("evil.com") {
		t.Error(`HERDVIEW_ALLOW_HOSTS="*" should allow any host`)
	}
}

// TestConfigDirFromEnviron covers per-process Claude config-dir resolution — the
// shared-account case where agents set CLAUDE_CONFIG_DIR=~/.claude-<name>.
func TestConfigDirFromEnviron(t *testing.T) {
	nul := func(kvs ...string) []byte { return []byte(strings.Join(kvs, "\x00") + "\x00") }
	def := "/home/me/.claude"
	cases := []struct {
		name string
		env  []byte
		want string
	}{
		{"set", nul("PATH=/bin", "CLAUDE_CONFIG_DIR=/home/beckett/.claude-achyut", "TERM=xterm"), "/home/beckett/.claude-achyut"},
		{"absent", nul("PATH=/bin", "HOME=/home/me"), def},
		{"empty", nul("CLAUDE_CONFIG_DIR="), def},
		{"multi first wins", nul("CLAUDE_CONFIG_DIR=/a/.claude,/b/.claude"), "/a/.claude"},
		{"no false prefix match", nul("XCLAUDE_CONFIG_DIR=/nope", "CLAUDE_CONFIG_DIRX=/nope"), def},
	}
	for _, c := range cases {
		if got := configDirFromEnviron(c.env, def); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// TestGuard covers the DNS-rebinding (Host) and CSRF (Origin) defenses.
func TestGuard(t *testing.T) {
	old := allowHosts
	allowHosts = map[string]bool{"127.0.0.1": true}
	defer func() { allowHosts = old }()

	h := guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	do := func(method, host, origin string) int {
		r := httptest.NewRequest(method, "http://"+host+"/x", nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}

	if c := do("GET", "127.0.0.1:8848", ""); c != http.StatusOK {
		t.Errorf("allowed GET: got %d want 200", c)
	}
	if c := do("GET", "evil.com", ""); c != http.StatusForbidden {
		t.Errorf("forbidden host: got %d want 403", c)
	}
	if c := do("POST", "127.0.0.1:8848", "http://evil.com"); c != http.StatusForbidden {
		t.Errorf("cross-site POST: got %d want 403", c)
	}
	if c := do("POST", "127.0.0.1:8848", "http://127.0.0.1:8848"); c != http.StatusOK {
		t.Errorf("same-site POST: got %d want 200", c)
	}
}

// TestParseTranscript feeds a representative Claude JSONL slice and asserts the
// bubble mapping: user string -> bubble, assistant text+tool_use -> bubble with
// a tool chip, and a tool_result-only user turn is filtered out (not a bubble).
// System-injected user turns (task-notifications, system-reminders, command
// echoes) must NOT render as the user's own chat bubbles.
func TestParseTranscriptSkipsSystemInjected(t *testing.T) {
	jsonl := `{"type":"user","message":{"role":"user","content":"real message from me"}}
{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>abc</task-id>\n</task-notification>"}}
{"type":"user","message":{"role":"user","content":"<system-reminder>be careful</system-reminder>"}}
{"type":"user","message":{"role":"user","content":"[SYSTEM NOTIFICATION - NOT USER INPUT] a background event"}}
{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"# /loop — skill body injected on load"}]}}
`
	out := parseTranscript([]byte(jsonl))
	if len(out) != 1 {
		t.Fatalf("expected only the 1 real user message, got %d: %+v", len(out), out)
	}
	if out[0].Text != "real message from me" {
		t.Errorf("kept the wrong turn: %+v", out[0])
	}
}

// Real AskUserQuestion picker layout (captured from a live Claude agent).
func TestParseChoices(t *testing.T) {
	read := "❯ Use your AskUserQuestion tool to ask 'Which fruit?'\n" +
		"─────────────────────────────────────────\n" +
		" ☐ Fruit\n" +
		"\n" +
		"Which fruit?\n" +
		"\n" +
		"❯ 1. Apple\n" +
		"     A crisp, common orchard fruit.\n" +
		"  2. Banana\n" +
		"     A soft, yellow tropical fruit.\n" +
		"  3. Cherry\n" +
		"     A small, red stone fruit.\n" +
		"  4. Date\n" +
		"     A sweet, chewy fruit from date palms.\n" +
		"  5. Type something.\n" +
		"─────────────────────────────────────────\n" +
		"  6. Chat about this\n" +
		"\n" +
		"Enter to select · ↑/↓ to navigate · Esc to cancel\n"

	q, opts, ok := parseChoices(read)
	if !ok {
		t.Fatal("expected a picker to be detected")
	}
	if q != "Which fruit?" {
		t.Errorf("question = %q, want %q", q, "Which fruit?")
	}
	want := []choice{
		{1, "Apple", true}, {2, "Banana", false}, {3, "Cherry", false},
		{4, "Date", false}, {5, "Type something.", false}, {6, "Chat about this", false},
	}
	if len(opts) != len(want) {
		t.Fatalf("got %d options, want %d: %+v", len(opts), len(want), opts)
	}
	for i, w := range want {
		if opts[i] != w {
			t.Errorf("option %d = %+v, want %+v", i, opts[i], w)
		}
	}

	// non-picker terminal text → not a picker
	if _, _, ok := parseChoices("$ ls\nfile1  file2\n$ "); ok {
		t.Error("plain terminal text should not parse as a picker")
	}
}

func TestParseTasks(t *testing.T) {
	read := "some earlier output\n" +
		"5 tasks (3 done, 2 open)\n" +
		"  ✔ Add --use-rigid-camera-map-depth feature flag\n" +
		"  ✔ Wire RigidCameraMapStage into pipeline\n" +
		"  ✔ Phase 1a: reproject depth\n" +
		"  ◻ Verify Phase 1a on LFC apple scan\n" +
		"  ◻ Phase 1b: per-frame Tiny RoMa refinement\n" +
		"\n$ \n"
	items, ok := parseTasks(read)
	if !ok || len(items) != 5 {
		t.Fatalf("got %d items, ok=%v", len(items), ok)
	}
	if items[0].Status != "done" || items[0].Text != "Add --use-rigid-camera-map-depth feature flag" {
		t.Errorf("item0 = %+v", items[0])
	}
	if items[3].Status != "open" || items[3].Text != "Verify Phase 1a on LFC apple scan" {
		t.Errorf("item3 = %+v", items[3])
	}
	done := 0
	for _, x := range items {
		if x.Status == "done" {
			done++
		}
	}
	if done != 3 {
		t.Errorf("done=%d, want 3", done)
	}
	if _, ok := parseTasks("just terminal output\n$ ls\nfile1 file2\n"); ok {
		t.Error("plain output should not parse as a task list")
	}
}

func TestParseProgress(t *testing.T) {
	// multi-part tab bar: Fruit answered (☒), Color pending (☐) → question 2 of 2
	multi := "❯ q\n←  ☒ Fruit  ☐ Color  ✔ Submit  →\nEnter to select · ↑/↓ to navigate · Esc to cancel\n"
	if i, tot := parseProgress(multi); i != 2 || tot != 2 {
		t.Errorf("multi-part: got %d/%d, want 2/2", i, tot)
	}
	// first part of three, none answered → 1 of 3
	first := "←  ☐ A  ☐ B  ☐ C  ✔ Submit  →\n"
	if i, tot := parseProgress(first); i != 1 || tot != 3 {
		t.Errorf("first-of-three: got %d/%d, want 1/3", i, tot)
	}
	// single question (no tab bar) → 0/0
	if i, tot := parseProgress("Which fruit?\n❯ 1. Apple\nEnter to select"); i != 0 || tot != 0 {
		t.Errorf("single question: got %d/%d, want 0/0", i, tot)
	}
}

func TestParseTranscript(t *testing.T) {
	jsonl := `{"type":"user","message":{"role":"user","content":"hello there"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi back"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"output"}]}}
{"type":"summary","summary":"x"}
`
	out := parseTranscript([]byte(jsonl))
	if len(out) != 2 {
		t.Fatalf("expected 2 bubbles (tool_result-only user filtered), got %d: %+v", len(out), out)
	}
	if out[0].Role != "user" || out[0].Text != "hello there" {
		t.Errorf("bubble 0 = %+v", out[0])
	}
	if out[1].Role != "assistant" || out[1].Text != "hi back" {
		t.Errorf("bubble 1 = %+v", out[1])
	}
	if len(out[1].Tools) != 1 || out[1].Tools[0].Name != "Bash" {
		t.Errorf("bubble 1 tools = %+v", out[1].Tools)
	}
}
