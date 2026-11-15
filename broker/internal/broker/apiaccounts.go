package broker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// Broker-managed official-API accounts: OpenAI and Anthropic API keys and API-credit
// logins. They live in <home>/api-accounts.json (owner-only) and are
// registered with CLIProxyAPI as runtime-only auths, so CLIProxyAPI pools and
// cools them like any account but never writes their secrets to its store.

const (
	kindAPICredits = "api-credits"
	// attrKind marks broker-managed accounts and their kind.
	attrKind       = "credne_kind"
	attrAntProfile = "ant_profile"
)

// APICreditsLoginProvider starts an API-credit login through `ant`.
const APICreditsLoginProvider = "claude-api-credits"

type apiAccount struct {
	ID           string `json:"id"`
	Provider     string `json:"provider,omitempty"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	APIKey       string `json:"apiKey,omitempty"`
	Profile      string `json:"profile,omitempty"`
	Email        string `json:"email,omitempty"`
	Organization string `json:"organization,omitempty"`
	// OrganizationUUID identifies the Claude Console organization of an
	// API-credits account. Accounts stored before it was recorded have none.
	OrganizationUUID string    `json:"organizationUuid,omitempty"`
	Disabled         bool      `json:"disabled,omitempty"`
	Models           []string  `json:"models,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
}

type apiAccountFile struct {
	Version  int          `json:"version"`
	Accounts []apiAccount `json:"accounts"`
}

type apiAccounts struct {
	path          string
	baseURL       string
	openAIBaseURL string
	client        *http.Client
	ant           *antTool
	manager       *coreauth.Manager

	mu       sync.Mutex
	accounts map[string]apiAccount
	logins   map[string]*pendingCreditsLogin
}

type pendingCreditsLogin struct {
	name string
	// login is nil between reserving the name and ant printing its URL.
	login *antLogin
	// account is set once the login completed and the account was registered.
	account *apiAccount
	err     error
}

func newAPIAccounts(home, baseURL string, ant *antTool) *apiAccounts {
	return &apiAccounts{
		path:          filepath.Join(home, "api-accounts.json"),
		baseURL:       baseURL,
		openAIBaseURL: openAIDefaultBaseURL,
		client:        &http.Client{Timeout: 30 * time.Second},
		ant:           ant,
		accounts:      map[string]apiAccount{},
		logins:        map[string]*pendingCreditsLogin{},
	}
}

// executor builds the official-API executor backed by these accounts.
func (m *apiAccounts) executor() *anthropicExecutor {
	return &anthropicExecutor{baseURL: m.baseURL, client: &http.Client{}, creds: m}
}

// load reads the store and registers every account with CLIProxyAPI. Model
// lists come from the store and are refreshed in the background.
func (m *apiAccounts) load(ctx context.Context, manager *coreauth.Manager) error {
	m.manager = manager
	data, err := os.ReadFile(m.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var file apiAccountFile
	if err = json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("parse %s: %w", m.path, err)
	}
	for _, account := range file.Accounts {
		m.accounts[account.ID] = account
		if err = m.register(ctx, account); err != nil {
			log.Warnf("register account %s: %v", account.ID, err)
		}
	}
	go m.refreshModels(context.Background())
	return nil
}

