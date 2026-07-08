package services

func normalizeLeaderboardLimit(limit int) int {
	if limit < 1 {
		return 1
	}
	if limit > 100 {
		return 100
	}
	return limit
}
