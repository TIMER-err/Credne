package broker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// StateFileName is the discovery file clients read to find a running broker.
const StateFileName = "broker.json"

// State is the discovery record of a running broker. It contains the per-run
// bearer token, so it is written with owner-only permissions next to the
// credential store and must be treated with the same care as credentials.
type State struct {
	// Schema is the discovery record format version.
	Schema int `json:"schema"`
	// PID is the broker process id.
	PID int `json:"pid"`
	// URL is the loopback base URL of the broker, without a trailing slash.
	URL string `json:"url"`
	// Token authenticates every IPC request. It is regenerated on every start.
	Token string `json:"token"`
	// BrokerVersion is the broker build version.
	BrokerVersion string `json:"brokerVersion"`
	// UpstreamVersion is the embedded CLIProxyAPI module version.
	UpstreamVersion string `json:"upstreamVersion"`
	// StartedAt is the broker start time.
	StartedAt time.Time `json:"startedAt"`
}

const stateSchema = 1

func statePath(home string) string { return filepath.Join(home, StateFileName) }

// writeState publishes the discovery record atomically so readers never see a
// partially written token.
func writeState(home string, state State) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(statePath(home), data)
}

// readState returns the current discovery record, if any.
func readState(home string) (State, error) {
	var state State
	data, err := os.ReadFile(statePath(home))
	if err != nil {
		return state, err
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("parse %s: %w", StateFileName, err)
	}
	return state, nil
}

// removeState deletes the discovery record only when it still belongs to this
// broker run, so a successor's record is never removed by a stopping broker.
func removeState(home string, state State) {
	current, err := readState(home)
	if err != nil || current.Token != state.Token {
		return
	}
	_ = os.Remove(statePath(home))
}
