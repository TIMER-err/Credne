package broker

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func decode(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestStripClaudeReasoning(t *testing.T) {
	body := []byte(`{"model":"m","max_tokens":10,"thinking":{"type":"enabled","budget_tokens":1024},"messages":[
		{"role":"user","content":"a"},
		{"role":"assistant","content":[{"type":"thinking","thinking":"first plan","signature":"s1"},{"type":"redacted_thinking","data":"x"},{"type":"text","text":"done"}]},
		{"role":"user","content":"b"}]}`)
	out, changed := stripReasoning(protocolClaude, body)
	if !changed {
		t.Fatal("thinking was not stripped")
	}
	doc := decode(t, out)
	content := doc["messages"].([]any)[1].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content = %v", content)
	}
	summary := content[0].(map[string]any)
	if summary["type"] != "text" || !strings.HasPrefix(summary["text"].(string), ReasoningSummaryLabel) || !strings.Contains(summary["text"].(string), "first plan") {
		t.Fatalf("summary block = %v", summary)
	}
	if doc["thinking"].(map[string]any)["type"] != "enabled" {
		t.Fatal("thinking was disabled although no tool turn is in flight")
	}
	if _, again := stripReasoning(protocolClaude, out); again {
		t.Fatal("stripping is not idempotent")
	}
}

func TestStripClaudeReasoningDisablesThinkingForInFlightToolTurn(t *testing.T) {
	body := []byte(`{"model":"m","thinking":{"type":"adaptive"},"messages":[
		{"role":"user","content":"a"},
		{"role":"assistant","content":[{"type":"thinking","thinking":"plan","signature":"s"},{"type":"tool_use","id":"t1","name":"read","input":{}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}`)
	out, changed := stripReasoning(protocolClaude, body)
	if !changed || decode(t, out)["thinking"].(map[string]any)["type"] != "disabled" {
		t.Fatalf("thinking must be disabled when the in-flight tool turn loses its thinking block: %s", out)
	}
}

func TestStripResponsesReasoning(t *testing.T) {
	body := []byte(`{"model":"gpt","input":[
		{"role":"user","content":[{"type":"input_text","text":"a"}]},
		{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"checked the logs"}],"encrypted_content":"opaque"},
		{"type":"reasoning","id":"rs_2","summary":[],"encrypted_content":"opaque"},
		{"type":"function_call","call_id":"c1","name":"read","arguments":"{}"}]}`)
	out, changed := stripReasoning(protocolOpenAIResponses, body)
	if !changed {
		t.Fatal("reasoning was not stripped")
	}
	if strings.Contains(string(out), "encrypted_content") {
		t.Fatalf("encrypted reasoning survived: %s", out)
	}
	input := decode(t, out)["input"].([]any)
	if len(input) != 3 {
		t.Fatalf("input = %v", input)
	}
	message := input[1].(map[string]any)
	text := message["content"].([]any)[0].(map[string]any)["text"].(string)
	if message["role"] != "assistant" || !strings.Contains(text, "checked the logs") {
		t.Fatalf("summary message = %v", message)
	}
}

func TestReasoningRejection(t *testing.T) {
	for _, message := range []string{
		`{"error":{"message":"Invalid ` + "`signature`" + ` in ` + "`thinking`" + ` block"}}`,
		`{"error":{"code":"invalid_encrypted_content","message":"The encrypted content could not be verified."}}`,
	} {
		if !isReasoningRejection(http.StatusBadRequest, message) {
			t.Errorf("not recognized: %s", message)
		}
	}
	if isReasoningRejection(http.StatusBadRequest, "max_tokens too large") || isReasoningRejection(http.StatusTooManyRequests, "thinking signature") {
		t.Error("unrelated error recognized as a reasoning rejection")
	}
}

func TestSelectable(t *testing.T) {
	now := time.Now()
	if !selectable(&coreauth.Auth{}, now) {
		t.Fatal("healthy account not selectable")
	}
	for name, auth := range map[string]*coreauth.Auth{
		"disabled": {Disabled: true},
		"cooling":  {NextRetryAfter: now.Add(time.Minute)},
		"quota":    {Quota: coreauth.QuotaState{Exceeded: true}},
	} {
		if selectable(auth, now) {
			t.Errorf("%s account selectable", name)
		}
	}
}
