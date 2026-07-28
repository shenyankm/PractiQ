package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"net/smtp"
	"os"
	"strings"
	"time"

	"practiq/internal/api"
	"practiq/internal/redisx"
)

const emailCodeTTL = 10 * time.Minute

type emailCodeRequest struct {
	Email *string `json:"email"`
}

// sendEmailCode is a package-level variable so tests can stub SMTP delivery.
var sendEmailCode = deliverEmailCode

// EmailCode issues a registration verification code to the given address.
func EmailCode() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body emailCodeRequest
		if err := decodeAuthRequest(w, r, &body); err != nil {
			api.HandleError(w, r, err)
			return
		}
		if detail := normalizeEmail(&body.Email, true); detail != nil {
			api.HandleError(w, r, api.ValidationError([]api.ValidationDetail{*detail}))
			return
		}
		if err := rateLimitAuth(r, *body.Email); err != nil {
			api.HandleError(w, r, err)
			return
		}
		rdb := redisx.Client()
		if rdb == nil {
			api.HandleError(w, r, sessionStoreUnavailable())
			return
		}
		code, err := newEmailCode()
		if err != nil {
			api.HandleError(w, r, err)
			return
		}
		if err := rdb.Set(r.Context(), emailCodeKey(*body.Email), code, emailCodeTTL).Err(); err != nil {
			api.HandleError(w, r, sessionStoreUnavailable())
			return
		}
		if err := sendEmailCode(*body.Email, code); err != nil {
			api.HandleError(w, r, api.NewError(http.StatusBadGateway, "EMAIL_DELIVERY_FAILED", "Could not send the verification email", nil))
			return
		}
		api.NoContent(w, r)
	})
}

// VerifyEmailCode checks the one-time registration code and consumes it on success.
func VerifyEmailCode(r *http.Request, email string, code string) error {
	invalid := api.ValidationError([]api.ValidationDetail{{Field: "code", Message: "Verification code is invalid or expired"}})
	if len(code) != 6 {
		return invalid
	}
	rdb := redisx.Client()
	if rdb == nil {
		return sessionStoreUnavailable()
	}
	key := emailCodeKey(email)
	stored, err := rdb.Get(r.Context(), key).Result()
	if err != nil || !hmac.Equal([]byte(stored), []byte(code)) {
		return invalid
	}
	_ = rdb.Del(r.Context(), key).Err()
	return nil
}

func emailCodeKey(email string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(email)))
	return redisx.RedisKey("email-verify", hex.EncodeToString(digest[:]))
}

func newEmailCode() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	return fmt.Sprintf("%06d", n%1000000), nil
}

func deliverEmailCode(email string, code string) error {
	host := strings.TrimSpace(os.Getenv("SMTP_HOST"))
	if host == "" {
		// Local development fallback only; never leave SMTP_HOST unset in production.
		log.Printf("SMTP_HOST is not configured; verification code for %s is %s", email, code)
		return nil
	}
	port := strings.TrimSpace(os.Getenv("SMTP_PORT"))
	if port == "" {
		port = "587"
	}
	from := strings.TrimSpace(os.Getenv("SMTP_FROM"))
	username := strings.TrimSpace(os.Getenv("SMTP_USERNAME"))
	var auth smtp.Auth
	if username != "" {
		auth = smtp.PlainAuth("", username, os.Getenv("SMTP_PASSWORD"), host)
	}
	message := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: PractiQ verification code\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour PractiQ verification code is %s. It expires in 10 minutes.\r\n", from, email, code)
	return smtp.SendMail(host+":"+port, auth, from, []string{email}, []byte(message))
}
