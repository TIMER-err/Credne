package broker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/httptransport"
)

const usageBodyLimit = 256 * 1024
const usageTimeout = 10 * time.Second

const claudeUsageURL = "https://api.anthropic.com/api/oauth/usage"
const codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

type quotaWindow struct {
	Label       string     `json:"label"`
	UsedPercent float64    `json:"usedPercent"`
	ResetAt     *time.Time `json:"resetAt,omitempty"`
}

type providerCredit struct {
	Label     string   `json:"label"`
	Amount    *float64 `json:"amount,omitempty"`
	Unit      string   `json:"unit"`
	Unlimited bool     `json:"unlimited,omitempty"`
}

type accountUsageView struct {
	Status  string           `json:"status"`
	Reason  string           `json:"reason,omitempty"`
	Windows []quotaWindow    `json:"windows"`
	Credits []providerCredit `json:"credits"`
}

func (s *server) accountUsage(c *gin.Context) {
	auth, ok := s.accountFromKey(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, fetchAccountUsage(c.Request.Context(), s.handler.AuthManager, auth))
}

func fetchAccountUsage(ctx context.Context, manager *coreauth.Manager, auth *coreauth.Auth) accountUsageView {
	view := accountUsageView{Status: "unsupported", Reason: "Live subscription usage is not supported for this account kind.", Windows: []quotaWindow{}, Credits: []providerCredit{}}
	if newAccountView(auth).Kind != kindOAuth {
		return view
	}
	var target string
	switch auth.Provider {
	case "claude":
		target = claudeUsageURL
	case "codex":
		target = codexUsageURL
	default:
		return view
	}
	ctx, cancel := context.WithTimeout(ctx, usageTimeout)
	defer cancel()
	ctx = httptransport.WithDecorator(ctx, func(next http.RoundTripper) http.RoundTripper {
		return usageTransport{next: next, target: target}
	})
	headers := http.Header{"Accept": {"application/json"}}
	if auth.Provider == "claude" {
		headers.Set("anthropic-beta", "oauth-2025-04-20")
	} else if accountID := metadataString(auth, "account_id"); accountID != "" {
		headers.Set("Chatgpt-Account-Id", accountID)
	}
	req, err := manager.NewHttpRequest(ctx, auth, http.MethodGet, target, nil, headers)
	if err != nil {
		return unavailableUsage("Could not prepare provider usage request.")
	}
	response, err := manager.HttpRequest(ctx, auth, req)
	if err != nil {
		return unavailableUsage("Provider usage request failed or timed out.")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return unavailableUsage(fmt.Sprintf("Provider usage returned HTTP %d.", response.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, usageBodyLimit+1))
	if err != nil || len(body) > usageBodyLimit {
		return unavailableUsage("Provider usage response could not be read or exceeded the size limit.")
	}
	if auth.Provider == "claude" {
		return normalizeClaudeUsage(body)
	}
	return normalizeCodexUsage(body)
}

type usageTransport struct {
	next   http.RoundTripper
	target string
}

func (transport usageTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Method != http.MethodGet || request.URL.String() != transport.target {
		return nil, errors.New("usage destination is not allowed")
	}
	response, err := transport.next.RoundTrip(request)
	if err == nil && response.StatusCode >= 300 && response.StatusCode < 400 {
		response.Header.Del("Location")
	}
	return response, err
}

func unavailableUsage(reason string) accountUsageView {
	return accountUsageView{Status: "unavailable", Reason: reason, Windows: []quotaWindow{}, Credits: []providerCredit{}}
}

func normalizeClaudeUsage(body []byte) accountUsageView {
	var data struct {
		FiveHour       *claudeQuota `json:"five_hour"`
		SevenDay       *claudeQuota `json:"seven_day"`
		SevenDaySonnet *claudeQuota `json:"seven_day_sonnet"`
		SevenDayOpus   *claudeQuota `json:"seven_day_opus"`
		SevenDayFable  *claudeQuota `json:"seven_day_fable"`
		ExtraUsage     *struct {
			Enabled      bool     `json:"is_enabled"`
			UsedCredits  *float64 `json:"used_credits"`
			MonthlyLimit *float64 `json:"monthly_limit"`
		} `json:"extra_usage"`
	}
	if json.Unmarshal(body, &data) != nil {
		return unavailableUsage("Provider returned invalid usage data.")
	}
	view := accountUsageView{Status: "available", Windows: []quotaWindow{}, Credits: []providerCredit{}}
	for _, entry := range []struct {
		label string
		quota *claudeQuota
	}{{"5-hour", data.FiveHour}, {"7-day", data.SevenDay}, {"7-day Sonnet", data.SevenDaySonnet}, {"7-day Opus", data.SevenDayOpus}, {"7-day Fable", data.SevenDayFable}} {
		if entry.quota == nil || !validPercent(entry.quota.Utilization) {
			continue
		}
		window := quotaWindow{Label: entry.label, UsedPercent: *entry.quota.Utilization}
		if reset, err := time.Parse(time.RFC3339Nano, entry.quota.ResetsAt); err == nil {
			window.ResetAt = &reset
		}
		view.Windows = append(view.Windows, window)
	}
	if extra := data.ExtraUsage; extra != nil && extra.Enabled {
		for _, credit := range []providerCredit{
			{Label: "Extra usage spent", Amount: extra.UsedCredits, Unit: "provider credit units"},
			{Label: "Extra usage monthly limit", Amount: extra.MonthlyLimit, Unit: "provider credit units"},
		} {
			if validAmount(credit.Amount) {
				view.Credits = append(view.Credits, credit)
			}
		}
	}
	return finishUsage(view)
}

type claudeQuota struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func normalizeCodexUsage(body []byte) accountUsageView {
	var data struct {
		RateLimit *struct {
			Primary   *codexQuota `json:"primary_window"`
			Secondary *codexQuota `json:"secondary_window"`
		} `json:"rate_limit"`
		Credits *struct {
			Balance   *json.Number `json:"balance"`
			Unlimited bool         `json:"unlimited"`
		} `json:"credits"`
	}
	if json.Unmarshal(body, &data) != nil {
		return unavailableUsage("Provider returned invalid usage data.")
	}
	view := accountUsageView{Status: "available", Windows: []quotaWindow{}, Credits: []providerCredit{}}
	if rate := data.RateLimit; rate != nil {
		for _, entry := range []struct {
			label string
			quota *codexQuota
		}{{"Primary", rate.Primary}, {"Secondary", rate.Secondary}} {
			if entry.quota == nil || !validPercent(entry.quota.UsedPercent) {
				continue
			}
			window := quotaWindow{Label: entry.label, UsedPercent: *entry.quota.UsedPercent}
			if seconds := entry.quota.LimitSeconds; seconds != nil && *seconds > 0 {
				// Name windows by length, as Claude's are ("5-hour", "7-day"), instead of "Primary (168h0m0s)".
				switch {
				case *seconds%86400 == 0:
					window.Label = fmt.Sprintf("%d-day", *seconds/86400)
				case *seconds%3600 == 0:
					window.Label = fmt.Sprintf("%d-hour", *seconds/3600)
				default:
					window.Label = fmt.Sprintf("%s (%s)", entry.label, (time.Duration(*seconds) * time.Second).String())
				}
			}
			if entry.quota.ResetAt != nil && *entry.quota.ResetAt > 0 {
				reset := time.Unix(*entry.quota.ResetAt, 0).UTC()
				window.ResetAt = &reset
			}
			view.Windows = append(view.Windows, window)
		}
	}
	if credit := data.Credits; credit != nil {
		normalized := providerCredit{Label: "Credit balance", Unit: "provider credits", Unlimited: credit.Unlimited}
		if credit.Balance != nil {
			if amount, err := credit.Balance.Float64(); err == nil && validAmount(&amount) {
				normalized.Amount = &amount
			}
		}
		if normalized.Unlimited || normalized.Amount != nil {
			view.Credits = append(view.Credits, normalized)
		}
	}
	return finishUsage(view)
}

type codexQuota struct {
	UsedPercent  *float64 `json:"used_percent"`
	ResetAt      *int64   `json:"reset_at"`
	LimitSeconds *int64   `json:"limit_window_seconds"`
}

func validPercent(value *float64) bool {
	return validAmount(value) && *value <= 100
}

func validAmount(value *float64) bool {
	return value != nil && !math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= 0
}

func finishUsage(view accountUsageView) accountUsageView {
	if len(view.Windows) == 0 && len(view.Credits) == 0 {
		return unavailableUsage("Provider did not report supported quota windows or credits.")
	}
	return view
}
