package broker

import (
	"fmt"
	"strings"
	"sync"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// CLIProxyAPI names a subscription credential after the signed-in identity
// (Claude: email, organization and account; Codex: email, plan and account), so
// signing in to an account that is already added rewrites that credential
// instead of adding a second one. The login still reports success, which would
// tell the user an account was added when none was. The broker therefore
// remembers which accounts existed when each login started and reports a login
// that only renewed one of them as a duplicate.

// loginBaselineTTL bounds how long a baseline is kept for repeated status polls.
const loginBaselineTTL = time.Hour

type loginBaseline struct {
	startedAt time.Time
	// versions maps each auth id that existed at login start to its credential
	// version, which moves whenever a login rewrites that credential.
	versions map[string]uint64
	// The first verdict is kept, so later polls answer the same even when
	// accounts change in between.
	decided bool
	message string
}

// loginBaselines holds the baseline of every started subscription login by state.
type loginBaselines struct {
	mu      sync.Mutex
	byState map[string]*loginBaseline
}

func newLoginBaselines() *loginBaselines {
	return &loginBaselines{byState: map[string]*loginBaseline{}}
}

// add records the accounts that exist when the login with this state starts.
func (b *loginBaselines) add(state string, auths []*coreauth.Auth) {
	versions := make(map[string]uint64, len(auths))
	for _, auth := range auths {
		versions[auth.ID] = auth.CredentialVersion
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for old, baseline := range b.byState {
		if time.Since(baseline.startedAt) > loginBaselineTTL {
			delete(b.byState, old)
		}
	}
	b.byState[state] = &loginBaseline{startedAt: time.Now(), versions: versions}
}

func (b *loginBaselines) forget(state string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.byState, state)
}

// duplicateMessage returns the user-facing error for a finished login that only
// renewed an account that was already added, or "" when it added a new one.
// reportedID is the auth id CLIProxyAPI reported for the login, which is empty
// for Claude: its login completes without naming the credential it wrote.
func (b *loginBaselines) duplicateMessage(state, reportedID string, auths []*coreauth.Auth) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	baseline, ok := b.byState[state]
	if !ok {
		return ""
	}
	if !baseline.decided {
		baseline.decided = true
		if renewed := baseline.renewedAuth(auths, reportedID); renewed != nil {
			baseline.message = renewedLoginMessage(renewed)
		}
	}
	return baseline.message
}

// renewedAuth finds the account that existed before the login and was rewritten by it.
func (l *loginBaseline) renewedAuth(auths []*coreauth.Auth, reportedID string) *coreauth.Auth {
	if reportedID != "" {
		return l.existingAuth(auths, reportedID)
	}
	return l.changedAuth(auths)
}

func (l *loginBaseline) existingAuth(auths []*coreauth.Auth, id string) *coreauth.Auth {
	for _, auth := range auths {
		if _, existed := l.versions[auth.ID]; existed && auth.ID == id {
			return auth
		}
	}
	return nil
}

// changedAuth is for logins that name no credential. A login always writes one,
// so when no new account appeared, an existing one with a newer credential
// version is the one it overwrote.
func (l *loginBaseline) changedAuth(auths []*coreauth.Auth) *coreauth.Auth {
	var changed *coreauth.Auth
	for _, auth := range auths {
		version, existed := l.versions[auth.ID]
		if !existed {
			return nil
		}
		if auth.CredentialVersion != version {
			changed = auth
		}
	}
	return changed
}

func renewedLoginMessage(auth *coreauth.Auth) string {
	return fmt.Sprintf("%s is already added as a %s subscription. Its sign-in was renewed; no account was added.",
		emailOrID(auth), subscriptionName(auth.Provider))
}

func emailOrID(auth *coreauth.Auth) string {
	if email := metadataString(auth, "email"); email != "" {
		return email
	}
	return auth.ID
}

func subscriptionName(provider string) string {
	switch strings.ToLower(provider) {
	case "claude":
		return "Claude"
	case "codex":
		return "ChatGPT"
	}
	return provider
}
