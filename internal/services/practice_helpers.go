package services

const (
	PracticeModeAll    = "all"
	PracticeModeWrong  = "wrong"
	PracticeModeByType = "by_type"
	PracticeModeExam   = "exam"

	maxPracticeQuestions       = 500
	practiceProgressFullLimit  = 120
	practiceProgressWindowRadius = 30
)

type PracticeAnswerResult struct {
	QuestionID  int64
	IsCorrect   *bool
	IsAnswered  bool
}

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

func buildPracticeProgress(questionIDs []int64, answered map[int64]PracticeAnswerResult, currentIndex int) []PracticeProgressItem {
	if len(questionIDs) <= practiceProgressFullLimit {
		items := make([]PracticeProgressItem, 0, len(questionIDs))
		for index, questionID := range questionIDs {
			result, ok := answered[questionID]
			items = append(items, PracticeProgressItem{Index: index, QuestionID: questionID, IsAnswered: ok, IsCorrect: result.IsCorrect})
		}
		return items
	}

	start := currentIndex - practiceProgressWindowRadius
	if start < 1 {
		start = 1
	}
	end := currentIndex + practiceProgressWindowRadius
	if end > len(questionIDs)-2 {
		end = len(questionIDs) - 2
	}
	items := []PracticeProgressItem{{Index: 0, QuestionID: questionIDs[0], IsAnswered: answered[questionIDs[0]].QuestionID != 0, IsCorrect: answered[questionIDs[0]].IsCorrect}}
	for index := start; index <= end; index++ {
		questionID := questionIDs[index]
		result, ok := answered[questionID]
		items = append(items, PracticeProgressItem{Index: index, QuestionID: questionID, IsAnswered: ok, IsCorrect: result.IsCorrect})
	}
	lastIndex := len(questionIDs) - 1
	questionID := questionIDs[lastIndex]
	result, ok := answered[questionID]
	items = append(items, PracticeProgressItem{Index: lastIndex, QuestionID: questionID, IsAnswered: ok, IsCorrect: result.IsCorrect})
	return items
}
