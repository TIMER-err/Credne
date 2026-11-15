package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// accountView is the public description of one account. It is built field by
// field from coreauth.Auth so token material (Storage, Metadata, Attributes)
// can never leak through the IPC API.
type accountView struct {
	ID            string     `json:"id"`
	Key           string     `json:"key"`
	Provider      string     `json:"provider"`
	Kind          string     `json:"kind"`
	Source        string     `json:"source"`
	Label         string     `json:"label,omitempty"`
	Email         string     `json:"email,omitempty"`
	Plan          string     `json:"plan,omitempty"`
	Prefix        string     `json:"prefix,omitempty"`
	Status        string     `json:"status"`
	StatusMessage string     `json:"statusMessage,omitempty"`
	Disabled      bool       `json:"disabled"`
	Unavailable   bool       `json:"unavailable"`
	QuotaExceeded bool       `json:"quotaExceeded"`
	QuotaReason   string     `json:"quotaReason,omitempty"`
	RetryAfter    *time.Time `json:"retryAfter,omitempty"`
	LastError     *errorView `json:"lastError,omitempty"`
	ModelCount    int        `json:"modelCount"`
}

type errorView struct {
	Code       string `json:"code,omitempty"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
}

// Account kinds. They are not interchangeable: OAuth accounts use a
// subscription through CLIProxyAPI's provider-specific client emulation,
// API-key accounts call the provider API directly.
const (
	kindOAuth  = "oauth"
	kindAPIKey = "api-key"
)

func newAccountView(a *coreauth.Auth) accountView {
	view := accountView{
		ID:            a.ID,
		Key:           encodeKey(a.ID),
		Provider:      strings.ToLower(a.Provider),
		Kind:          kindOAuth,
		Source:        a.AuthSourceKind(),
		Label:         a.Label,
		Email:         metadataString(a, "email"),
		Plan:          metadataString(a, "plan_type"),
		Prefix:        a.Prefix,
		Status:        string(a.Status),
		StatusMessage: a.StatusMessage,
		Disabled:      a.Disabled,
		Unavailable:   a.Unavailable,
		QuotaExceeded: a.Quota.Exceeded,
		QuotaReason:   a.Quota.Reason,
		ModelCount:    len(cliproxy.GlobalModelRegistry().GetModelsForClient(a.ID)),
	}
	if kind := a.Attributes[attrKind]; kind != "" {
		// Broker-managed official-API account: "api-key" or "api-credits".
		view.Kind = kind
		view.Source = "broker"
	} else if a.AuthKind() == coreauth.AuthKindAPIKey {
		view.Kind = kindAPIKey
	}
	retry := a.NextRetryAfter
	if a.Quota.NextRecoverAt.After(retry) {
		retry = a.Quota.NextRecoverAt
	}
	if retry.After(time.Now()) {
		view.RetryAfter = &retry
	}
	if a.LastError != nil {
		view.LastError = &errorView{Code: a.LastError.Code, Message: a.LastError.Message, HTTPStatus: a.LastError.HTTPStatus}
	}
	return view
}

// metadataString reads one non-secret descriptive field. Metadata also holds
// tokens, so callers must name the field explicitly.
func metadataString(a *coreauth.Auth, key string) string {
	if value, ok := a.Metadata[key].(string); ok && value != "" {
		return value
	}
	return a.Attributes[key]
}

func accountName(a *coreauth.Auth) string {
	if email := metadataString(a, "email"); email != "" {
		return fmt.Sprintf("%s (%s)", email, strings.ToLower(a.Provider))
	}
	if a.Label != "" {
		return fmt.Sprintf("%s (%s)", a.Label, strings.ToLower(a.Provider))
	}
	return a.ID
}

type modelView struct {
	ID                  string   `json:"id"`
	DisplayName         string   `json:"displayName,omitempty"`
	ContextLength       int      `json:"contextLength,omitempty"`
	MaxCompletionTokens int      `json:"maxCompletionTokens,omitempty"`
	Thinking            bool     `json:"thinking"`
	ThinkingLevels      []string `json:"thinkingLevels,omitempty"`
	InputModalities     []string `json:"inputModalities,omitempty"`
}

func modelViews(models []*cliproxy.ModelInfo) []modelView {
	views := make([]modelView, 0, len(models))
	for _, m := range models {
		if m == nil {
			continue
		}
		view := modelView{
			ID:                  m.ID,
			DisplayName:         m.DisplayName,
			ContextLength:       m.ContextLength,
			MaxCompletionTokens: m.MaxCompletionTokens,
			InputModalities:     m.SupportedInputModalities,
		}
		if view.ContextLength == 0 {
			view.ContextLength = m.InputTokenLimit
		}
		if view.MaxCompletionTokens == 0 {
			view.MaxCompletionTokens = m.OutputTokenLimit
		}
		if m.Thinking != nil {
			view.Thinking = true
			view.ThinkingLevels = m.Thinking.Levels
		}
		views = append(views, view)
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	return views
}

func (s *server) listAccounts(c *gin.Context) {
	auths := s.handler.AuthManager.List()
	views := make([]accountView, 0, len(auths))
	for _, a := range auths {
		views = append(views, newAccountView(a))
	}
	sort.Slice(views, func(i, j int) bool {
		if views[i].Provider != views[j].Provider {
			return views[i].Provider < views[j].Provider
		}
		return views[i].ID < views[j].ID
	})
	c.JSON(http.StatusOK, gin.H{"accounts": views})
}

// accountFromKey resolves the :key path parameter or writes a 404.
func (s *server) accountFromKey(c *gin.Context) (*coreauth.Auth, bool) {
	id, err := decodeKey(c.Param("key"))
	if err == nil {
		if auth, ok := s.handler.AuthManager.GetByID(id); ok {
			return auth, true
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "account not found"})
	return nil, false
}

func (s *server) accountModels(c *gin.Context) {
	auth, ok := s.accountFromKey(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"models": modelViews(cliproxy.GlobalModelRegistry().GetModelsForClient(auth.ID))})
}

func (s *server) setDisabled(disabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth, ok := s.accountFromKey(c)
		if !ok || !s.requireFileAccount(c, auth) {
			return
		}
		if _, managed := s.apiAccounts.get(auth.ID); managed {
			if err := s.apiAccounts.setDisabled(c.Request.Context(), auth.ID, disabled); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			s.respondAccount(c, auth.ID)
			return
		}
		status, body := s.management(c.Request.Context(), http.MethodPatch, "/v8/management/credentials/status", nil,
			map[string]any{"name": auth.ID, "disabled": disabled})
		if status != http.StatusOK {
			c.JSON(status, gin.H{"error": managementError(body)})
			return
		}
		if updated, found := s.handler.AuthManager.GetByID(auth.ID); found {
			c.JSON(http.StatusOK, gin.H{"account": newAccountView(updated)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// resetCooldown clears an account's quota/cooldown state so it is selectable
// again, for example after the user knows a usage window has reset.
func (s *server) resetCooldown(c *gin.Context) {
	auth, ok := s.accountFromKey(c)
	if !ok {
		return
	}
	status, body := s.management(c.Request.Context(), http.MethodPost, "/v8/management/routing/cooldown/reset", nil,
		map[string]any{"auth_index": auth.Index})
	if status != http.StatusOK {
		c.JSON(errorStatus(status), gin.H{"error": managementError(body)})
		return
	}
	if updated, found := s.handler.AuthManager.GetByID(auth.ID); found {
		c.JSON(http.StatusOK, gin.H{"account": newAccountView(updated)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) deleteAccount(c *gin.Context) {
	auth, ok := s.accountFromKey(c)
	if !ok || !s.requireFileAccount(c, auth) {
		return
	}
	if _, managed := s.apiAccounts.get(auth.ID); managed {
		if err := s.apiAccounts.remove(c.Request.Context(), auth.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	status, body := s.management(c.Request.Context(), http.MethodDelete, "/v8/management/credentials", url.Values{"name": {auth.ID}}, nil)
	if status != http.StatusOK {
		c.JSON(status, gin.H{"error": managementError(body)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// requireFileAccount rejects mutations of API-key accounts, which are owned by
// the user's config.yaml rather than the credential store.
func (s *server) requireFileAccount(c *gin.Context, auth *coreauth.Auth) bool {
	if auth.AuthSourceKind() == coreauth.AuthSourceConfig {
		c.JSON(http.StatusConflict, gin.H{"error": "API-key accounts are managed in the broker config.yaml"})
		return false
	}
	return true
}

func (s *server) startLogin(c *gin.Context) {
	var in struct {
		Provider string `json:"provider"`
		Name     string `json:"name"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.Provider) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider is required"})
		return
	}
	if strings.EqualFold(strings.TrimSpace(in.Provider), APICreditsLoginProvider) {
		s.startCreditsLogin(c, in.Name)
		return
	}
	// is_webui starts CLIProxyAPI's local callback forwarder (for example on
	// :54545 for Claude, :1455 for Codex) so the browser redirect completes the
	// login without a manual paste.
	query := url.Values{"provider": {strings.ToLower(strings.TrimSpace(in.Provider))}, "is_webui": {"true"}}
	// The baseline is taken before CLIProxyAPI creates the session, so it
	// predates anything the login can write.
	existing := s.handler.AuthManager.List()
	status, body := s.management(c.Request.Context(), http.MethodGet, "/v8/management/oauth/auth-url", query, nil)
	var out struct {
		URL      string `json:"url"`
		State    string `json:"state"`
		Flow     string `json:"flow"`
		UserCode string `json:"user_code"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &out) != nil || out.URL == "" || out.State == "" {
		c.JSON(errorStatus(status), gin.H{"error": managementError(body)})
		return
	}
	s.baselines.add(out.State, existing)
	c.JSON(http.StatusOK, gin.H{"state": out.State, "url": out.URL, "flow": out.Flow, "userCode": out.UserCode})
}

func (s *server) loginStatus(c *gin.Context) {
	if pending, ok := s.apiAccounts.creditsLogin(c.Param("state")); ok {
		s.creditsLoginStatus(c, pending)
		return
	}
	status, body := s.management(c.Request.Context(), http.MethodGet, "/v8/management/oauth/status", url.Values{"state": {c.Param("state")}}, nil)
	var out struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		AuthID string `json:"auth_id"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &out) != nil {
		c.JSON(errorStatus(status), gin.H{"status": "error", "error": managementError(body)})
		return
	}
	if out.Status == "ok" {
		if message := s.baselines.duplicateMessage(c.Param("state"), out.AuthID, s.handler.AuthManager.List()); message != "" {
			c.JSON(http.StatusOK, gin.H{"status": "error", "error": message})
			return
		}
	}
	response := gin.H{"status": out.Status}
	if out.Error != "" {
		response["error"] = out.Error
	}
	if out.AuthID != "" {
		if auth, found := s.handler.AuthManager.GetByID(out.AuthID); found {
			response["account"] = newAccountView(auth)
		}
	}
	c.JSON(http.StatusOK, response)
}

