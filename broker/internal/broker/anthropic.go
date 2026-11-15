package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/MoeForge/moego/ojson"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// The official Anthropic API, for API-key and API-credit accounts.
//
// CLIProxyAPI's Claude executor is built for Claude subscriptions: it treats
// every OAuth token as a Claude Code login and rewrites requests to look like
// Claude Code. API-credit tokens from `ant auth login` are Console OAuth
// tokens with the same prefix, but they are plain API credentials. This
// executor sends the harness's Messages request to
// api.anthropic.com with the account's credential. CLIProxyAPI still selects
// accounts, pools them, cools them down and retries. Proxy-only options are
// removed; the native system, messages and cache breakpoints are preserved.

// APIProviderKey is the CLIProxyAPI provider key of official-API accounts.
const APIProviderKey = "claude-api"

const (
	anthropicDefaultBaseURL = "https://api.anthropic.com"
	anthropicVersion        = "2023-06-01"
	// anthropicOAuthBeta is required on API requests made with a Console OAuth bearer token.
	anthropicOAuthBeta = "oauth-2025-04-20"
	// creditsExhaustedRetry is how long an account without API credits rests
	// before the pool tries it again; credits refresh per billing cycle.
	creditsExhaustedRetry = time.Hour
)

// anthropicCredential is how one request authenticates.
type anthropicCredential struct {
	apiKey      string
	bearerToken string
}

func (c anthropicCredential) apply(header http.Header) {
	if c.bearerToken != "" {
		header.Del("X-Api-Key")
		header.Set("Authorization", "Bearer "+c.bearerToken)
		beta := header.Get("Anthropic-Beta")
		switch {
		case beta == "":
			header.Set("Anthropic-Beta", anthropicOAuthBeta)
		case !strings.Contains(beta, anthropicOAuthBeta):
			header.Set("Anthropic-Beta", beta+","+anthropicOAuthBeta)
		}
		return
	}
	header.Del("Authorization")
	header.Set("X-Api-Key", c.apiKey)
}

// credentialResolver returns the credential of an official-API account.
// invalidate drops a cached token after the API rejected it.
type credentialResolver interface {
	credential(ctx context.Context, auth *coreauth.Auth) (anthropicCredential, error)
	invalidate(auth *coreauth.Auth)
}

type anthropicExecutor struct {
	baseURL string
	client  *http.Client
	creds   credentialResolver
}

func (e *anthropicExecutor) Identifier() string { return APIProviderKey }

