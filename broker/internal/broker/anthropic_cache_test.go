package broker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type cacheTestTransport func(*http.Request) (*http.Response, error)

func (transport cacheTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

type cacheTestCredentials struct {
	value anthropicCredential
}

func (credentials cacheTestCredentials) credential(context.Context, *coreauth.Auth) (anthropicCredential, error) {
	return credentials.value, nil
}

func (credentials cacheTestCredentials) invalidate(*coreauth.Auth) {}

func TestAnthropicExecutorCacheOptions(t *testing.T) {
	for _, test := range []struct {
		name       string
		body       string
		credential anthropicCredential
	}{
		{"native body", `{"model":"claude-test","system":[{"type":"text","text":"worker","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"task"}]}`, anthropicCredential{apiKey: "test-key"}},
		{"explicit breakpoints", `{"prompt_cache_options":{"mode":"explicit"},"model":"claude-test","system":[{"type":"text","text":"worker","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"reference","cache_control":{"type":"ephemeral"}},{"type":"text","text":"task","cache_control":{"type":"ephemeral"}}]}]}`, anthropicCredential{apiKey: "test-key"}},
		{"caching disabled with API credits", `{"model":"claude-test","prompt_cache_options":{"mode":"explicit"},"system":[{"type":"text","text":"worker"}],"messages":[{"role":"user","content":"task"}]}`, anthropicCredential{bearerToken: "test-token"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var sent []byte
			executor := anthropicExecutor{
				baseURL: "https://provider.invalid",
				creds:   cacheTestCredentials{value: test.credential},
				client: &http.Client{Transport: cacheTestTransport(func(request *http.Request) (*http.Response, error) {
					var err error
					sent, err = io.ReadAll(request.Body)
					if err != nil {
						return nil, err
					}
					if request.Header.Get("X-Api-Key") != test.credential.apiKey {
						t.Error("API key header changed")
					}
					if test.credential.bearerToken != "" && request.Header.Get("Authorization") != "Bearer "+test.credential.bearerToken {
						t.Error("API credit credential changed")
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
				})},
			}
			response, err := executor.send(context.Background(), &coreauth.Auth{}, cliproxyexecutor.Request{Payload: []byte(test.body)}, cliproxyexecutor.Options{}, "/v1/messages")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = response.Body.Close() }()
			var original, upstream map[string]json.RawMessage
			if err = json.Unmarshal([]byte(test.body), &original); err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(sent, &upstream); err != nil {
				t.Fatal(err)
			}
			delete(original, "prompt_cache_options")
			if !reflect.DeepEqual(upstream, original) {
				t.Fatalf("native payload or cache breakpoints changed: got %s", sent)
			}
			if test.name == "native body" && string(sent) != test.body {
				t.Fatalf("request without proxy options changed: got %s", sent)
			}
		})
	}
}
