package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSignSessionTokenUsesHS256PayloadShapeAndSevenDayDefaultExpiry(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "contract-secret")

	before := time.Now().UTC()
	payload := SessionPayload{
		User: SessionUser{ID: 42},
		Expires: before.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		JTI: "session-jti",
	}

	token, err := SignSessionToken(payload)
	if err != nil {
		t.Fatalf("SignSessionToken returned error: %v", err)
	}

	after := time.Now().UTC()
	header, claims := decodeJWT(t, token)

	if got := header["alg"]; got != "HS256" {
		t.Fatalf("jwt alg = %v, want HS256", got)
	}

	userClaims, ok := claims["user"].(map[string]any)
	if !ok {
		t.Fatalf("user claim = %T, want object", claims["user"])
	}
	if got := userClaims["id"]; got != float64(42) {
		t.Fatalf("user.id claim = %v, want 42", got)
	}

	expiresRaw, ok := claims["expires"].(string)
	if !ok {
		t.Fatalf("expires claim = %T, want string", claims["expires"])
	}
	expiresAt, err := time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		t.Fatalf("expires claim %q is not RFC3339: %v", expiresRaw, err)
	}

	wantMin := before.Add(7 * 24 * time.Hour)
	wantMax := after.Add(7 * 24 * time.Hour)
	if expiresAt.Before(wantMin.Add(-2*time.Second)) || expiresAt.After(wantMax.Add(2*time.Second)) {
		t.Fatalf("expires = %s, want about 7 days from now between %s and %s", expiresAt.Format(time.RFC3339), wantMin.Format(time.RFC3339), wantMax.Format(time.RFC3339))
	}
	if expiresRaw != payload.Expires {
		t.Fatalf("expires claim = %q, want payload value %q", expiresRaw, payload.Expires)
	}

	jti, ok := claims["jti"].(string)
	if !ok || strings.TrimSpace(jti) == "" {
		t.Fatalf("jti claim = %v, want non-empty string", claims["jti"])
	}

	expValue, ok := claims["exp"].(float64)
	if !ok {
		t.Fatalf("exp claim = %T, want numeric unix timestamp", claims["exp"])
	}
	expAt := time.Unix(int64(expValue), 0).UTC()
	if diff := expAt.Sub(expiresAt); diff < -time.Second || diff > time.Second {
		t.Fatalf("jwt exp %s and payload expires %s differ by %s", expAt.Format(time.RFC3339), expiresAt.Format(time.RFC3339), diff)
	}

	verified, err := VerifySessionToken(token)
	if err != nil {
		t.Fatalf("VerifySessionToken returned error: %v", err)
	}
	if verified.User.ID != 42 {
		t.Fatalf("verified user id = %d, want 42", verified.User.ID)
	}
	if verified.Expires != payload.Expires {
		t.Fatalf("verified expires = %q, want %q", verified.Expires, payload.Expires)
	}
}

func TestSessionCookieUsesSessionNameHttpOnlyLaxAndProductionSecure(t *testing.T) {
	expires := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)

	t.Run("non-production", func(t *testing.T) {
		t.Setenv("NODE_ENV", "test")

		cookie := SessionCookie("token-value", expires)
		if cookie.Name != "session" {
			t.Fatalf("cookie name = %q, want session", cookie.Name)
		}
		if !cookie.HttpOnly {
			t.Fatal("session cookie must be HttpOnly")
		}
		if cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("cookie SameSite = %v, want %v", cookie.SameSite, http.SameSiteLaxMode)
		}
		if cookie.Secure {
			t.Fatal("session cookie must not be Secure outside production")
		}
	})

	t.Run("production", func(t *testing.T) {
		t.Setenv("NODE_ENV", "production")

		cookie := SessionCookie("token-value", expires)
		if cookie.Name != "session" {
			t.Fatalf("cookie name = %q, want session", cookie.Name)
		}
		if !cookie.HttpOnly {
			t.Fatal("session cookie must be HttpOnly")
		}
		if cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("cookie SameSite = %v, want %v", cookie.SameSite, http.SameSiteLaxMode)
		}
		if !cookie.Secure {
			t.Fatal("session cookie must be Secure in production")
		}
	})
}

