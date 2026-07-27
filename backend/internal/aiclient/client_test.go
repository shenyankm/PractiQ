package aiclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"openwook/internal/config"
)

func TestNewConfiguresBoundedRequestTimeout(t *testing.T) {
	client := New(config.Config{})
	if client.httpClient.Timeout != 5*time.Minute {
		t.Fatalf("HTTP timeout = %s, want %s", client.httpClient.Timeout, 5*time.Minute)
	}
}

func TestClientPostsJSONToInternalAIEndpointsAndDecodesResponses(t *testing.T) {
	tests := []struct {
		name         string
		path         string
		requestBody  map[string]any
		responseBody string
		call         func(*testing.T, *Client, context.Context)
	}{
		{
			name: "parse document",
			path: "/internal/ai/parse-document",
			requestBody: map[string]any{
				"importJobId": float64(12),
				"bankId":      float64(34),
				"sourceType":  "text",
				"fileName":    "questions.txt",
				"text":        "1. What is 2+2?\nA. 4\nB. 5\n答案: A",
				"mimeType":    "text/plain",
			},
			responseBody: `{"questions":[{"stem":"What is 2 + 2?","answerMode":"choice","questionTypeId":"math-mcq","options":[{"label":"A","content":"4","isCorrect":true},{"label":"B","content":"5"}],"answerPayload":{"correctOption":"A"},"analysis":"Basic arithmetic","contentBlocks":[{"partType":"text","role":"stem","textValue":"What is 2 + 2?"}],"sourceText":"1. What is 2+2?","confidence":0.93,"needsReview":false}],"groups":[{"title":"Section 1","instructions":"Choose the best answer.","questionIndexes":[0]}],"visualElements":[{"kind":"table","label":"Data table","description":"Two-column lookup table","extractedText":"1 2 3 4"}],"warnings":["Low-confidence OCR on item 3"],"qualityScore":91}`,
			call: func(t *testing.T, client *Client, ctx context.Context) {
				result, err := client.ParseDocument(ctx, DocumentParseRequest{
					ImportJobID: intPtr(12),
					BankID:      intPtr(34),
					SourceType:  "text",
					FileName:    "questions.txt",
					Text:        "1. What is 2+2?\nA. 4\nB. 5\n答案: A",
					MimeType:    "text/plain",
				})
				if err != nil {
					t.Fatalf("ParseDocument error = %v, want nil", err)
				}
				if result == nil {
					t.Fatal("ParseDocument result = nil, want value")
				}
				if len(result.Questions) != 1 {
					t.Fatalf("len(result.Questions) = %d, want 1", len(result.Questions))
				}
				question := result.Questions[0]
				if question.Stem != "What is 2 + 2?" {
					t.Fatalf("question.Stem = %q, want %q", question.Stem, "What is 2 + 2?")
				}
				if question.AnswerMode != "choice" {
					t.Fatalf("question.AnswerMode = %q, want %q", question.AnswerMode, "choice")
				}
				if question.QuestionTypeID != "math-mcq" {
					t.Fatalf("question.QuestionTypeID = %q, want %q", question.QuestionTypeID, "math-mcq")
				}
				if len(question.Options) != 2 || question.Options[0].Label != "A" || question.Options[0].Content != "4" || !question.Options[0].IsCorrect {
					t.Fatalf("question.Options = %#v, want decoded answer options", question.Options)
				}
				if got := question.AnswerPayload["correctOption"]; got != "A" {
					t.Fatalf("question.AnswerPayload[correctOption] = %#v, want %q", got, "A")
				}
				if got := question.ContentBlocks[0].PartType; got != "text" {
					t.Fatalf("question.ContentBlocks[0].PartType = %q, want %q", got, "text")
				}
				if got := question.Confidence; got != 0.93 {
					t.Fatalf("question.Confidence = %v, want 0.93", got)
				}
				if question.NeedsReview {
					t.Fatal("question.NeedsReview = true, want false")
				}
				if got := len(result.Groups); got != 1 {
					t.Fatalf("len(result.Groups) = %d, want 1", got)
				}
				if got := result.Groups[0].Title; got != "Section 1" {
					t.Fatalf("result.Groups[0].Title = %#v, want %q", got, "Section 1")
				}
				if got := len(result.VisualElements); got != 1 {
					t.Fatalf("len(result.VisualElements) = %d, want 1", got)
				}
				if got := result.VisualElements[0]["kind"]; got != "table" {
					t.Fatalf("result.VisualElements[0][kind] = %#v, want %q", got, "table")
				}
				if !reflect.DeepEqual(result.Warnings, []string{"Low-confidence OCR on item 3"}) {
					t.Fatalf("result.Warnings = %#v, want %#v", result.Warnings, []string{"Low-confidence OCR on item 3"})
				}
				if result.QualityScore != 91 {
					t.Fatalf("result.QualityScore = %v, want 91", result.QualityScore)
				}
			},
		},
		{
			name: "generate answer",
			path: "/internal/ai/generate-answer",
			requestBody: map[string]any{
				"questionId": float64(91),
				"stem":       "What is 2 + 2?",
				"answerMode": "choice",
				"options": []any{
					map[string]any{"label": "A", "content": "4"},
					map[string]any{"label": "B", "content": "5"},
				},
				"analysis": "Basic arithmetic",
			},
			responseBody: `{"answerPayload":{"correctOption":"A"},"canonicalAnswer":"4","explanation":"Adding two and two gives four.","steps":["Identify the operands","Add them together"],"confidence":0.82,"educationalValue":"Reinforces basic addition."}`,
			call: func(t *testing.T, client *Client, ctx context.Context) {
				result, err := client.GenerateAnswer(ctx, AnswerGenerationRequest{
					QuestionID: intPtr(91),
					Stem:       "What is 2 + 2?",
					AnswerMode: "choice",
					Options: []ParsedOption{
						{Label: "A", Content: "4"},
						{Label: "B", Content: "5"},
					},
					Analysis: "Basic arithmetic",
				})
				if err != nil {
					t.Fatalf("GenerateAnswer error = %v, want nil", err)
				}
				if result == nil {
					t.Fatal("GenerateAnswer result = nil, want value")
				}
				if got := result.AnswerPayload["correctOption"]; got != "A" {
					t.Fatalf("result.AnswerPayload[correctOption] = %#v, want %q", got, "A")
				}
				if result.CanonicalAnswer != "4" {
					t.Fatalf("result.CanonicalAnswer = %q, want %q", result.CanonicalAnswer, "4")
				}
				if result.Explanation != "Adding two and two gives four." {
					t.Fatalf("result.Explanation = %q, want %q", result.Explanation, "Adding two and two gives four.")
				}
				if !reflect.DeepEqual(result.Steps, []string{"Identify the operands", "Add them together"}) {
					t.Fatalf("result.Steps = %#v, want %#v", result.Steps, []string{"Identify the operands", "Add them together"})
				}
				if result.Confidence != 0.82 {
					t.Fatalf("result.Confidence = %v, want 0.82", result.Confidence)
				}
				if result.EducationalValue != "Reinforces basic addition." {
					t.Fatalf("result.EducationalValue = %q, want %q", result.EducationalValue, "Reinforces basic addition.")
				}
			},
		},
		{
			name: "learning report",
			path: "/internal/ai/learning-report",
			requestBody: map[string]any{
				"userId":            float64(7),
				"bankId":            float64(21),
				"practiceSessionId": float64(35),
				"scope":             "individual",
			},
			responseBody: `{"summary":"Solid arithmetic fundamentals with one weak spot.","mastery":[{"label":"Addition","score":0.92,"evidence":"Answered 11 of 12 addition questions correctly."}],"weakPoints":[{"label":"Fractions","reason":"Missed equivalent fraction questions.","suggestedAction":"Practice simplifying and comparing fractions."}],"recommendations":["Review fraction basics","Retry the last quiz tomorrow"],"riskLevel":"medium"}`,
			call: func(t *testing.T, client *Client, ctx context.Context) {
				result, err := client.LearningReport(ctx, LearningReportRequest{
					UserID:            intPtr(7),
					BankID:            intPtr(21),
					PracticeSessionID: intPtr(35),
					Scope:             "individual",
				})
				if err != nil {
					t.Fatalf("LearningReport error = %v, want nil", err)
				}
				if result == nil {
					t.Fatal("LearningReport result = nil, want value")
				}
				if result.Summary != "Solid arithmetic fundamentals with one weak spot." {
					t.Fatalf("result.Summary = %q, want expected summary", result.Summary)
				}
				if len(result.Mastery) != 1 {
					t.Fatalf("len(result.Mastery) = %d, want 1", len(result.Mastery))
				}
				if got := result.Mastery[0]["label"]; got != "Addition" {
					t.Fatalf("result.Mastery[0][label] = %#v, want %q", got, "Addition")
				}
				if got := result.Mastery[0]["evidence"]; got != "Answered 11 of 12 addition questions correctly." {
					t.Fatalf("result.Mastery[0][evidence] = %#v, want expected evidence", got)
				}
				if len(result.WeakPoints) != 1 {
					t.Fatalf("len(result.WeakPoints) = %d, want 1", len(result.WeakPoints))
				}
				if got := result.WeakPoints[0]["suggestedAction"]; got != "Practice simplifying and comparing fractions." {
					t.Fatalf("result.WeakPoints[0][suggestedAction] = %#v, want expected suggestion", got)
				}
				if !reflect.DeepEqual(result.Recommendations, []string{"Review fraction basics", "Retry the last quiz tomorrow"}) {
					t.Fatalf("result.Recommendations = %#v, want %#v", result.Recommendations, []string{"Review fraction basics", "Retry the last quiz tomorrow"})
				}
				if result.RiskLevel != "medium" {
					t.Fatalf("result.RiskLevel = %q, want %q", result.RiskLevel, "medium")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			const token = "test-ai-token"

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					t.Fatalf("method = %s, want %s", r.Method, http.MethodPost)
				}
				if r.URL.Path != tt.path {
					t.Fatalf("path = %q, want %q", r.URL.Path, tt.path)
				}
				if got := r.Header.Get("Content-Type"); got != "application/json" {
					t.Fatalf("Content-Type = %q, want application/json", got)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer "+token {
					t.Fatalf("Authorization = %q, want %q", got, "Bearer "+token)
				}

				body := decodeBodyMap(t, r.Body)
				if !reflect.DeepEqual(body, tt.requestBody) {
					t.Fatalf("request body = %#v, want %#v", body, tt.requestBody)
				}

				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tt.responseBody))
			}))
			defer server.Close()

			client := New(config.Config{AIServiceURL: server.URL + "/", AIServiceToken: token})
			client.httpClient = server.Client()

			tt.call(t, client, context.Background())
		})
	}
}

func TestClientRejectsSchemaInvalidJSONResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/ai/generate-answer" {
			t.Fatalf("path = %q, want %q", r.URL.Path, "/internal/ai/generate-answer")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"answerPayload":{"correctOption":"A"},"explanation":"Missing canonical answer should be rejected.","steps":["Look at the choices"],"confidence":0.61}`))
	}))
	defer server.Close()

	client := New(config.Config{AIServiceURL: server.URL, AIServiceToken: "test-ai-token"})
	client.httpClient = server.Client()

	result, err := client.GenerateAnswer(context.Background(), AnswerGenerationRequest{
		Stem:       "What is 2 + 2?",
		AnswerMode: "choice",
		Options:    []ParsedOption{{Label: "A", Content: "4"}},
	})
	if err == nil {
		t.Fatalf("GenerateAnswer error = nil, want schema validation error for missing canonicalAnswer (result = %#v)", result)
	}
}

func TestClientReturnsUsefulErrorForNon2xxAIResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}))
	defer server.Close()

	client := New(config.Config{AIServiceURL: server.URL, AIServiceToken: "test-ai-token"})
	client.httpClient = server.Client()

	_, err := client.ParseDocument(context.Background(), DocumentParseRequest{SourceType: "text", Text: "1. Test"})
	if err == nil {
		t.Fatal("ParseDocument error = nil, want upstream error")
	}
	if !strings.Contains(err.Error(), "/internal/ai/parse-document") {
		t.Fatalf("error = %q, want path context", err.Error())
	}
	if !strings.Contains(err.Error(), "502 Bad Gateway") {
		t.Fatalf("error = %q, want upstream status", err.Error())
	}
}

func decodeBodyMap(t *testing.T, body io.Reader) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
	return payload
}

func intPtr(value int) *int {
	return &value
}
