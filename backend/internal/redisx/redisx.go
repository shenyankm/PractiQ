package redisx

import (
	"fmt"
	"os"
	"strings"
)

func RedisKey(parts ...any) string {
	prefix := os.Getenv("REDIS_KEY_PREFIX")
	if strings.TrimSpace(prefix) == "" {
		prefix = "practiq"
	}
	values := []string{prefix}
	for _, part := range parts {
		if part == nil {
			continue
		}
		value := strings.TrimSpace(fmt.Sprint(part))
		if value == "" {
			continue
		}
		values = append(values, value)
	}
	return strings.Join(values, ":")
}

func ImportEventChannel(jobID int64) string {
	return RedisKey("import", jobID, "events")
}
