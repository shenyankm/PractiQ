package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/api"
)

// Package-level endpoints so tests can point them at httptest servers.
var (
	googleAuthURL      = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL     = "https://oauth2.googleapis.com/token"
	googleUserinfoURL  = "https://openidconnect.googleapis.com/v1/userinfo"
	googleTokeninfoURL = "https://oauth2.googleapis.com/tokeninfo"
)

var googleHTTPClient = &http.Client{Timeout: 10 * time.Second}

const googleStateCookieName = "google_oauth_state"

type GoogleClaims struct {
	Sub           string
	Email         string
	EmailVerified bool
}

type googleTokenRequest struct {
	IDToken string `json:"idToken"`
}

func googleClientID() string {
	return strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID"))
}

func googleRedirectURL() string {
	return strings.TrimRight(strings.TrimSpace(os.Getenv("APP_ORIGIN")), "/") + "/api/v1/auth/google/callback"
}

func googleAuthDisabled() *api.Error {
	return api.NewError(http.StatusNotFound, "GOOGLE_AUTH_DISABLED", "Google sign-in is not configured", nil)
}

func googleAuthFailed() *api.Error {
	return api.NewError(http.StatusUnauthorized, "GOOGLE_AUTH_FAILED", "Google sign-in failed", nil)
}

// GoogleStart begins the browser authorization-code flow.
func GoogleStart() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clientID := googleClientID()
		if clientID == "" {
			api.HandleError(w, r, googleAuthDisabled())
			return
		}
		state := NewUUID()
		http.SetCookie(w, &http.Cookie{
			Name:     googleStateCookieName,
			Value:    state,
			Path:     "/api/v1/auth/google",
			MaxAge:   600,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   os.Getenv("NODE_ENV") == "production",
		})
		params := url.Values{
			"client_id":     {clientID},
			"redirect_uri":  {googleRedirectURL()},
			"response_type": {"code"},
			"scope":         {"openid email profile"},
			"state":         {state},
		}
		http.Redirect(w, r, googleAuthURL+"?"+params.Encode(), http.StatusFound)
	})
}

// GoogleCallback finishes the browser flow: code exchange, userinfo, session cookie.
func GoogleCallback(deps HandlerDependencies) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clientID := googleClientID()
		if clientID == "" {
			api.HandleError(w, r, googleAuthDisabled())
			return
		}
		expireStateCookie(w)
		stateCookie, err := r.Cookie(googleStateCookieName)
		state := r.URL.Query().Get("state")
		if err != nil || state == "" || stateCookie.Value != state {
			api.HandleError(w, r, googleAuthFailed())
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			api.HandleError(w, r, googleAuthFailed())
			return
		}
		claims, err := exchangeGoogleCode(r.Context(), clientID, code)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		user, err := deps.GoogleUser(r.Context(), claims)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := deps.SetSession(w, user.ID); err != nil {
			api.HandleError(w, r, err)
			return
		}
		target := strings.TrimSpace(os.Getenv("APP_ORIGIN"))
		if target == "" {
			target = "/"
		}
		http.Redirect(w, r, target, http.StatusFound)
	})
}

// GoogleToken authenticates mobile clients that obtained a Google ID token natively.
func GoogleToken(deps HandlerDependencies) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if googleClientID() == "" {
			api.HandleError(w, r, googleAuthDisabled())
			return
		}
		var body googleTokenRequest
		if err := decodeAuthRequest(w, r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if strings.TrimSpace(body.IDToken) == "" {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{{Field: "idToken", Message: "is required"}}))
			return
		}
		if err := rateLimitAuth(r, ""); err != nil {
			api.HandleError(w, r, err)
			return
		}
		claims, err := verifyGoogleIDToken(r.Context(), body.IDToken)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		user, err := deps.GoogleUser(r.Context(), claims)
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := deps.SetSession(w, user.ID); err != nil {
			api.HandleError(w, r, err)
			return
		}
		api.OK(w, r, issuedSessionResponse(w, user), nil)
	})
}

func expireStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     googleStateCookieName,
		Value:    "",
		Path:     "/api/v1/auth/google",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func exchangeGoogleCode(ctx context.Context, clientID string, code string) (GoogleClaims, error) {
	form := url.Values{
		"code":          {code},
		"client_id":     {clientID},
		"client_secret": {os.Getenv("GOOGLE_CLIENT_SECRET")},
		"redirect_uri":  {googleRedirectURL()},
		"grant_type":    {"authorization_code"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return GoogleClaims{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := googleHTTPClient.Do(req)
	if err != nil {
		return GoogleClaims{}, googleAuthFailed()
	}
	defer resp.Body.Close()
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&token) != nil || token.AccessToken == "" {
		return GoogleClaims{}, googleAuthFailed()
	}

	userinfoReq, err := http.NewRequestWithContext(ctx, http.MethodGet, googleUserinfoURL, nil)
	if err != nil {
		return GoogleClaims{}, err
	}
	userinfoReq.Header.Set("Authorization", "Bearer "+token.AccessToken)
	userinfoResp, err := googleHTTPClient.Do(userinfoReq)
	if err != nil {
		return GoogleClaims{}, googleAuthFailed()
	}
	defer userinfoResp.Body.Close()
	var userinfo struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
	}
	if userinfoResp.StatusCode != http.StatusOK || json.NewDecoder(userinfoResp.Body).Decode(&userinfo) != nil || userinfo.Sub == "" {
		return GoogleClaims{}, googleAuthFailed()
	}
	return GoogleClaims{Sub: userinfo.Sub, Email: userinfo.Email, EmailVerified: userinfo.EmailVerified}, nil
}

// verifyGoogleIDToken lets Google's tokeninfo endpoint validate the signature.
// ponytail: one remote call per login; switch to local JWKS verification if volume matters.
func verifyGoogleIDToken(ctx context.Context, idToken string) (GoogleClaims, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, googleTokeninfoURL+"?id_token="+url.QueryEscape(idToken), nil)
	if err != nil {
		return GoogleClaims{}, err
	}
	resp, err := googleHTTPClient.Do(req)
	if err != nil {
		return GoogleClaims{}, googleAuthFailed()
	}
	defer resp.Body.Close()
	var info struct {
		Aud           string `json:"aud"`
		Iss           string `json:"iss"`
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified string `json:"email_verified"`
		Exp           string `json:"exp"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&info) != nil {
		return GoogleClaims{}, googleAuthFailed()
	}
	if info.Sub == "" || (info.Iss != "accounts.google.com" && info.Iss != "https://accounts.google.com") {
		return GoogleClaims{}, googleAuthFailed()
	}
	if !googleAudienceAllowed(info.Aud) {
		return GoogleClaims{}, googleAuthFailed()
	}
	if exp, err := strconv.ParseInt(info.Exp, 10, 64); err != nil || !time.Unix(exp, 0).After(time.Now()) {
		return GoogleClaims{}, googleAuthFailed()
	}
	return GoogleClaims{Sub: info.Sub, Email: info.Email, EmailVerified: info.EmailVerified == "true"}, nil
}

func googleAudienceAllowed(aud string) bool {
	if aud == "" {
		return false
	}
	if aud == googleClientID() {
		return true
	}
	for _, allowed := range strings.Split(os.Getenv("GOOGLE_MOBILE_CLIENT_IDS"), ",") {
		if trimmed := strings.TrimSpace(allowed); trimmed != "" && trimmed == aud {
			return true
		}
	}
	return false
}

// FindOrCreateGoogleUser resolves the account for verified Google claims:
// match by google_sub, else link by verified email, else create a new user.
func FindOrCreateGoogleUser(ctx context.Context, pool *pgxpool.Pool, claims GoogleClaims) (*User, error) {
	user, err := findOrCreateGoogleUserOnce(ctx, pool, claims)
	if isUniqueViolation(err) {
		// Retry once: covers a concurrent first login and username-suffix collisions.
		user, err = findOrCreateGoogleUserOnce(ctx, pool, claims)
	}
	return user, err
}

func findOrCreateGoogleUserOnce(ctx context.Context, pool *pgxpool.Pool, claims GoogleClaims) (*User, error) {
	if claims.Sub == "" {
		return nil, googleAuthFailed()
	}
	row := pool.QueryRow(ctx, `
		SELECT id, username, email, is_active, role, membership
		FROM users
		WHERE google_sub = $1
		LIMIT 1
	`, claims.Sub)
	user, err := scanUser(row)
	if err != nil {
		return nil, err
	}
	if user == nil && claims.Email != "" && claims.EmailVerified {
		row = pool.QueryRow(ctx, `
			UPDATE users
			SET google_sub = $1
			WHERE lower(email) = lower($2) AND google_sub IS NULL
			RETURNING id, username, email, is_active, role, membership
		`, claims.Sub, claims.Email)
		user, err = scanUser(row)
		if err != nil {
			return nil, err
		}
		if user != nil {
			invalidateUserCache(ctx, user.ID)
		}
	}
	if user == nil {
		if claims.Email == "" || !claims.EmailVerified {
			return nil, api.NewError(http.StatusForbidden, "GOOGLE_EMAIL_UNVERIFIED", "Google account email must be verified", nil)
		}
		row = pool.QueryRow(ctx, `
			INSERT INTO users (username, email, google_sub, role, membership)
			VALUES ($1, $2, $3, 'user', 'free')
			RETURNING id, username, email, is_active, role, membership
		`, googleUsername(claims.Email), claims.Email, claims.Sub)
		user, err = scanUser(row)
		if err != nil {
			return nil, err
		}
	}
	if user == nil {
		return nil, googleAuthFailed()
	}
	if !user.IsActive {
		return nil, api.NewError(http.StatusForbidden, "USER_INACTIVE", "User account is disabled", nil)
	}
	cacheUser(ctx, *user)
	return user, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func googleUsername(email string) string {
	local := strings.SplitN(email, "@", 2)[0]
	var b strings.Builder
	for _, c := range local {
		if b.Len() >= 12 {
			break
		}
		if c == '_' || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			b.WriteRune(c)
		}
	}
	name := b.String()
	if name == "" {
		name = "user"
	}
	return name + "_" + strings.ReplaceAll(NewUUID(), "-", "")[:6]
}