func TestVerifySessionTokenUsesConfiguredSecretOrDevelopmentFallback(t *testing.T) {
	future := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)

	t.Run("configured AUTH_SECRET", func(t *testing.T) {
		t.Setenv("NODE_ENV", "production")
		t.Setenv("AUTH_SECRET", "configured-secret")

		token := signedSessionToken(t, "configured-secret", map[string]any{
			"user":    map[string]any{"id": 11},
			"expires": future.Format(time.RFC3339),
			"jti":     "configured-jti",
		}, future)

		payload, err := VerifySessionToken(token)
		if err != nil {
			t.Fatalf("VerifySessionToken returned error: %v", err)
		}
		if payload.User.ID != 11 {
			t.Fatalf("payload user id = %d, want 11", payload.User.ID)
		}
		if payload.Expires != future.Format(time.RFC3339) {
			t.Fatalf("payload expires = %q, want %q", payload.Expires, future.Format(time.RFC3339))
		}
	})

	t.Run("development-secret fallback outside production", func(t *testing.T) {
		t.Setenv("NODE_ENV", "test")
		t.Setenv("AUTH_SECRET", "")

		token := signedSessionToken(t, "development-secret", map[string]any{
			"user":    map[string]any{"id": 19},
			"expires": future.Format(time.RFC3339),
		}, future)

		payload, err := VerifySessionToken(token)
		if err != nil {
			t.Fatalf("VerifySessionToken returned error: %v", err)
		}
		if payload.User.ID != 19 {
			t.Fatalf("payload user id = %d, want 19", payload.User.ID)
		}
	})

	t.Run("rejects wrong secret", func(t *testing.T) {
		t.Setenv("NODE_ENV", "test")
		t.Setenv("AUTH_SECRET", "expected-secret")

		token := signedSessionToken(t, "wrong-secret", map[string]any{
			"user":    map[string]any{"id": 23},
			"expires": future.Format(time.RFC3339),
		}, future)

		if _, err := VerifySessionToken(token); err == nil {
			t.Fatal("VerifySessionToken unexpectedly accepted token signed with the wrong secret")
		}
	})

	t.Run("production does not fall back to development secret", func(t *testing.T) {
		t.Setenv("NODE_ENV", "production")
		t.Setenv("AUTH_SECRET", "")

		token := signedSessionToken(t, "development-secret", map[string]any{
			"user":    map[string]any{"id": 29},
			"expires": future.Format(time.RFC3339),
		}, future)

		if _, err := VerifySessionToken(token); err == nil {
			t.Fatal("VerifySessionToken unexpectedly accepted development-secret fallback in production")
		}
	})
}

func TestSignSessionTokenRequiresAuthSecretInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("AUTH_SECRET", "")

	payload := SessionPayload{
		User: SessionUser{ID: 88},
		Expires: time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC).Format(time.RFC3339),
	}

	if _, err := SignSessionToken(payload); err == nil {
		t.Fatal("SignSessionToken unexpectedly succeeded without AUTH_SECRET in production")
	}
}

func TestVerifySessionTokenRejectsExpiredMalformedAndSchemaInvalidTokens(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("AUTH_SECRET", "verify-secret")

	expiredAt := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	expired := signedSessionToken(t, "verify-secret", map[string]any{
		"user":    map[string]any{"id": 5},
		"expires": expiredAt.Format(time.RFC3339),
		"jti":     "expired-jti",
	}, expiredAt)
	if _, err := VerifySessionToken(expired); err == nil {
		t.Fatal("VerifySessionToken unexpectedly accepted expired token")
	}

	if _, err := VerifySessionToken("not-a-jwt"); err == nil {
		t.Fatal("VerifySessionToken unexpectedly accepted malformed token")
	}

	invalidShape := signedSessionToken(t, "verify-secret", map[string]any{
		"user":    map[string]any{"id": "5"},
		"expires": time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC).Format(time.RFC3339),
	}, time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC))
	if _, err := VerifySessionToken(invalidShape); err == nil {
		t.Fatal("VerifySessionToken unexpectedly accepted token with non-numeric user.id")
	}
}

func signedSessionToken(t *testing.T, secret string, payload map[string]any, expiresAt time.Time) string {
	t.Helper()

	headerJSON, err := json.Marshal(map[string]any{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}

	claims := make(map[string]any, len(payload)+2)
	for key, value := range payload {
		claims[key] = value
	}
	claims["iat"] = expiresAt.Add(-time.Minute).Unix()
	claims["exp"] = expiresAt.Unix()

	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}

	encodedHeader := base64.RawURLEncoding.EncodeToString(headerJSON)
	encodedClaims := base64.RawURLEncoding.EncodeToString(claimsJSON)
	signingInput := encodedHeader + "." + encodedClaims

	mac := hmac.New(sha256.New, []byte(secret))
	if _, err := mac.Write([]byte(signingInput)); err != nil {
		t.Fatalf("write signature: %v", err)
	}
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return signingInput + "." + signature
}

func decodeJWT(t *testing.T, token string) (map[string]any, map[string]any) {
	t.Helper()

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt has %d parts, want 3", len(parts))
	}

	decodePart := func(label, raw string) map[string]any {
		bytes, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil {
			t.Fatalf("decode %s: %v", label, err)
		}

		var out map[string]any
		if err := json.Unmarshal(bytes, &out); err != nil {
			t.Fatalf("unmarshal %s json: %v", label, err)
		}
		return out
	}

	return decodePart("header", parts[0]), decodePart("payload", parts[1])
}
