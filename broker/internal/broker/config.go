package broker

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"gopkg.in/yaml.v3"
)

// UserConfigFileName is the optional user-owned CLIProxyAPI configuration in
// the broker home. It holds API-key accounts, retry and routing settings.
// Changes apply on the next broker start.
const UserConfigFileName = "config.yaml"

// buildRuntimeConfig merges the user configuration with the settings the
// broker must own, writes the result to <home>/runtime/config.yaml and loads
// it. CLIProxyAPI watches and may rewrite the runtime file; the user file is
// never modified.
//
// Enforced settings keep the embedded server a private loopback service:
// bound to 127.0.0.1, management reachable only through the broker's local
// password, no plugins, no LAN discovery, no pprof, no TLS, no request logs.
//
// lockedSecret becomes management.secret-key. CLIProxyAPI refuses every
// management call while no secret key exists, and recomputes route
// availability from it on each config reload, so a local password alone stops
// working. The broker generates the secret per run and never shares it; the
// broker token authenticates through the local-password path instead.
func buildRuntimeConfig(home string, port int, lockedSecret string) (*config.Config, string, error) {
	doc := map[string]any{}
	userPath := filepath.Join(home, UserConfigFileName)
	if data, err := os.ReadFile(userPath); err == nil {
		if err = yaml.Unmarshal(data, &doc); err != nil {
			return nil, "", fmt.Errorf("parse %s: %w", userPath, err)
		}
		if doc == nil {
			doc = map[string]any{}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}

	// Defaults the user may override.
	setDefault(doc, []string{"routing", "strategy"}, "round-robin")
	// Pools keep one Pi session on one account so provider caches and
	// continuation state stay valid; pinned routes ignore affinity.
	setDefault(doc, []string{"routing", "session-affinity"}, true)
	// Bounded retries: one extra round after the first, short cooldown waits.
	// Pi applies its own user-visible retry policy on top.
	setDefault(doc, []string{"routing", "retry", "request-retry"}, 1)
	setDefault(doc, []string{"routing", "retry", "max-retry-interval"}, 15)
	setDefault(doc, []string{"observability", "usage", "usage-statistics-enabled"}, false)

	authDir := filepath.Join(home, "auths")
	setPath(doc, []string{"config-version"}, 8)
	setPath(doc, []string{"server", "host"}, "127.0.0.1")
	setPath(doc, []string{"server", "port"}, port)
	setPath(doc, []string{"server", "tls", "enable"}, false)
	setPath(doc, []string{"server", "discovery", "enabled"}, false)
	// Loopback SSE gains nothing from compression and must flush promptly.
	setPath(doc, []string{"server", "response-compression", "enabled"}, false)
	setPath(doc, []string{"management", "allow-remote"}, false)
	setPath(doc, []string{"management", "secret-key"}, lockedSecret)
	setPath(doc, []string{"management", "disable-control-panel"}, true)
	setPath(doc, []string{"access", "api-keys"}, []any{})
	setPath(doc, []string{"oauth", "auth-dir"}, authDir)
	setPath(doc, []string{"plugins", "enabled"}, false)
	setPath(doc, []string{"observability", "pprof", "enable"}, false)
	setPath(doc, []string{"observability", "logs", "request-log"}, false)
	setPath(doc, []string{"observability", "logs", "logging-to-file"}, false)

	runtimeDir := filepath.Join(home, "runtime")
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return nil, "", err
	}
	data, err := yaml.Marshal(doc)
	if err != nil {
		return nil, "", err
	}
	runtimePath := filepath.Join(runtimeDir, "config.yaml")
	if err = os.WriteFile(runtimePath, data, 0o600); err != nil {
		return nil, "", err
	}
	cfg, err := config.LoadConfig(runtimePath)
	if err != nil {
		return nil, "", fmt.Errorf("load runtime config: %w", err)
	}
	if err = verifyRuntimeConfig(cfg, port, authDir); err != nil {
		return nil, "", err
	}
	return cfg, runtimePath, nil
}

// verifyRuntimeConfig fails closed if a CLIProxyAPI layout change stopped the
// enforced settings from taking effect.
func verifyRuntimeConfig(cfg *config.Config, port int, authDir string) error {
	switch {
	case cfg.Host != "127.0.0.1":
		return fmt.Errorf("runtime config: host %q is not loopback", cfg.Host)
	case cfg.Port != port:
		return fmt.Errorf("runtime config: port %d, want %d", cfg.Port, port)
	case filepath.Clean(cfg.AuthDir) != filepath.Clean(authDir):
		return fmt.Errorf("runtime config: auth dir %q, want %q", cfg.AuthDir, authDir)
	case cfg.RemoteManagement.AllowRemote:
		return errors.New("runtime config: remote management must stay disabled")
	case cfg.Plugins.Enabled:
		return errors.New("runtime config: plugins must stay disabled")
	case cfg.Pprof.Enable:
		return errors.New("runtime config: pprof must stay disabled")
	case cfg.TLS.Enable:
		return errors.New("runtime config: TLS must stay disabled on loopback")
	}
	return nil
}

func setPath(doc map[string]any, path []string, value any) {
	parentOf(doc, path)[path[len(path)-1]] = value
}

func setDefault(doc map[string]any, path []string, value any) {
	parent := parentOf(doc, path)
	if _, exists := parent[path[len(path)-1]]; !exists {
		parent[path[len(path)-1]] = value
	}
}

// parentOf returns the map holding the last key of path, creating (or
// replacing non-map values with) intermediate maps.
func parentOf(doc map[string]any, path []string) map[string]any {
	parent := doc
	for _, key := range path[:len(path)-1] {
		child, ok := parent[key].(map[string]any)
		if !ok {
			child = map[string]any{}
			parent[key] = child
		}
		parent = child
	}
	return parent
}
