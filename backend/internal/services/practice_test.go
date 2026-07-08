package services

import "testing"

func TestNormalizePracticeModeMapsReviewExamAndExplicitModes(t *testing.T) {
	if got := normalizePracticeMode("", "review"); got != PracticeModeWrong {
		t.Fatalf("normalizePracticeMode(review) = %q, want %q", got, PracticeModeWrong)
	}
	if got := normalizePracticeMode("", "exam"); got != PracticeModeExam {
		t.Fatalf("normalizePracticeMode(exam) = %q, want %q", got, PracticeModeExam)
	}
	if got := normalizePracticeMode(PracticeModeByType, "practice"); got != PracticeModeByType {
		t.Fatalf("normalizePracticeMode(by_type) = %q, want %q", got, PracticeModeByType)
	}
	if got := normalizePracticeMode("", "practice"); got != PracticeModeAll {
		t.Fatalf("normalizePracticeMode(default) = %q, want %q", got, PracticeModeAll)
	}
}

func TestNormalizeQuestionCountSupportsAllQuestionsAndServerCap(t *testing.T) {
	if got := normalizeQuestionCount(0, true); got != maxPracticeQuestions {
		t.Fatalf("normalizeQuestionCount(allQuestions) = %d, want %d", got, maxPracticeQuestions)
	}
	if got := normalizeQuestionCount(999, false); got != maxPracticeQuestions {
		t.Fatalf("normalizeQuestionCount(cap) = %d, want %d", got, maxPracticeQuestions)
	}
	if got := normalizeQuestionCount(0, false); got != 1 {
		t.Fatalf("normalizeQuestionCount(floor) = %d, want 1", got)
	}
}

func TestBuildPracticeProgressWindowsLargeSessions(t *testing.T) {
	ids := make([]int64, practiceProgressFullLimit+5)
	for i := range ids {
		ids[i] = int64(i + 1)
	}

	answered := map[int64]PracticeAnswerResult{
		1:  {QuestionID: 1, IsCorrect: new(true)},
		64: {QuestionID: 64, IsCorrect: new(false)},
	}

	progress := buildPracticeProgress(ids, answered, 63)
	if len(progress) >= len(ids) {
		t.Fatalf("len(progress) = %d, want truncated window smaller than %d", len(progress), len(ids))
	}
	if progress[0].Index != 0 {
		t.Fatalf("first progress index = %d, want 0", progress[0].Index)
	}
	if progress[len(progress)-1].Index != len(ids)-1 {
		t.Fatalf("last progress index = %d, want %d", progress[len(progress)-1].Index, len(ids)-1)
	}
	if progress[1].Index > 63-practiceProgressWindowRadius {
		t.Fatalf("window start = %d, want <= %d", progress[1].Index, 63-practiceProgressWindowRadius)
	}
	foundCurrent := false
	for _, item := range progress {
		if item.Index == 63 {
			foundCurrent = true
			if !item.IsAnswered {
				t.Fatalf("current progress item should be marked answered")
			}
			if item.IsCorrect == nil || *item.IsCorrect {
				t.Fatalf("current progress correctness = %#v, want false", item.IsCorrect)
			}
		}
	}
	if !foundCurrent {
		t.Fatalf("current index missing from progress window")
	}
}
