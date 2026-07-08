package api

import "testing"

func mustValidateQuestionPayload(t *testing.T, body []byte) {
	t.Helper()
	if err := ValidateQuestionPayload(body); err != nil {
		t.Fatalf("ValidateQuestionPayload returned error: %v", err)
	}
}

func mustValidateQuestionUpdatePayload(t *testing.T, body []byte) {
	t.Helper()
	if err := ValidateQuestionUpdatePayload(body); err != nil {
		t.Fatalf("ValidateQuestionUpdatePayload returned error: %v", err)
	}
}

func mustValidateImportJobPayload(t *testing.T, body []byte) {
	t.Helper()
	if err := ValidateImportJobPayload(body); err != nil {
		t.Fatalf("ValidateImportJobPayload returned error: %v", err)
	}
}

func mustValidateImportChildKind(t *testing.T, kind string) {
	t.Helper()
	if err := ValidateImportChildKind(kind); err != nil {
		t.Fatalf("ValidateImportChildKind(%s) returned error: %v", kind, err)
	}
}

func mustValidateAIDocumentParsePayload(t *testing.T, body []byte) {
	t.Helper()
	if err := ValidateAIDocumentParsePayload(body); err != nil {
		t.Fatalf("ValidateAIDocumentParsePayload returned error: %v", err)
	}
}

func TestQuestionRequestAnswerModes(t *testing.T) {

	cases := []struct {
		name string
		body []byte
	}{
		{
			name: "choice",
			body: []byte(`{"questionTypeId":"multiple-choice","answerMode":"choice","stem":"What is 2 + 2?"}`),
		},
		{
			name: "true_false",
			body: []byte(`{"questionTypeId":"true-false","answerMode":"true_false","stem":"The sky is blue."}`),
		},
		{
			name: "fill_blank",
			body: []byte(`{"questionTypeId":"fill-blank","answerMode":"fill_blank","stem":"2 + 2 = ____"}`),
		},
		{
			name: "short_answer",
			body: []byte(`{"questionTypeId":"short-answer","answerMode":"short_answer","stem":"Explain photosynthesis."}`),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mustValidateQuestionPayload(t, tc.body)
		})
	}
}

func TestQuestionUpdateRequestStatuses(t *testing.T) {
	statuses := []string{"draft", "active", "archived"}
	for _, status := range statuses {
		t.Run(status, func(t *testing.T) {
			body := []byte(`{"status":"` + status + `"}`)
			mustValidateQuestionUpdatePayload(t, body)
		})
	}
}

func TestImportChildKinds(t *testing.T) {
	kinds := []string{"events", "pages", "blocks", "review-items", "outputs", "artifacts"}
	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			mustValidateImportChildKind(t, kind)
		})
	}
}

func TestAISourceTypesForPublicInputs(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{
			name: "docx",
			body: []byte(`{"importJobId":1,"bankId":2,"sourceType":"docx","fileName":"questions.docx","fileBase64":"UEsDBA==","mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}`),
		},
		{
			name: "txt",
			body: []byte(`{"importJobId":1,"bankId":2,"sourceType":"txt","fileName":"questions.txt","text":"1. What is 2+2?"}`),
		},
		{
			name: "text",
			body: []byte(`{"importJobId":1,"bankId":2,"sourceType":"text","fileName":"questions.txt","text":"1. What is 2+2?"}`),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mustValidateImportJobPayload(t, []byte(`{"fileName":"source","sourceType":"`+tc.name+`"}`))
			mustValidateAIDocumentParsePayload(t, tc.body)
		})
	}
}

func TestInvalidAnswerModeUsesValidationEnvelopeShape(t *testing.T) {
	err := ValidateQuestionPayload([]byte(`{"questionTypeId":"multiple-choice","answerMode":"essay","stem":"What is 2 + 2?"}`))
	if err == nil {
		t.Fatal("ValidateQuestionPayload accepted invalid answerMode")
	}

	status, code, message, details := ValidationErrorEnvelope(err)
	if status != 422 {
		t.Fatalf("status = %d, want 422", status)
	}
	if code != "VALIDATION_ERROR" {
		t.Fatalf("code = %q, want %q", code, "VALIDATION_ERROR")
	}
	if message != "Invalid request" {
		t.Fatalf("message = %q, want %q", message, "Invalid request")
	}

	var matched bool
	for _, detail := range details {
		if detail["field"] == "answerMode" {
			matched = true
			if detail["message"] == "" {
				t.Fatal("validation detail for answerMode must include a non-empty message")
			}
		}
	}

	if !matched {
		t.Fatalf("validation details = %#v, want entry with field %q", details, "answerMode")
	}
}
