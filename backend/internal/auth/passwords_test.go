package auth

import (
	"strings"
	"testing"
)

func TestHashPasswordUsesBcryptCost10AndDummyHashConstant(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword returned error: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("hash echoes plaintext password")
	}

	parts := strings.Split(hash, "$")
	if len(parts) < 4 {
		t.Fatalf("hash = %q, want bcrypt encoded string", hash)
	}
	if parts[2] != "10" {
		t.Fatalf("bcrypt cost = %q, want %q", parts[2], "10")
	}
	if DummyPasswordHash != "$2y$10$bPkUrUZqKDqmW.xkPE5LBuqH6HB/QoOS4dYH42xQxevBJQMStTE0W" {
		t.Fatalf("DummyPasswordHash = %q, want migration dummy hash", DummyPasswordHash)
	}
}
