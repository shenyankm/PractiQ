package services

import "testing"

func TestBuildPageCursorContinuesAtNextOffset(t *testing.T) {
	page := buildPage([]int{1, 2, 3}, 2, 0)
	if len(page.Items) != 2 || !page.HasMore || page.Cursor == "" {
		t.Fatalf("page = %#v, want two items and a next cursor", page)
	}
	offset, err := parsePageCursor(page.Cursor)
	if err != nil || offset != 2 {
		t.Fatalf("cursor offset = %d, err = %v; want 2", offset, err)
	}
}
