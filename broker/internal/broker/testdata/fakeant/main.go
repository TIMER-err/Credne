// Command fakeant imitates the `ant` CLI commands the broker uses, for tests:
// `auth login --profile P --no-browser --callback-port 0` binds a loopback
// callback, prints an authorize URL whose redirect_uri names it, and exits once
// /callback is requested; `auth print-credentials --profile P` prints a token
// with the account email and Console organization; `auth logout --profile P`
// removes the profile.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

func main() {
	args := os.Args[1:]
	profile := flagValue(args, "--profile")
	dir := os.Getenv("ANTHROPIC_CONFIG_DIR")
	marker := filepath.Join(dir, "logged-in-"+profile)
	if len(args) < 2 || args[0] != "auth" {
		fail("unsupported command")
	}
	switch args[1] {
	case "login":
		login(marker)
	case "print-credentials":
		if _, err := os.Stat(marker); err != nil {
			fail(fmt.Sprintf("not logged in (profile %q)", profile))
		}
		expires := time.Now().Add(time.Hour).Unix()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"type":              "oauth_token",
			"access_token":      "sk-ant-oat01-fake-" + profile,
			"expires_at":        expires,
			"account_email":     profile + "@example.com",
			"organization_name": "Example Org",
			"organization_uuid": organizationUUID(profile),
		})
	case "logout":
		_ = os.Remove(marker)
	default:
		fail("unsupported auth command")
	}
}

func login(marker string) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail(err.Error())
	}
	port := listener.Addr().(*net.TCPAddr).Port
	redirect := fmt.Sprintf("http://localhost:%d/callback", port)
	authorize := "https://console.example/oauth/authorize?redirect_uri=" + url.QueryEscape(redirect)
	fmt.Fprintf(os.Stderr, "Authorization URL (open on the machine where your SSH session originates):\n\n  %s\n\n", authorize)
	fmt.Fprintf(os.Stderr, "Waiting for callback on %s ...\n", redirect)
	done := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" || r.URL.Query().Get("code") == "" {
			http.Error(w, "bad callback", http.StatusBadRequest)
			return
		}
		_ = os.MkdirAll(filepath.Dir(marker), 0o700)
		_ = os.WriteFile(marker, []byte("ok"), 0o600)
		_, _ = w.Write([]byte("signed in"))
		close(done)
	})}
	go func() { _ = server.Serve(listener) }()
	select {
	case <-done:
		time.Sleep(50 * time.Millisecond)
	case <-time.After(2 * time.Minute):
		fail("timed out")
	}
}

// organizationUUID is distinct per profile, so profiles are separate Console
// organizations unless a test sets FAKEANT_ORGANIZATION_UUID to put them all in one.
func organizationUUID(profile string) string {
	if shared := os.Getenv("FAKEANT_ORGANIZATION_UUID"); shared != "" {
		return shared
	}
	return "org-" + profile
}

func flagValue(args []string, name string) string {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return "default"
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
