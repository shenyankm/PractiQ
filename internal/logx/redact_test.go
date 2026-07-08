package logx

import (
	"reflect"
	"testing"
)

func TestRedactMasksSensitiveFields(t *testing.T) {
	const redacted = "[Redacted]"

	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
	}{
		{
			name: "top level and nested passwords are masked",
			input: map[string]any{
				"username":     "alice",
				"password":     "plain-secret",
				"passwordHash": "$2y$10$abcdef",
				"user": map[string]any{
					"password":     "nested-password",
					"passwordHash": "nested-hash",
					"displayName":  "Alice",
				},
			},
			want: map[string]any{
				"username":     "alice",
				"password":     redacted,
				"passwordHash": redacted,
				"user": map[string]any{
					"password":     redacted,
					"passwordHash": redacted,
					"displayName":  "Alice",
				},
			},
		},
		{
			name: "body credentials and uploaded base64 are masked",
			input: map[string]any{
				"body": map[string]any{
					"password":     "body-password",
					"passwordHash": "body-hash",
					"fileBase64":   "VGhpcyBpcyBhIHBheWxvYWQ=",
					"title":        "import payload",
				},
				"fileBase64": "dG9wLWxldmVsLWJhc2U2NA==",
			},
			want: map[string]any{
				"body": map[string]any{
					"password":     redacted,
					"passwordHash": redacted,
					"fileBase64":   redacted,
					"title":        "import payload",
				},
				"fileBase64": redacted,
			},
		},
		{
			name: "authorization and cookie headers are masked",
			input: map[string]any{
				"authorization": "Bearer top-level-token",
				"cookie":        "session=abc",
				"set-cookie":    "session=abc; HttpOnly",
				"headers": map[string]any{
					"authorization": "Bearer nested-token",
					"cookie":        "session=nested",
					"set-cookie":    "session=nested; HttpOnly",
					"x-request-id":  "req-123",
				},
			},
			want: map[string]any{
				"authorization": redacted,
				"cookie":        redacted,
				"set-cookie":    redacted,
				"headers": map[string]any{
					"authorization": redacted,
					"cookie":        redacted,
					"set-cookie":    redacted,
					"x-request-id":  "req-123",
				},
			},
		},
		{
			name: "tokens keys and provider secrets are masked",
			input: map[string]any{
				"token":                 "token-value",
				"accessToken":           "access-token",
				"refreshToken":          "refresh-token",
				"apiKey":                "public-api-key",
				"secret":                "shared-secret",
				"privateKey":            "-----BEGIN PRIVATE KEY-----",
				"publicKey":             "ssh-ed25519 AAAA",
				"PADDLE_API_KEY":        "pdl_live_api",
				"PADDLE_CLIENT_TOKEN":   "pdl_live_client",
				"PADDLE_WEBHOOK_SECRET": "pdl_live_webhook",
				"MOONSHOT_API_KEY":      "moonshot-key",
				"DEEPSEEK_API_KEY":      "deepseek-key",
				"OPENAI_API_KEY":        "openai-key",
			},
			want: map[string]any{
				"token":                 redacted,
				"accessToken":           redacted,
				"refreshToken":          redacted,
				"apiKey":                redacted,
				"secret":                redacted,
				"privateKey":            redacted,
				"publicKey":             "ssh-ed25519 AAAA",
				"PADDLE_API_KEY":        redacted,
				"PADDLE_CLIENT_TOKEN":   redacted,
				"PADDLE_WEBHOOK_SECRET": redacted,
				"MOONSHOT_API_KEY":      redacted,
				"DEEPSEEK_API_KEY":      redacted,
				"OPENAI_API_KEY":        redacted,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Redact(tc.input)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Redact(...) = %#v, want %#v", got, tc.want)
			}
		})
	}
}
