package logx

const redacted = "[Redacted]"

var sensitiveKeys = map[string]bool{
	"password":             true,
	"passwordHash":         true,
	"fileBase64":           true,
	"authorization":        true,
	"cookie":               true,
	"set-cookie":           true,
	"token":                true,
	"accessToken":          true,
	"refreshToken":         true,
	"apiKey":               true,
	"secret":               true,
	"privateKey":           true,
	"PADDLE_API_KEY":       true,
	"PADDLE_CLIENT_TOKEN":  true,
	"PADDLE_WEBHOOK_SECRET": true,
	"MOONSHOT_API_KEY":     true,
	"DEEPSEEK_API_KEY":     true,
	"OPENAI_API_KEY":       true,
}

func Redact(value map[string]any) map[string]any {
	return redactMap(value)
}

func redactMap(value map[string]any) map[string]any {
	out := make(map[string]any, len(value))
	for key, raw := range value {
		if sensitiveKeys[key] {
			out[key] = redacted
			continue
		}
		switch nested := raw.(type) {
		case map[string]any:
			out[key] = redactMap(nested)
		default:
			out[key] = raw
		}
	}
	return out
}
