package broker

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Anthropic's official `ant` CLI owns API-credit logins: `ant auth login`
// signs in to the Claude Console in the browser, and `ant auth print-
// credentials` returns a current access token, refreshing it when needed.
// The broker keeps ant's state in <home>/ant (ANTHROPIC_CONFIG_DIR), separate
// from any ant profiles the user has, and downloads a pinned release on first
// use when ant is not provided.

const antVersion = "2.9.0"

// antChecksums pins the SHA-256 of each release archive, from
// ant_2.9.0_checksums.txt, so a download is verified against values compiled
// into the broker rather than values fetched next to the archive.
var antChecksums = map[string]string{
	"ant_2.9.0_linux_386.tar.gz":   "7569d39f60c439fad899ea00bc69ddbda2de2c04f7080421606a9476538ed927",
	"ant_2.9.0_linux_amd64.tar.gz": "69158f6a17e92e8e559e0061bea2530ac5b60976fb6d697673136d110ebe351f",
	"ant_2.9.0_linux_arm64.tar.gz": "2bbccb2861c647cbad708d83921dfc3e0689233fc0f50be4745df3e973166cc9",
	"ant_2.9.0_linux_armv6.tar.gz": "f52b7fc3e1be516c25c544488e51af69b97fffb749f2db3e7152479f14f43682",
	"ant_2.9.0_macos_amd64.zip":    "45039f3cffc029cdcbacd3ec073f355df035fdb6988c4b0d9bcac0aad602ba35",
	"ant_2.9.0_macos_arm64.zip":    "316aedd862136b53545997ec4f30add182783873e86c6479dcde6e34bc2702a3",
	"ant_2.9.0_windows_386.zip":    "ab323257e0287e874458b5ccd5aef0c4a9d92fcd02c687559503589d94211f49",
	"ant_2.9.0_windows_amd64.zip":  "6ff884fd3b1aa60558cd6536271548c27c7617b857cef93adc6dc113097f3b0c",
	"ant_2.9.0_windows_arm64.zip":  "12ea50f67c888a7afbcb98ffe61405a7ba2ab0c6f81ad27c82e2694d6265843d",
}

const antReleaseURL = "https://github.com/anthropics/anthropic-cli/releases/download/v" + antVersion + "/"

// antTokenSkew refreshes a cached token this long before it expires.
const antTokenSkew = 3 * time.Minute

type antTool struct {
	home        string
	downloadURL string
	client      *http.Client

	installMu sync.Mutex
	path      string

	tokenMu sync.Mutex
	tokens  map[string]antToken
	locks   map[string]*sync.Mutex
}

type antToken struct {
	value   string
	expires time.Time
}

// antCredentials is the subset of `ant auth print-credentials` the broker reads.
type antCredentials struct {
	AccessToken      string `json:"access_token"`
	ExpiresAt        *int64 `json:"expires_at"`
	AccountEmail     string `json:"account_email"`
	OrganizationName string `json:"organization_name"`
	// OrganizationUUID identifies the Console organization; two profiles that
	// share it bill the same credits.
	OrganizationUUID string `json:"organization_uuid"`
	WorkspaceName    string `json:"workspace_name"`
}

func newAntTool(home string) *antTool {
	return &antTool{
		home:        home,
		downloadURL: antReleaseURL,
		client:      &http.Client{Timeout: 5 * time.Minute},
		tokens:      map[string]antToken{},
		locks:       map[string]*sync.Mutex{},
	}
}

func (a *antTool) configDir() string { return filepath.Join(a.home, "ant") }

func antBinaryName() string {
	if runtime.GOOS == "windows" {
		return "ant.exe"
	}
	return "ant"
}

// executable returns the ant binary: CREDNE_ANT, then <home>/bin/ant, then a
// verified download of the pinned release into <home>/bin.
func (a *antTool) executable(ctx context.Context) (string, error) {
	if configured := os.Getenv("CREDNE_ANT"); configured != "" {
		return configured, nil
	}
	a.installMu.Lock()
	defer a.installMu.Unlock()
	if a.path != "" {
		return a.path, nil
	}
	target := filepath.Join(a.home, "bin", antBinaryName())
	if _, err := os.Stat(target); err == nil {
		a.path = target
		return target, nil
	}
	if err := a.install(ctx, target); err != nil {
		return "", fmt.Errorf("install ant %s: %w", antVersion, err)
	}
	a.path = target
	return target, nil
}

