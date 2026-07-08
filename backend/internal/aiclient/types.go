package aiclient

type DocumentParseRequest struct {
	ImportJobID *int   `json:"importJobId,omitempty"`
	BankID      *int   `json:"bankId,omitempty"`
	SourceType  string `json:"sourceType"`
	FileName    string `json:"fileName,omitempty"`
	Text        string `json:"text,omitempty"`
	FileBase64  string `json:"fileBase64,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

type ParsedOption struct {
	Label     string `json:"label"`
	Content   string `json:"content"`
	IsCorrect bool   `json:"isCorrect,omitempty"`
}

type ContentBlock struct {
	PartType      string         `json:"partType"`
	Role          string         `json:"role,omitempty"`
	TextValue     string         `json:"textValue,omitempty"`
	MarkdownValue string         `json:"markdownValue,omitempty"`
	LatexValue    string         `json:"latexValue,omitempty"`
	JSONValue     map[string]any `json:"jsonValue,omitempty"`
}

type ParsedQuestion struct {
	Stem           string         `json:"stem"`
	AnswerMode     string         `json:"answerMode"`
	QuestionTypeID string         `json:"questionTypeId"`
	Options        []ParsedOption `json:"options"`
	AnswerPayload  map[string]any `json:"answerPayload,omitempty"`
	Analysis       string         `json:"analysis,omitempty"`
	ContentBlocks  []ContentBlock `json:"contentBlocks"`
	SourceText     string         `json:"sourceText,omitempty"`
	Confidence     float64        `json:"confidence"`
	NeedsReview    bool           `json:"needsReview"`
}

type DocumentParseResult struct {
	Questions      []ParsedQuestion `json:"questions"`
	Groups         []map[string]any `json:"groups"`
	VisualElements []map[string]any `json:"visualElements"`
	Warnings       []string         `json:"warnings"`
	QualityScore   float64          `json:"qualityScore"`
}

type AnswerGenerationRequest struct {
	QuestionID *int           `json:"questionId,omitempty"`
	Stem       string         `json:"stem"`
	AnswerMode string         `json:"answerMode"`
	Options    []ParsedOption `json:"options,omitempty"`
	Analysis   string         `json:"analysis,omitempty"`
}

type AnswerGenerationResult struct {
	AnswerPayload    map[string]any `json:"answerPayload"`
	CanonicalAnswer  string         `json:"canonicalAnswer"`
	Explanation      string         `json:"explanation"`
	Steps            []string       `json:"steps"`
	Confidence       float64        `json:"confidence"`
	EducationalValue string         `json:"educationalValue,omitempty"`
}

type LearningReportRequest struct {
	UserID            *int   `json:"userId,omitempty"`
	BankID            *int   `json:"bankId,omitempty"`
	PracticeSessionID *int   `json:"practiceSessionId,omitempty"`
	Scope             string `json:"scope"`
}

type LearningReportResult struct {
	Summary         string           `json:"summary"`
	Mastery         []map[string]any `json:"mastery"`
	WeakPoints      []map[string]any `json:"weakPoints"`
	Recommendations []string         `json:"recommendations"`
	RiskLevel       string           `json:"riskLevel"`
}
