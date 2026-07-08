package config

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	NodeEnv        string
	DatabaseURL    string
	AIServiceURL   string
	AIServiceToken string
	OpenWookHost   string
	Port           int
}

func Load() (Config, error) {
	values := map[string]string{}
	loadDotenv(values, ".env.local")
	loadDotenv(values, ".env")
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}

	cfg := Config{
		NodeEnv:        get(values, "NODE_ENV", "development"),
		DatabaseURL:    first(values["POSTGRES_URL"], values["DATABASE_URL"]),
		AIServiceURL:   get(values, "AI_SERVICE_URL", "http://127.0.0.1:8001"),
		AIServiceToken: values["AI_SERVICE_TOKEN"],
		OpenWookHost:   get(values, "OPENWOOK_HOST", "127.0.0.1"),
		Port:           3000,
	}
	if rawPort := strings.TrimSpace(values["PORT"]); rawPort != "" {
		port, err := strconv.Atoi(rawPort)
		if err != nil || port <= 0 {
			return Config{}, fmt.Errorf("PORT must be a positive integer")
		}
		cfg.Port = port
	}
	if cfg.AIServiceToken == "" && (cfg.NodeEnv == "production" || (os.Getenv("AI_SERVICE_URL") != "" && !isLocalURL(cfg.AIServiceURL))) {
		return Config{}, fmt.Errorf("AI_SERVICE_TOKEN is required for production or non-local AI_SERVICE_URL")
	}
	return cfg, nil
}

func loadDotenv(values map[string]string, path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := values[key]; exists {
			continue
		}
		values[key] = trimEnvValue(value)
	}
}

func trimEnvValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 {
		quote := value[0]
		if (quote == '\'' || quote == '"') && value[len(value)-1] == quote {
			return value[1 : len(value)-1]
		}
	}
	return value
}

func get(values map[string]string, key string, fallback string) string {
	if value := strings.TrimSpace(values[key]); value != "" {
		return value
	}
	return fallback
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func isLocalURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
