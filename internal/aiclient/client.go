package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"openwook/internal/config"
)

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func New(cfg config.Config) *Client {
	return &Client{baseURL: strings.TrimRight(cfg.AIServiceURL, "/"), token: cfg.AIServiceToken, httpClient: http.DefaultClient}
}

func (c *Client) ParseDocument(ctx context.Context, payload DocumentParseRequest) (*DocumentParseResult, error) {
	var result DocumentParseResult
	if err := c.postJSON(ctx, "/internal/ai/parse-document", payload, &result); err != nil {
		return nil, err
	}
	if err := validateDocumentParseResult(result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) GenerateAnswer(ctx context.Context, payload AnswerGenerationRequest) (*AnswerGenerationResult, error) {
	var result AnswerGenerationResult
	if err := c.postJSON(ctx, "/internal/ai/generate-answer", payload, &result); err != nil {
		return nil, err
	}
	if err := validateAnswerGenerationResult(result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) LearningReport(ctx context.Context, payload LearningReportRequest) (*LearningReportResult, error) {
	var result LearningReportResult
	if err := c.postJSON(ctx, "/internal/ai/learning-report", payload, &result); err != nil {
		return nil, err
	}
	if err := validateLearningReportResult(result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("ai service %s returned %s", path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

func validateDocumentParseResult(result DocumentParseResult) error {
	if len(result.Questions) == 0 {
		return fmt.Errorf("document parse response missing questions")
	}
	for _, question := range result.Questions {
		if question.Stem == "" || question.AnswerMode == "" || question.QuestionTypeID == "" {
			return fmt.Errorf("document parse response contains incomplete question")
		}
	}
	return nil
}

func validateAnswerGenerationResult(result AnswerGenerationResult) error {
	if len(result.AnswerPayload) == 0 || result.CanonicalAnswer == "" || result.Explanation == "" || len(result.Steps) == 0 {
		return fmt.Errorf("answer generation response is missing required fields")
	}
	return nil
}

func validateLearningReportResult(result LearningReportResult) error {
	if result.Summary == "" || len(result.Recommendations) == 0 || result.RiskLevel == "" {
		return fmt.Errorf("learning report response is missing required fields")
	}
	return nil
}
