// Command credne-broker runs the shared account broker: CLIProxyAPI's SDK
// embedded as a private loopback service for harness processes.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/neilhuang007/Credne/broker/internal/broker"
	log "github.com/sirupsen/logrus"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

func main() {
	home := flag.String("home", defaultHome(), "broker home: credentials, config.yaml and discovery file")
	idle := flag.Duration("idle-timeout", 30*time.Minute, "stop after this long without requests (0 disables)")
	maxConcurrent := flag.Int("max-concurrency-per-account", 0, "maximum in-flight requests per pinned account (0 = unlimited)")
	anthropicBaseURL := flag.String("anthropic-base-url", "", "official Anthropic API endpoint for API-key and API-credit accounts (default https://api.anthropic.com)")
	openAIBaseURL := flag.String("openai-base-url", "", "official OpenAI API endpoint for API keys (default https://api.openai.com)")
	debug := flag.Bool("debug", false, "enable debug logging (never logs tokens)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	gin.SetMode(gin.ReleaseMode)
	log.SetLevel(log.InfoLevel)
	if *debug {
		log.SetLevel(log.DebugLevel)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := broker.Run(ctx, broker.Options{
		Home:                    *home,
		IdleTimeout:             *idle,
		MaxConcurrentPerAccount: *maxConcurrent,
		Version:                 version,
		AnthropicBaseURL:        *anthropicBaseURL,
		OpenAIBaseURL:           *openAIBaseURL,
	})
	if errors.Is(err, broker.ErrAlreadyRunning) {
		fmt.Fprintln(os.Stderr, "credne-broker: already running for", *home)
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "credne-broker:", err)
		os.Exit(1)
	}
}

// defaultHome mirrors the harness agent directory: $PI_CODING_AGENT_DIR/accounts
// or ~/.pi/agent/accounts.
func defaultHome() string {
	if dir := os.Getenv("PI_CODING_AGENT_DIR"); dir != "" {
		return filepath.Join(dir, "accounts")
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "accounts"
	}
	return filepath.Join(userHome, ".pi", "agent", "accounts")
}