func (s *server) loginCallback(c *gin.Context) {
	var in struct {
		RedirectURL string `json:"redirectUrl"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.RedirectURL) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "redirectUrl is required"})
		return
	}
	if _, ok := s.apiAccounts.creditsLogin(c.Param("state")); ok {
		s.creditsLoginCallback(c, strings.TrimSpace(in.RedirectURL))
		return
	}
	status, body := s.management(c.Request.Context(), http.MethodPost, "/v8/management/oauth/callback", nil,
		map[string]any{"state": c.Param("state"), "redirect_url": strings.TrimSpace(in.RedirectURL)})
	if status != http.StatusOK {
		c.JSON(errorStatus(status), gin.H{"error": managementError(body)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) cancelLogin(c *gin.Context) {
	if pending, ok := s.apiAccounts.creditsLogin(c.Param("state")); ok {
		s.cancelCreditsLogin(c, c.Param("state"), pending)
		return
	}
	s.baselines.forget(c.Param("state"))
	status, body := s.management(c.Request.Context(), http.MethodDelete, "/v8/management/oauth/session", url.Values{"state": {c.Param("state")}}, nil)
	if status != http.StatusOK {
		c.JSON(errorStatus(status), gin.H{"error": managementError(body)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// management calls a CLIProxyAPI v8 management handler in-process. The
// request carries the broker token as the runtime-local management password
// and a loopback remote address, exactly like a local operator call.
func (s *server) management(ctx context.Context, method, path string, query url.Values, body any) (int, []byte) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return http.StatusInternalServerError, []byte(`{"error":"encode management request"}`)
		}
		reader = bytes.NewReader(data)
	}
	target := path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(withInternal(ctx), method, "http://"+s.host+target, reader)
	if err != nil {
		return http.StatusInternalServerError, []byte(`{"error":"build management request"}`)
	}
	req.Host = s.host
	req.RemoteAddr = "127.0.0.1:1"
	req.Header.Set("Authorization", "Bearer "+s.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	s.engine.ServeHTTP(recorder, req)
	return recorder.Code, recorder.Body.Bytes()
}

func managementError(body []byte) string {
	var out struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &out) == nil && out.Error != "" {
		return out.Error
	}
	if text := strings.TrimSpace(string(body)); text != "" {
		return text
	}
	return "management request failed"
}

func errorStatus(status int) int {
	if status >= 400 {
		return status
	}
	return http.StatusBadGateway
}
