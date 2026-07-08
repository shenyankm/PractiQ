package services

import "testing"

func TestNormalizeLeaderboardLimitClampsRange(t *testing.T) {
	if got := normalizeLeaderboardLimit(0); got != 1 {
		t.Fatalf("normalizeLeaderboardLimit(0) = %d, want 1", got)
	}
	if got := normalizeLeaderboardLimit(101); got != 100 {
		t.Fatalf("normalizeLeaderboardLimit(101) = %d, want 100", got)
	}
	if got := normalizeLeaderboardLimit(20); got != 20 {
		t.Fatalf("normalizeLeaderboardLimit(20) = %d, want 20", got)
	}
}
