package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

type SessionUser struct {
	ID int `json:"id"`
}

type SessionPayload struct {
	User    SessionUser `json:"user"`
	Expires string      `json:"expires"`
	JTI     string      `json:"jti,omitempty"`
}

func SignSessionToken(payload SessionPayload) (string, error) {
	secret, err := sessionSecret()
	if err != nil {
		return "", err
	}
	if payload.User.ID <= 0 {
		return "", errors.New("session user id must be positive")
	}
	if payload.Expires == "" {
		payload.Expires = time.Now().UTC().Add(7 * 24 * time.Hour).Format(time.RFC3339)
	}
	expiresAt, err := time.Parse(time.RFC3339, payload.Expires)
	if err != nil {
		return "", err
	}

	header := map[string]any{"alg": "HS256", "typ": "JWT"}
	claims := map[string]any{
		"user":    payload.User,
		"expires": payload.Expires,
		"iat":     time.Now().Unix(),
		"exp":     expiresAt.Unix(),
	}
	if payload.JTI != "" {
		claims["jti"] = payload.JTI
	}
	return signJWT(header, claims, secret)
}

func VerifySessionToken(token string) (SessionPayload, error) {
	secret, err := sessionSecret()
	if err != nil {
		return SessionPayload{}, err
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return SessionPayload{}, errors.New("invalid session token")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return SessionPayload{}, err
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return SessionPayload{}, err
	}
	if header.Alg != "HS256" {
		return SessionPayload{}, errors.New("invalid session token algorithm")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[2]), []byte(want)) {
		return SessionPayload{}, errors.New("invalid session token signature")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return SessionPayload{}, err
	}
	var raw map[string]any
	if err := json.Unmarshal(payloadBytes, &raw); err != nil {
		return SessionPayload{}, err
	}
	payload, err := parseSessionPayload(raw)
	if err != nil {
		return SessionPayload{}, err
	}
	expiresAt, err := time.Parse(time.RFC3339, payload.Expires)
	if err != nil {
		return SessionPayload{}, err
	}
	if !expiresAt.After(time.Now().UTC()) {
		return SessionPayload{}, errors.New("session token expired")
	}
	if exp, ok := raw["exp"].(float64); ok && !time.Unix(int64(exp), 0).After(time.Now().UTC()) {
		return SessionPayload{}, errors.New("session token expired")
	}
	return payload, nil
}

func SessionCookie(token string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   os.Getenv("NODE_ENV") == "production",
	}
}

func sessionSecret() (string, error) {
	if secret := os.Getenv("AUTH_SECRET"); secret != "" {
		return secret, nil
	}
	if os.Getenv("NODE_ENV") == "production" {
		return "", errors.New("AUTH_SECRET environment variable is required in production")
	}
	return "development-secret", nil
}

func signJWT(header map[string]any, claims map[string]any, secret string) (string, error) {
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func parseSessionPayload(raw map[string]any) (SessionPayload, error) {
	user, ok := raw["user"].(map[string]any)
	if !ok {
		return SessionPayload{}, errors.New("session user is required")
	}
	idValue, ok := user["id"].(float64)
	if !ok || idValue <= 0 || idValue != float64(int(idValue)) {
		return SessionPayload{}, errors.New("session user id must be a positive integer")
	}
	expires, ok := raw["expires"].(string)
	if !ok || expires == "" {
		return SessionPayload{}, errors.New("session expires is required")
	}
	payload := SessionPayload{User: SessionUser{ID: int(idValue)}, Expires: expires}
	if rawJTI, ok := raw["jti"]; ok {
		jti, ok := rawJTI.(string)
		if !ok {
			return SessionPayload{}, fmt.Errorf("session jti must be a string")
		}
		payload.JTI = jti
	}
	return payload, nil
}
