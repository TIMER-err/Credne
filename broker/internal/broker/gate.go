package broker

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

// APIPrefix is the only path prefix clients may call.
const APIPrefix = "/credne/v1/"

// oauthCallbackPaths receive browser redirects from the provider login pages.
// They carry no bearer token; CLIProxyAPI accepts them only for a pending
// login state it generated.
var oauthCallbackPaths = map[string]bool{
	"/anthropic/callback":   true,
	"/codex/callback":       true,
	"/antigravity/callback": true,
	"/devin/callback":       true,
	"/callback":             true,
}

type internalRequestKey struct{}

// withInternal marks a request the broker sends to CLIProxyAPI's management
// handlers in-process. Only such requests may reach /v8/management.
func withInternal(ctx context.Context) context.Context {
	return context.WithValue(ctx, internalRequestKey{}, true)
}

func isInternal(ctx context.Context) bool {
	marked, _ := ctx.Value(internalRequestKey{}).(bool)
	return marked
}

// gate is the first middleware of the embedded server. It reduces the full
// CLIProxyAPI HTTP surface to the broker API and tracks activity for idle
// shutdown.
type gate struct {
	token        []byte
	hosts        map[string]bool
	inflight     atomic.Int64
	lastActivity atomic.Int64
}

func newGate(token string, port int) *gate {
	portText := strconv.Itoa(port)
	g := &gate{
		token: []byte(token),
		// Rejecting other Host values blocks DNS-rebinding pages that resolve
		// an attacker domain to 127.0.0.1.
		hosts: map[string]bool{
			"127.0.0.1:" + portText: true,
			"localhost:" + portText: true,
		},
	}
	g.touch()
	return g
}

func (g *gate) touch() { g.lastActivity.Store(time.Now().UnixNano()) }

func (g *gate) handle(c *gin.Context) {
	req := c.Request
	if !g.hosts[strings.ToLower(req.Host)] {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden host"})
		return
	}
	path := req.URL.Path
	if req.Method == http.MethodGet && oauthCallbackPaths[path] {
		c.Next()
		return
	}
	if !g.authorized(req) {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing or invalid broker token"})
		return
	}
	switch {
	case strings.HasPrefix(path, APIPrefix):
		// Responses are never compressed on loopback; streams must flush as-is.
		req.Header.Del("Accept-Encoding")
		g.inflight.Add(1)
		g.touch()
		defer func() {
			g.inflight.Add(-1)
			g.touch()
		}()
		c.Next()
	case isInternal(req.Context()) && strings.HasPrefix(path, "/v8/management/"):
		c.Next()
	default:
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
	}
}

// authorized accepts the token as a bearer token (OpenAI SDKs) or as
// x-api-key (Anthropic SDKs).
func (g *gate) authorized(req *http.Request) bool {
	provided := ""
	if value := strings.TrimSpace(req.Header.Get("Authorization")); len(value) > 7 && strings.EqualFold(value[:7], "bearer ") {
		provided = strings.TrimSpace(value[7:])
	}
	if provided == "" {
		provided = strings.TrimSpace(req.Header.Get("X-Api-Key"))
	}
	return provided != "" && subtle.ConstantTimeCompare([]byte(provided), g.token) == 1
}

// watchIdle calls stop once no API request has been active for timeout.
func (g *gate) watchIdle(ctx context.Context, timeout time.Duration, stop func()) {
	if timeout <= 0 {
		return
	}
	interval := min(timeout/4, time.Minute)
	ticker := time.NewTicker(max(interval, 10*time.Millisecond))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			idle := time.Since(time.Unix(0, g.lastActivity.Load()))
			if g.inflight.Load() == 0 && idle >= timeout {
				log.Infof("broker idle for %s; shutting down", idle.Round(time.Second))
				stop()
				return
			}
		}
	}
}

// accountLimiter bounds concurrent requests per pinned account. A zero limit
// disables it. Waiting requests give up when their client disconnects.
type accountLimiter struct {
	limit int
	mu    sync.Mutex
	slots map[string]chan struct{}
}

func newAccountLimiter(limit int) *accountLimiter {
	return &accountLimiter{limit: limit, slots: map[string]chan struct{}{}}
}

func (l *accountLimiter) acquire(ctx context.Context, authID string) (func(), error) {
	if l.limit <= 0 {
		return func() {}, nil
	}
	l.mu.Lock()
	slot := l.slots[authID]
	if slot == nil {
		slot = make(chan struct{}, l.limit)
		l.slots[authID] = slot
	}
	l.mu.Unlock()
	select {
	case slot <- struct{}{}:
		return func() { <-slot }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
