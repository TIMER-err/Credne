package broker

import (
	"fmt"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func subscriptionAuth(id, provider, email string, version uint64) *coreauth.Auth {
	auth := &coreauth.Auth{ID: id, Provider: provider, CredentialVersion: version}
	if email != "" {
		auth.Metadata = map[string]any{"email": email}
	}
	return auth
}

const (
	claudeRenewed = "a@example.com is already added as a Claude subscription. Its sign-in was renewed; no account was added."
	codexRenewed  = "b@example.com is already added as a ChatGPT subscription. Its sign-in was renewed; no account was added."
)

// The login status route cannot reach "ok" without a real OAuth exchange, so
// the mapping from a finished login to a duplicate verdict is tested on the
// baseline directly.
func TestLoginBaselineReportsRenewedSubscription(t *testing.T) {
	existing := func() []*coreauth.Auth {
		return []*coreauth.Auth{
			subscriptionAuth("claude-a.json", "claude", "a@example.com", 3),
			subscriptionAuth("codex-b.json", "codex", "b@example.com", 1),
			subscriptionAuth("claude-key", "claude", "", 1),
		}
	}
	cases := []struct {
		name       string
		reportedID string
		after      func() []*coreauth.Auth
		want       string
	}{
		{"reported id that already existed", "codex-b.json", existing, codexRenewed},
		{"reported id that is new", "codex-c.json", func() []*coreauth.Auth {
			return append(existing(), subscriptionAuth("codex-c.json", "codex", "c@example.com", 1))
		}, ""},
		{"no id and an existing credential rewritten", "", func() []*coreauth.Auth {
			after := existing()
			after[0].CredentialVersion++
			return after
		}, claudeRenewed},
		{"no id and a new account appeared", "", func() []*coreauth.Auth {
			after := append(existing(), subscriptionAuth("claude-c.json", "claude", "c@example.com", 1))
			after[0].CredentialVersion++
			return after
		}, ""},
		{"no id and nothing changed", "", existing, ""},
		{"an account without email is named by id", "claude-key", existing, "claude-key is already added as a Claude subscription. Its sign-in was renewed; no account was added."},
	}
	for i, tc := range cases {
		baselines := newLoginBaselines()
		state := fmt.Sprint("state-", i)
		baselines.add(state, existing())
		if got := baselines.duplicateMessage(state, tc.reportedID, tc.after()); got != tc.want {
			t.Errorf("%s: message %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestLoginBaselineKeepsItsFirstAnswer(t *testing.T) {
	baselines := newLoginBaselines()
	before := []*coreauth.Auth{subscriptionAuth("claude-a.json", "claude", "a@example.com", 3)}
	baselines.add("state", before)
	renewed := []*coreauth.Auth{subscriptionAuth("claude-a.json", "claude", "a@example.com", 4)}
	if got := baselines.duplicateMessage("state", "", renewed); got != claudeRenewed {
		t.Fatalf("first answer %q", got)
	}
	// A second account added later must not turn the repeated answer around.
	later := append(renewed, subscriptionAuth("claude-c.json", "claude", "c@example.com", 1))
	if got := baselines.duplicateMessage("state", "", later); got != claudeRenewed {
		t.Fatalf("repeated answer %q", got)
	}
}

func TestLoginBaselineForgetsCancelledLogins(t *testing.T) {
	baselines := newLoginBaselines()
	existing := []*coreauth.Auth{subscriptionAuth("codex-b.json", "codex", "b@example.com", 1)}
	baselines.add("state", existing)
	baselines.forget("state")
	if got := baselines.duplicateMessage("state", "codex-b.json", existing); got != "" {
		t.Fatalf("cancelled login still reported: %q", got)
	}
	if got := baselines.duplicateMessage("never-started", "codex-b.json", existing); got != "" {
		t.Fatalf("unknown state reported: %q", got)
	}
}
