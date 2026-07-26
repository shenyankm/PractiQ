package services

const (
	PracticeModeAll    = "all"
	PracticeModeWrong  = "wrong"
	PracticeModeByType = "by_type"
	PracticeModeExam   = "exam"

	maxPracticeQuestions = 500
)

type PracticeProgressItem struct {
	Index      int
	QuestionID int64
	IsAnswered bool
	IsCorrect  *bool
}

func normalizePracticeMode(mode string, sessionType string) string {
	if mode != "" {
		return mode
	}
	if sessionType == "review" {
		return PracticeModeWrong
	}
	if sessionType == "exam" {
		return PracticeModeExam
	}
	return PracticeModeAll
}

func normalizeQuestionCount(questionCount int, allQuestions bool) int {
	if allQuestions {
		return maxPracticeQuestions
	}
	if questionCount < 1 {
		return 1
	}
	if questionCount > maxPracticeQuestions {
		return maxPracticeQuestions
	}
	return questionCount
}

func buildPracticeProgress(questionIDs []int64, answered map[int64]*bool) []PracticeProgressItem {
	items := make([]PracticeProgressItem, 0, len(questionIDs))
	for index, questionID := range questionIDs {
		isCorrect, ok := answered[questionID]
		items = append(items, PracticeProgressItem{Index: index, QuestionID: questionID, IsAnswered: ok, IsCorrect: isCorrect})
	}
	return items
}
