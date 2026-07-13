package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

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
