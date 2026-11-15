package broker

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Reasoning continuity across accounts.
//
// Providers sign thinking blocks (Anthropic) and encrypt reasoning items
// (OpenAI) for the account that produced them. Inside a pool the harness does
// not know that CLIProxyAPI moved a conversation to another account, so it
// keeps replaying the previous account's reasoning, which the new account may
// reject. Before such a move, and after a rejection, the broker replaces each
// replayed reasoning item with a short labeled text summary and keeps the
// visible text, tool calls and tool results unchanged.

// ReasoningSummaryLabel prefixes the text that replaces replayed reasoning.
// The harness uses the same label when it changes models itself.
const ReasoningSummaryLabel = "[Reasoning summary from an earlier turn, not shown to the user]"

// maxReasoningSummaryRunes bounds one summary; providers already return
// summarized reasoning, this only caps raw reasoning from other sources.
const maxReasoningSummaryRunes = 1500

func reasoningSummaryText(reasoning string) string {
	text := strings.TrimSpace(reasoning)
	if runes := []rune(text); len(runes) > maxReasoningSummaryRunes {
		text = strings.TrimSpace(string(runes[:maxReasoningSummaryRunes])) + " …"
	}
	return ReasoningSummaryLabel + "\n" + text
}

// stripReasoning rewrites a request body so it carries no provider-signed
// reasoning. It reports whether anything changed.
func stripReasoning(protocol string, body []byte) ([]byte, bool) {
	var doc map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(&doc) != nil {
		return body, false
	}
	var changed bool
	switch protocol {
	case protocolClaude:
		changed = stripClaudeReasoning(doc)
	case protocolOpenAIResponses:
		changed = stripResponsesReasoning(doc)
	}
	if !changed {
		return body, false
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return body, false
	}
	return out, true
}

// stripClaudeReasoning replaces thinking blocks with summaries and drops
// redacted thinking. Anthropic requires the assistant turn that an in-flight
// tool result answers to start with its thinking block while thinking is on,
// so when that block is removed, thinking is disabled for this one request.
func stripClaudeReasoning(doc map[string]any) bool {
	messages, _ := doc["messages"].([]any)
	changed := false
	inFlightToolTurnStripped := false
	for index, raw := range messages {
		message, _ := raw.(map[string]any)
		if message["role"] != "assistant" {
			continue
		}
		content, ok := message["content"].([]any)
		if !ok {
			continue
		}
		kept := make([]any, 0, len(content))
		removed, hasToolUse := false, false
		for _, rawBlock := range content {
			block, _ := rawBlock.(map[string]any)
			switch block["type"] {
			case "thinking":
				removed = true
				if text, _ := block["thinking"].(string); strings.TrimSpace(text) != "" {
					kept = append(kept, map[string]any{"type": "text", "text": reasoningSummaryText(text)})
				}
			case "redacted_thinking":
				removed = true
			default:
				hasToolUse = hasToolUse || block["type"] == "tool_use"
				kept = append(kept, rawBlock)
			}
		}
		if !removed {
			continue
		}
		changed = true
		message["content"] = kept
		if hasToolUse && answersWithToolResult(messages, index) {
			inFlightToolTurnStripped = true
		}
	}
	if inFlightToolTurnStripped {
		if thinking, ok := doc["thinking"].(map[string]any); ok && thinking["type"] != "disabled" {
			doc["thinking"] = map[string]any{"type": "disabled"}
		}
	}
	return changed
}

// answersWithToolResult reports whether the message after index is the final
// message and carries tool results, i.e. the assistant turn is still running.
func answersWithToolResult(messages []any, index int) bool {
	if index+2 != len(messages) {
		return false
	}
	next, _ := messages[index+1].(map[string]any)
	content, _ := next["content"].([]any)
	for _, rawBlock := range content {
		if block, _ := rawBlock.(map[string]any); block["type"] == "tool_result" {
			return true
		}
	}
	return false
}

// stripResponsesReasoning replaces reasoning input items with an assistant
// message holding their readable summary, or removes them when they have none.
func stripResponsesReasoning(doc map[string]any) bool {
	input, ok := doc["input"].([]any)
	if !ok {
		return false
	}
	kept := make([]any, 0, len(input))
	changed := false
	for _, raw := range input {
		item, _ := raw.(map[string]any)
		if item["type"] != "reasoning" {
			kept = append(kept, raw)
			continue
		}
		changed = true
		var parts []string
		summaries, _ := item["summary"].([]any)
		for _, rawSummary := range summaries {
			summary, _ := rawSummary.(map[string]any)
			if text, _ := summary["text"].(string); strings.TrimSpace(text) != "" {
				parts = append(parts, strings.TrimSpace(text))
			}
		}
		if len(parts) == 0 {
			continue
		}
		kept = append(kept, map[string]any{
			"type":    "message",
			"role":    "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": reasoningSummaryText(strings.Join(parts, "\n\n"))}},
		})
	}
	if changed {
		doc["input"] = kept
	}
	return changed
}

// isReasoningRejection recognizes upstream errors caused by replaying
// reasoning another account produced.
func isReasoningRejection(status int, message string) bool {
	if status != http.StatusBadRequest {
		return false
	}
	lower := strings.ToLower(message)
	return strings.Contains(lower, "invalid_encrypted_content") ||
		strings.Contains(lower, "encrypted content") ||
		strings.Contains(lower, "thinking_signature_invalid") ||
		(strings.Contains(lower, "signature") && strings.Contains(lower, "thinking"))
}

// poolSessions remembers which account last served each pool conversation, so
// the broker can tell that the next request will move to another account.
type poolSessions struct {
	mu       sync.Mutex
	accounts map[string]string
}

// maxPoolSessions bounds memory; forgetting a session only costs one
// reactive retry if its next request moves accounts.
const maxPoolSessions = 10_000

func newPoolSessions() *poolSessions { return &poolSessions{accounts: map[string]string{}} }

func (p *poolSessions) get(key string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.accounts[key]
}

func (p *poolSessions) set(key, authID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.accounts) >= maxPoolSessions {
		p.accounts = map[string]string{}
	}
	p.accounts[key] = authID
}

// sessionKey identifies a conversation from the session headers the harness
// sends (Anthropic: X-Session-Affinity, Responses: Session-Id).
func sessionKey(target string, header http.Header) string {
	for _, name := range []string{"X-Session-Affinity", "Session-Id", "X-Session-Id"} {
		if value := strings.TrimSpace(header.Get(name)); value != "" {
			return target + "\x00" + value
		}
	}
	return ""
}

// selectable reports whether CLIProxyAPI could pick the account right now.
func selectable(auth *coreauth.Auth, now time.Time) bool {
	return auth != nil && !auth.Disabled && !auth.Unavailable && !auth.Quota.Exceeded &&
		!auth.NextRetryAfter.After(now) && !auth.Quota.NextRecoverAt.After(now)
}