func (e *anthropicExecutor) Execute(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	resp, err := e.send(ctx, auth, req, opts, "/v1/messages")
	if err != nil {
		return cliproxyexecutor.Response{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return cliproxyexecutor.Response{}, err
	}
	return cliproxyexecutor.Response{Payload: payload, Headers: resp.Header.Clone()}, nil
}

func (e *anthropicExecutor) ExecuteStream(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	resp, err := e.send(ctx, auth, req, opts, "/v1/messages")
	if err != nil {
		return nil, err
	}
	chunks := make(chan cliproxyexecutor.StreamChunk)
	go forwardSSEEvents(ctx, resp.Body, chunks)
	return &cliproxyexecutor.StreamResult{Headers: resp.Header.Clone(), Chunks: chunks}, nil
}

func (e *anthropicExecutor) CountTokens(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	resp, err := e.send(ctx, auth, req, opts, "/v1/messages/count_tokens")
	if err != nil {
		return cliproxyexecutor.Response{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(resp.Body)
	return cliproxyexecutor.Response{Payload: payload, Headers: resp.Header.Clone()}, err
}

// Refresh is a no-op: API keys do not expire and `ant` refreshes API-credit tokens.
func (e *anthropicExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	return auth, nil
}

func (e *anthropicExecutor) HttpRequest(ctx context.Context, auth *coreauth.Auth, req *http.Request) (*http.Response, error) {
	credential, err := e.creds.credential(ctx, auth)
	if err != nil {
		return nil, err
	}
	out := req.WithContext(ctx)
	credential.apply(out.Header)
	return e.client.Do(out)
}

// send removes proxy-only cache options, posts the native Messages body and turns non-2xx
// responses into errors CLIProxyAPI uses for cooldowns and failover.
func (e *anthropicExecutor) send(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options, path string) (*http.Response, error) {
	if source := strings.ToLower(string(opts.SourceFormat)); source != "" && source != protocolClaude {
		return nil, &upstreamError{status: http.StatusBadRequest, message: "official Anthropic API accounts accept Anthropic Messages requests only", requestScoped: true}
	}
	credential, err := e.creds.credential(ctx, auth)
	if err != nil {
		return nil, &upstreamError{status: http.StatusUnauthorized, message: err.Error()}
	}
	// Subscription routes consume this CLIProxyAPI option themselves. Official
	// API routes must remove it too, so a mixed pool sends only native API fields.
	payload := req.Payload
	if ojson.GetBytesNoCopy(payload, "prompt_cache_options").Exists() {
		payload, err = ojson.DeleteBytes(payload, "prompt_cache_options")
		if err != nil {
			return nil, &upstreamError{status: http.StatusBadRequest, message: "invalid proxy cache options: " + err.Error(), requestScoped: true}
		}
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, e.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	for name, values := range opts.Headers {
		canonical := http.CanonicalHeaderKey(name)
		if strings.HasPrefix(canonical, "Anthropic-") || canonical == "User-Agent" {
			httpReq.Header[canonical] = append([]string(nil), values...)
		}
	}
	if httpReq.Header.Get("Anthropic-Version") == "" {
		httpReq.Header.Set("Anthropic-Version", anthropicVersion)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if opts.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	}
	credential.apply(httpReq.Header)
	resp, err := e.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 300 {
		return resp, nil
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		e.creds.invalidate(auth)
	}
	return nil, newUpstreamError(resp.StatusCode, resp.Header, body)
}

// forwardSSEEvents emits each complete SSE event (terminated by a blank line)
// as one chunk, the framing CLIProxyAPI's Claude handlers expect.
func forwardSSEEvents(ctx context.Context, body io.ReadCloser, chunks chan<- cliproxyexecutor.StreamChunk) {
	defer close(chunks)
	defer func() { _ = body.Close() }()
	send := func(chunk cliproxyexecutor.StreamChunk) bool {
		select {
		case chunks <- chunk:
			return true
		case <-ctx.Done():
			return false
		}
	}
	reader := bufio.NewReaderSize(body, 64<<10)
	var event bytes.Buffer
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			blank := len(bytes.TrimRight(line, "\r\n")) == 0
			if !blank || event.Len() > 0 {
				event.Write(line)
			}
			if blank && event.Len() > 0 {
				if !send(cliproxyexecutor.StreamChunk{Payload: bytes.Clone(event.Bytes())}) {
					return
				}
				event.Reset()
			}
		}
		if err != nil {
			if err != io.EOF && ctx.Err() == nil {
				send(cliproxyexecutor.StreamChunk{Err: err})
				return
			}
			if event.Len() > 0 {
				event.WriteString("\n")
				send(cliproxyexecutor.StreamChunk{Payload: bytes.Clone(event.Bytes())})
			}
			return
		}
	}
}

// upstreamError carries an Anthropic API failure to CLIProxyAPI. StatusCode
// and RetryAfter drive cooldowns; request-scoped errors never fail over.
type upstreamError struct {
	status        int
	message       string
	retryAfter    *time.Duration
	requestScoped bool
}

func (e *upstreamError) Error() string              { return e.message }
func (e *upstreamError) StatusCode() int            { return e.status }
func (e *upstreamError) RetryAfter() *time.Duration { return e.retryAfter }
func (e *upstreamError) IsRequestScoped() bool      { return e.requestScoped }

func newUpstreamError(status int, header http.Header, body []byte) *upstreamError {
	err := &upstreamError{status: status, message: strings.TrimSpace(string(body))}
	if err.message == "" {
		err.message = http.StatusText(status)
	}
	if seconds, parseErr := strconv.Atoi(strings.TrimSpace(header.Get("Retry-After"))); parseErr == nil && seconds > 0 {
		wait := time.Duration(seconds) * time.Second
		err.retryAfter = &wait
	}
	// An organization out of API credits answers 400; treat it as the account
	// being exhausted so pools move on and the account rests.
	if status == http.StatusBadRequest && strings.Contains(strings.ToLower(err.message), "credit balance is too low") {
		err.status = http.StatusPaymentRequired
		wait := creditsExhaustedRetry
		err.retryAfter = &wait
	}
	return err
}

// anthropicModel is one entry of GET /v1/models.
type anthropicModel struct {
	ID             string `json:"id"`
	DisplayName    string `json:"display_name"`
	MaxInputTokens int    `json:"max_input_tokens"`
	MaxTokens      int    `json:"max_tokens"`
}

// listAnthropicModels returns the models an official-API credential can use.
func listAnthropicModels(ctx context.Context, client *http.Client, baseURL string, credential anthropicCredential) ([]anthropicModel, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models?limit=1000", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Anthropic-Version", anthropicVersion)
	credential.apply(req.Header)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list models: HTTP %d: %s", resp.StatusCode, upstreamMessage(string(body)))
	}
	var page struct {
		Data []anthropicModel `json:"data"`
	}
	if err = json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("list models: %w", err)
	}
	return page.Data, nil
}