func (m *apiAccounts) save() error {
	file := apiAccountFile{Version: 1}
	for _, account := range m.accounts {
		file.Accounts = append(file.Accounts, account)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(m.path, data)
}

func (m *apiAccounts) register(ctx context.Context, account apiAccount) error {
	provider, owner, family := APIProviderKey, "anthropic", "claude"
	if account.Provider == OpenAIAPIProviderKey {
		provider, owner, family = OpenAIAPIProviderKey, "openai", "openai"
	}
	attributes := map[string]string{
		coreauth.AttributeRuntimeOnly: "true",
		coreauth.AttributeAuthKind:    coreauth.AuthKindAPIKey,
		attrKind:                      account.Kind,
	}
	if account.Kind == kindAPIKey {
		attributes[coreauth.AttributeAPIKey] = account.APIKey
	} else {
		attributes[attrAntProfile] = account.Profile
	}
	if account.Email != "" {
		attributes["email"] = account.Email
	}
	status := coreauth.StatusActive
	if account.Disabled {
		status = coreauth.StatusDisabled
	}
	auth := &coreauth.Auth{
		ID:         account.ID,
		Provider:   provider,
		Label:      account.Name,
		Status:     status,
		Disabled:   account.Disabled,
		Attributes: attributes,
		CreatedAt:  account.CreatedAt,
		UpdatedAt:  time.Now(),
	}
	if _, exists := m.manager.GetByID(account.ID); exists {
		if _, err := m.manager.Update(coreauth.WithSkipPersist(ctx), auth); err != nil {
			return err
		}
	} else if _, err := m.manager.Register(coreauth.WithSkipPersist(ctx), auth); err != nil {
		return err
	}
	models := make([]*cliproxy.ModelInfo, 0, len(account.Models))
	for _, id := range account.Models {
		models = append(models, &cliproxy.ModelInfo{ID: id, Object: "model", OwnedBy: owner, Type: family})
	}
	cliproxy.GlobalModelRegistry().RegisterClient(account.ID, provider, models)
	return nil
}

// credential implements credentialResolver for the executor.
func (m *apiAccounts) credential(ctx context.Context, auth *coreauth.Auth) (anthropicCredential, error) {
	switch auth.Attributes[attrKind] {
	case kindAPIKey:
		return anthropicCredential{apiKey: auth.Attributes[coreauth.AttributeAPIKey]}, nil
	case kindAPICredits:
		token, err := m.ant.token(ctx, auth.Attributes[attrAntProfile])
		if err != nil {
			return anthropicCredential{}, err
		}
		return anthropicCredential{bearerToken: token}, nil
	}
	return anthropicCredential{}, fmt.Errorf("account %s has no official-API credential", auth.ID)
}

func (m *apiAccounts) invalidate(auth *coreauth.Auth) {
	if profile := auth.Attributes[attrAntProfile]; profile != "" {
		m.ant.forget(profile)
	}
}

// fetchModels lists the models of a credential and stores their ids.
func (m *apiAccounts) fetchModels(ctx context.Context, account *apiAccount) error {
	if account.Provider == OpenAIAPIProviderKey {
		models, err := listOpenAIModels(ctx, m.client, m.openAIBaseURL, account.APIKey)
		if err == nil {
			account.Models = models
		}
		return err
	}
	credential := anthropicCredential{apiKey: account.APIKey}
	if account.Kind == kindAPICredits {
		token, err := m.ant.token(ctx, account.Profile)
		if err != nil {
			return err
		}
		credential = anthropicCredential{bearerToken: token}
	}
	models, err := listAnthropicModels(ctx, m.client, m.baseURL, credential)
	if err != nil {
		return err
	}
	account.Models = account.Models[:0]
	for _, model := range models {
		account.Models = append(account.Models, model.ID)
	}
	return nil
}

func (m *apiAccounts) refreshModels(ctx context.Context) {
	m.mu.Lock()
	accounts := make([]apiAccount, 0, len(m.accounts))
	for _, account := range m.accounts {
		accounts = append(accounts, account)
	}
	m.mu.Unlock()
	for _, account := range accounts {
		if account.Disabled {
			continue
		}
		if err := m.fetchModels(ctx, &account); err != nil {
			log.Warnf("refresh models of %s: %v", account.ID, err)
			continue
		}
		m.mu.Lock()
		if _, ok := m.accounts[account.ID]; ok {
			m.accounts[account.ID] = account
			_ = m.save()
			_ = m.register(ctx, account)
		}
		m.mu.Unlock()
	}
}

// duplicateAccountError reports an account that is already added. Its text is
// written for users and shown as-is; handlers answer it with 409.
type duplicateAccountError struct{ message string }

func (e *duplicateAccountError) Error() string { return e.message }

func duplicateAccount(format string, args ...any) error {
	return &duplicateAccountError{message: fmt.Sprintf(format, args...)}
}

func isDuplicateAccount(err error) bool {
	var duplicate *duplicateAccountError
	return errors.As(err, &duplicate)
}

func duplicateKey(label string) error {
	return duplicateAccount("This API key is already added as %s.", label)
}

func duplicateOrganization(organization, existingName string) error {
	subject := "This Claude Console organization"
	if organization != "" {
		subject += " (" + organization + ")"
	}
	return duplicateAccount("%s is already added as %s.", subject, existingName)
}

func accountKindLabel(kind string) string {
	if kind == kindAPICredits {
		return "API credits"
	}
	return "API key"
}

func creditsAccountID(name string) string { return "claude-api-credits-" + name }

// duplicateOf reports why account cannot be stored next to the stored
// accounts: the same id (the user's name for it), the same API key, or the same
// Console organization. Callers hold m.mu.
func (m *apiAccounts) duplicateOf(account apiAccount) error {
	if _, taken := m.accounts[account.ID]; taken {
		return duplicateAccount("An %s account named %s already exists.", accountKindLabel(account.Kind), account.Name)
	}
	for _, existing := range m.accounts {
		if account.APIKey != "" && existing.APIKey == account.APIKey {
			return duplicateKey(existing.Name)
		}
		if account.OrganizationUUID != "" && existing.OrganizationUUID == account.OrganizationUUID {
			return duplicateOrganization(account.Organization, existing.Name)
		}
	}
	return nil
}

// checkDuplicate is the fail-fast form of the check add repeats under its lock.
func (m *apiAccounts) checkDuplicate(account apiAccount) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.duplicateOf(account)
}

