package httpserver

import "net/http"

type ReferenceHandlers struct {
	Subjects        http.Handler
	QuestionTypes   http.Handler
	KnowledgePoints http.Handler
}