func antAsset() (string, error) {
	osName := runtime.GOOS
	if osName == "darwin" {
		osName = "macos"
	}
	arch := runtime.GOARCH
	if arch == "arm" {
		arch = "armv6"
	}
	ext := ".zip"
	if osName == "linux" {
		ext = ".tar.gz"
	}
	name := fmt.Sprintf("ant_%s_%s_%s%s", antVersion, osName, arch, ext)
	if _, ok := antChecksums[name]; !ok {
		return "", fmt.Errorf("no ant release for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return name, nil
}

func (a *antTool) install(ctx context.Context, target string) error {
	asset, err := antAsset()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.downloadURL+asset, nil)
	if err != nil {
		return err
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", asset, resp.StatusCode)
	}
	archive, err := io.ReadAll(io.LimitReader(resp.Body, 128<<20))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(archive)
	if hex.EncodeToString(sum[:]) != antChecksums[asset] {
		return fmt.Errorf("checksum mismatch for %s", asset)
	}
	binary, err := extractAnt(asset, archive)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	tmp := target + ".tmp"
	if err = os.WriteFile(tmp, binary, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func extractAnt(asset string, archive []byte) ([]byte, error) {
	want := antBinaryName()
	if strings.HasSuffix(asset, ".zip") {
		reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, file := range reader.File {
			if filepath.Base(file.Name) != want || file.FileInfo().IsDir() {
				continue
			}
			rc, err := file.Open()
			if err != nil {
				return nil, err
			}
			defer func() { _ = rc.Close() }()
			return io.ReadAll(io.LimitReader(rc, 256<<20))
		}
		return nil, fmt.Errorf("%s not found in %s", want, asset)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err != nil {
			return nil, fmt.Errorf("%s not found in %s: %w", want, asset, err)
		}
		if header.Typeflag == tar.TypeReg && filepath.Base(header.Name) == want {
			return io.ReadAll(io.LimitReader(tr, 256<<20))
		}
	}
}

func (a *antTool) command(ctx context.Context, args ...string) (*exec.Cmd, error) {
	path, err := a.executable(ctx)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), "ANTHROPIC_CONFIG_DIR="+a.configDir())
	// An inherited API key or auth token would take precedence over the profile.
	cmd.Env = append(cmd.Env, "ANTHROPIC_API_KEY=", "ANTHROPIC_AUTH_TOKEN=")
	return cmd, nil
}

// credentials runs `ant auth print-credentials`, which refreshes the access
// token when it is near expiry.
func (a *antTool) credentials(ctx context.Context, profile string) (antCredentials, error) {
	cmd, err := a.command(ctx, "auth", "print-credentials", "--profile", profile)
	if err != nil {
		return antCredentials{}, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return antCredentials{}, fmt.Errorf("ant auth print-credentials: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	var creds antCredentials
	if err = json.Unmarshal(out, &creds); err != nil || creds.AccessToken == "" {
		return antCredentials{}, errors.New("ant returned no access token; sign in again")
	}
	return creds, nil
}

// token returns a cached access token, asking ant for a new one when it is
// close to expiry. Calls for one profile are serialized because ant rotates
// the refresh token.
func (a *antTool) token(ctx context.Context, profile string) (string, error) {
	a.tokenMu.Lock()
	lock := a.locks[profile]
	if lock == nil {
		lock = &sync.Mutex{}
		a.locks[profile] = lock
	}
	a.tokenMu.Unlock()
	lock.Lock()
	defer lock.Unlock()

	a.tokenMu.Lock()
	cached := a.tokens[profile]
	a.tokenMu.Unlock()
	if cached.value != "" && time.Until(cached.expires) > antTokenSkew {
		return cached.value, nil
	}
	creds, err := a.credentials(ctx, profile)
	if err != nil {
		return "", err
	}
	expires := time.Now().Add(10 * time.Minute)
	if creds.ExpiresAt != nil {
		expires = time.Unix(*creds.ExpiresAt, 0)
	}
	a.tokenMu.Lock()
	a.tokens[profile] = antToken{value: creds.AccessToken, expires: expires}
	a.tokenMu.Unlock()
	return creds.AccessToken, nil
}

func (a *antTool) forget(profile string) {
	a.tokenMu.Lock()
	delete(a.tokens, profile)
	a.tokenMu.Unlock()
}

// logout revokes and removes a profile's credentials.
func (a *antTool) logout(ctx context.Context, profile string) error {
	a.forget(profile)
	cmd, err := a.command(ctx, "auth", "logout", "--profile", profile)
	if err != nil {
		return err
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ant auth logout: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// antLogin is a running `ant auth login`. ant binds a local callback port,
// prints the authorize URL and exits once the browser redirect arrives.
type antLogin struct {
	profile string
	url     string
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	done    chan struct{}
	err     error
	output  bytes.Buffer
	mu      sync.Mutex
}

// startLogin launches ant in callback mode without opening a browser (the
// harness opens it) and waits until ant has printed the authorize URL.
func (a *antTool) startLogin(ctx context.Context, profile string) (*antLogin, error) {
	loginCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	cmd, err := a.command(loginCtx, "auth", "login", "--profile", profile, "--no-browser", "--callback-port", "0", "--timeout", "10m")
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Stdout = io.Discard
	if err = cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	login := &antLogin{profile: profile, cmd: cmd, cancel: cancel, done: make(chan struct{})}
	urlFound := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			login.mu.Lock()
			login.output.WriteString(line + "\n")
			login.mu.Unlock()
			if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "https://") {
				select {
				case urlFound <- trimmed:
				default:
				}
			}
		}
	}()
	go func() {
		err := cmd.Wait()
		login.mu.Lock()
		if err != nil {
			login.err = fmt.Errorf("ant auth login: %v: %s", err, lastLines(login.output.String(), 3))
		}
		login.mu.Unlock()
		cancel()
		close(login.done)
	}()
	select {
	case login.url = <-urlFound:
		return login, nil
	case <-login.done:
		return nil, login.result()
	case <-ctx.Done():
		login.stop()
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		login.stop()
		return nil, errors.New("ant did not print an authorize URL")
	}
}

func (l *antLogin) finished() bool {
	select {
	case <-l.done:
		return true
	default:
		return false
	}
}

func (l *antLogin) result() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.err == nil && l.finished() && l.cmd.ProcessState != nil && !l.cmd.ProcessState.Success() {
		return errors.New("ant auth login failed")
	}
	return l.err
}

func (l *antLogin) stop() {
	l.cancel()
	<-l.done
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " / ")
}