// add validates an account by listing its models, then stores and registers
// it. A duplicate is refused with a *duplicateAccountError and never replaces
// the stored account. The check runs under the lock, after the slow network
// call, so two concurrent adds cannot both pass it.
func (m *apiAccounts) add(ctx context.Context, account apiAccount) (apiAccount, error) {
	if err := m.fetchModels(ctx, &account); err != nil {
		return apiAccount{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.duplicateOf(account); err != nil {
		return apiAccount{}, err
	}
	m.accounts[account.ID] = account
	if err := m.save(); err != nil {
		// An unsaved account must not stay and block the retry as a duplicate.
		delete(m.accounts, account.ID)
		return apiAccount{}, err
	}
	return account, m.register(ctx, account)
}

func (m *apiAccounts) get(id string) (apiAccount, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	account, ok := m.accounts[id]
	return account, ok
}

func (m *apiAccounts) setDisabled(ctx context.Context, id string, disabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	account, ok := m.accounts[id]
	if !ok {
		return errors.New("account not found")
	}
	account.Disabled = disabled
	m.accounts[id] = account
	if err := m.save(); err != nil {
		return err
	}
	return m.register(ctx, account)
}

func (m *apiAccounts) remove(ctx context.Context, id string) error {
	m.mu.Lock()
	account, ok := m.accounts[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("account not found")
	}
	delete(m.accounts, id)
	err := m.save()
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.manager.Remove(ctx, id)
	cliproxy.GlobalModelRegistry().UnregisterClient(id)
	if account.Kind == kindAPICredits {
		m.discardProfile(ctx, account.Profile)
	}
	return nil
}

// discardProfile signs an ant profile out, which revokes and deletes its tokens.
func (m *apiAccounts) discardProfile(ctx context.Context, profile string) {
	if err := m.ant.logout(ctx, profile); err != nil {
		log.Warnf("ant logout %s: %v", profile, err)
	}
}

var accountNamePattern = regexp.MustCompile(`[^a-z0-9._-]+`)

// normalizeAccountName turns a user-chosen name into an id-safe token.
func normalizeAccountName(name string) (string, error) {
	normalized := strings.Trim(accountNamePattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-"), "-.")
	if normalized == "" || len(normalized) > 48 {
		return "", errors.New("account name must have 1-48 letters, digits, dots, dashes or underscores")
	}
	return normalized, nil
}

// addAPIKey handles POST /credne/v1/api-keys.
func (s *server) addAPIKey(c *gin.Context) {
	var in struct {
		Provider string `json:"provider"`
		Name     string `json:"name"`
		Key      string `json:"key"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.Key) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name and key are required"})
		return
	}
	provider := APIProviderKey
	switch strings.ToLower(strings.TrimSpace(in.Provider)) {
	case "", "claude", "anthropic":
	case "openai":
		provider = OpenAIAPIProviderKey
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "API keys are supported for Anthropic or OpenAI"})
		return
	}
	name, err := normalizeAccountName(in.Name)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	candidate := apiAccount{
		ID:        provider + "-key-" + name,
		Provider:  provider,
		Name:      name,
		Kind:      kindAPIKey,
		APIKey:    strings.TrimSpace(in.Key),
		CreatedAt: time.Now().UTC(),
	}
	if err = s.checkNewAPIKey(candidate); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	account, err := s.apiAccounts.add(c.Request.Context(), candidate)
	if isDuplicateAccount(err) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "key rejected: " + err.Error()})
		return
	}
	s.respondAccount(c, account.ID)
}

// checkNewAPIKey refuses a taken name or an already added key before the
// network validation. The auth manager also lists the config.yaml keys, which
// the broker store does not know. It only returns duplicate errors.
func (s *server) checkNewAPIKey(account apiAccount) error {
	if err := s.apiAccounts.checkDuplicate(account); err != nil {
		return err
	}
	for _, auth := range s.handler.AuthManager.List() {
		if auth.Attributes[coreauth.AttributeAPIKey] == account.APIKey {
			return duplicateKey(authLabel(auth))
		}
	}
	return nil
}

// authLabel is the name a user gave an account, or its id when it has none.
func authLabel(auth *coreauth.Auth) string {
	if auth.Label != "" {
		return auth.Label
	}
	return auth.ID
}

// startCreditsLogin starts `ant auth login` for an API-credit account.
func (s *server) startCreditsLogin(c *gin.Context, rawName string) {
	name, err := normalizeAccountName(rawName)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	state := "ant-" + randomHex(16)
	pending, err := s.apiAccounts.reserveCreditsLogin(state, name)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	login, err := s.apiAccounts.ant.startLogin(c.Request.Context(), "credne-"+name)
	if err != nil {
		s.apiAccounts.forgetCreditsLogin(state)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	s.apiAccounts.mu.Lock()
	pending.login = login
	s.apiAccounts.mu.Unlock()
	go s.apiAccounts.completeCreditsLogin(pending)
	c.JSON(http.StatusOK, gin.H{"state": state, "url": login.url, "flow": "browser"})
}

// reserveCreditsLogin claims name for a sign-in before ant runs. ant keeps one
// profile per name, so signing in under a taken name would overwrite the tokens
// of the existing account; refusing here also stops two sign-ins from racing on
// one profile. Only duplicate errors are returned.
func (m *apiAccounts) reserveCreditsLogin(state, name string) (*pendingCreditsLogin, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.duplicateOf(apiAccount{ID: creditsAccountID(name), Name: name, Kind: kindAPICredits}); err != nil {
		return nil, err
	}
	for _, other := range m.logins {
		if other.name == name && other.account == nil && other.err == nil {
			return nil, duplicateAccount("An API credits sign-in named %s is already in progress. Finish or cancel it first.", name)
		}
	}
	pending := &pendingCreditsLogin{name: name}
	m.logins[state] = pending
	return pending, nil
}

func (m *apiAccounts) forgetCreditsLogin(state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.logins, state)
}

// completeCreditsLogin waits for ant, then stores and registers the account.
func (m *apiAccounts) completeCreditsLogin(pending *pendingCreditsLogin) {
	<-pending.login.done
	account, err := m.finishCreditsLogin(pending)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		pending.err = err
		return
	}
	pending.account = &account
}

// finishCreditsLogin adds the account ant just signed in. When the Console
// organization is already added under another name, the new profile's tokens
// are discarded. The name was reserved at start, so the profile being signed
// out belongs to no stored account.
func (m *apiAccounts) finishCreditsLogin(pending *pendingCreditsLogin) (apiAccount, error) {
	if err := pending.login.result(); err != nil {
		return apiAccount{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	creds, err := m.ant.credentials(ctx, pending.login.profile)
	if err != nil {
		return apiAccount{}, err
	}
	account, err := m.add(ctx, apiAccount{
		ID:               creditsAccountID(pending.name),
		Name:             pending.name,
		Kind:             kindAPICredits,
		Profile:          pending.login.profile,
		Email:            creds.AccountEmail,
		Organization:     creds.OrganizationName,
		OrganizationUUID: creds.OrganizationUUID,
		CreatedAt:        time.Now().UTC(),
	})
	if isDuplicateAccount(err) {
		m.discardProfile(ctx, pending.login.profile)
	}
	return account, err
}

// creditsLogin returns the pending API-credit login for a state, if any.
func (m *apiAccounts) creditsLogin(state string) (*pendingCreditsLogin, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pending, ok := m.logins[state]
	return pending, ok
}

func (s *server) creditsLoginStatus(c *gin.Context, pending *pendingCreditsLogin) {
	s.apiAccounts.mu.Lock()
	account, err := pending.account, pending.err
	s.apiAccounts.mu.Unlock()
	switch {
	case err != nil:
		c.JSON(http.StatusOK, gin.H{"status": "error", "error": err.Error()})
	case account != nil:
		if auth, ok := s.handler.AuthManager.GetByID(account.ID); ok {
			c.JSON(http.StatusOK, gin.H{"status": "ok", "account": newAccountView(auth)})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	default:
		c.JSON(http.StatusOK, gin.H{"status": "wait"})
	}
}

// creditsLoginCallback forwards a pasted redirect URL to ant's local
// callback listener, for browsers that could not reach it themselves.
func (s *server) creditsLoginCallback(c *gin.Context, redirect string) {
	parsed, err := url.Parse(redirect)
	host := ""
	if err == nil {
		host = parsed.Hostname()
	}
	if err != nil || parsed.Scheme != "http" || (host != "localhost" && host != "127.0.0.1") || parsed.Path != "/callback" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "expected the http://localhost:<port>/callback?... URL from the browser"})
		return
	}
	resp, err := http.Get(parsed.String())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	_ = resp.Body.Close()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) cancelCreditsLogin(c *gin.Context, state string, pending *pendingCreditsLogin) {
	pending.login.stop()
	s.apiAccounts.forgetCreditsLogin(state)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) respondAccount(c *gin.Context, id string) {
	if auth, ok := s.handler.AuthManager.GetByID(id); ok {
		c.JSON(http.StatusOK, gin.H{"account": newAccountView(auth)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// writeFileAtomic writes owner-only data through a temporary file and rename.
func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	_ = tmp.Chmod(0o600)
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
