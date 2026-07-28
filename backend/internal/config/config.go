package config

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	NodeEnv          string
	AIServiceURL     string
	AIServiceToken   string
	AIServiceTimeout time.Duration
	PractiQHost     string
	AppOrigin        string
	Port             int
}

func Load() (Config, error) {
	values := map[string]string{}
	for _, path := range dotenvPaths(".env.local") {
		loadDotenv(values, path)
	}
	for _, path := range dotenvPaths(".env") {
		loadDotenv(values, path)
	}
	dotenvValues := make(map[string]string, len(values))
	for key, value := range values {
		dotenvValues[key] = value
	}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	for key, value := range dotenvValues {
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return Config{}, fmt.Errorf("set %s from dotenv: %w", key, err)
		}
	}

	cfg := Config{
		NodeEnv:          get(values, "NODE_ENV", "development"),
		AIServiceURL:     get(values, "AI_SERVICE_URL", "http://127.0.0.1:8001"),
		AIServiceToken:   values["AI_SERVICE_TOKEN"],
		AIServiceTimeout: DefaultAIServiceTimeout,
		PractiQHost:     get(values, "PRACTIQ_HOST", "127.0.0.1"),
		AppOrigin:        values["APP_ORIGIN"],
		Port:             8080,
	}
	if rawTimeout := strings.TrimSpace(values["AI_SERVICE_TIMEOUT"]); rawTimeout != "" {
		timeout, err := time.ParseDuration(rawTimeout)
		if err != nil || timeout <= 0 {
			return Config{}, fmt.Errorf("AI_SERVICE_TIMEOUT must be a positive Go duration such as 30m")
		}
		cfg.AIServiceTimeout = timeout
	}
	if rawPort := strings.TrimSpace(values["PORT"]); rawPort != "" {
		port, err := strconv.Atoi(rawPort)
		if err != nil || port <= 0 {
			return Config{}, fmt.Errorf("PORT must be a positive integer")
		}
		cfg.Port = port
	}
	if strings.TrimSpace(values["AUTH_SECRET"]) == "" {
		return Config{}, fmt.Errorf("AUTH_SECRET is required")
	}
	if _, err := SessionTTL(); err != nil {
		return Config{}, err
	}
	if cfg.AIServiceToken == "" && (cfg.NodeEnv == "production" || (os.Getenv("AI_SERVICE_URL") != "" && !isLocalURL(cfg.AIServiceURL))) {
		return Config{}, fmt.Errorf("AI_SERVICE_TOKEN is required for production or non-local AI_SERVICE_URL")
	}
	return cfg, nil
}

func dotenvPaths(name string) []string {
	dir, err := os.Getwd()
	if err != nil {
		return nil
	}

	paths := make([]string, 0, 2)
	for {
		paths = append(paths, filepath.Join(dir, name))
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return paths
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return paths
		}
		dir = parent
	}
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

const DefaultSessionTTL = 7 * 24 * time.Hour

const DefaultAIServiceTimeout = 5 * time.Minute

func SessionTTL() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv("SESSION_TTL_MS"))
	if raw == "" {
		return DefaultSessionTTL, nil
	}
	milliseconds, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || milliseconds <= 0 || milliseconds > int64(time.Duration(1<<63-1)/time.Millisecond) {
		return 0, fmt.Errorf("SESSION_TTL_MS must be a positive integer within the supported duration range")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func isLocalURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
