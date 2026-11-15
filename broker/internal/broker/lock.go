package broker

import (
	"errors"
	"os"
)

// ErrAlreadyRunning reports that another broker holds the home directory lock.
var ErrAlreadyRunning = errors.New("another broker is already running for this home directory")

// instanceLock is an exclusive OS file lock that keeps one broker per home
// directory. The OS releases it when the process exits, including on crashes.
type instanceLock struct {
	file *os.File
}

func acquireLock(path string) (*instanceLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = lockFile(f); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &instanceLock{file: f}, nil
}

func (l *instanceLock) release() {
	if l == nil || l.file == nil {
		return
	}
	_ = l.file.Close()
}
