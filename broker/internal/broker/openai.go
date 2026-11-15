// Sends OpenAI API key requests directly to the official API without Codex login emulation.
package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

const OpenAIAPIProviderKey = "openai-api"
const openAIDefaultBaseURL = "https://api.openai.com"

type openaiExecutor struct {
	baseURL string
	client  *http.Client
}

func (e *openaiExecutor) Identifier() string { return OpenAIAPIProviderKey }

func (e *openaiExecutor) Execute(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	resp, err := e.send(ctx, auth, req, opts)
	if err != nil {
		return cliproxyexecutor.Response{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(resp.Body)
	return cliproxyexecutor.Response{Payload: payload, Headers: resp.Header.Clone()}, err
}

func (e *openaiExecutor) ExecuteStream(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	resp, err := e.send(ctx, auth, req, opts)
	if err != nil {
		return nil, err
	}
	chunks := make(chan cliproxyexecutor.StreamChunk)
	go forwardSSEEvents(ctx, resp.Body, chunks)
	return &cliproxyexecutor.StreamResult{Headers: resp.Header.Clone(), Chunks: chunks}, nil
}

func (e *openaiExecutor) CountTokens(_ context.Context, _ *coreauth.Auth, _ cliproxyexecutor.Request, _ cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, &upstreamError{status: http.StatusBadRequest, message: "OpenAI API token counting is not supported by the broker", requestScoped: true}
}

func (e *openaiExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	return auth, nil
}

func (e *openaiExecutor) HttpRequest(ctx context.Context, auth *coreauth.Auth, req *http.Request) (*http.Response, error) {
	out := req.Clone(ctx)
	out.Header.Set("Authorization", "Bearer "+auth.Attributes[coreauth.AttributeAPIKey])
	out.Header.Del("X-Api-Key")
	return e.client.Do(out)
}

func (e *openaiExecutor) send(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*http.Response, error) {
	protocol := strings.ToLower(string(opts.SourceFormat))
	if protocol != protocolOpenAIResponses && protocol != protocolOpenAIChat {
		return nil, &upstreamError{status: http.StatusBadRequest, message: "OpenAI API keys accept Responses or Chat Completions requests only", requestScoped: true}
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(e.baseURL, "/")+upstreamPaths[protocol], bytes.NewReader(req.Payload))
	if err != nil {
		return nil, err
	}
	for name, values := range forwardHeaders(opts.Headers) {
		httpReq.Header[name] = values
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if opts.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	}
	resp, err := e.HttpRequest(ctx, auth, httpReq)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 300 {
		return resp, nil
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return nil, newUpstreamError(resp.StatusCode, resp.Header, body)
}

// listOpenAIModels validates a key and returns the model IDs exposed by its API project.
func listOpenAIModels(ctx context.Context, client *http.Client, baseURL, key string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
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
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err = json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("list models: %w", err)
	}
	models := make([]string, 0, len(page.Data))
	for _, model := range page.Data {
		if model.ID != "" {
			models = append(models, model.ID)
		}
	}
	return models, nil
}
