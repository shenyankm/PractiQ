package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"


	"openwook/internal/auth"
	"openwook/internal/services"
)

func TestNewServerRegistersAuthAdminAndMediaRoutes(t *testing.T) {
	tests := []struct {
		name       string
		deps       ServerDependencies
		method     string
		target     string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "auth register",
			deps:       ServerDependencies{Auth: AuthHandlers{Register: routeSliceStubHandler(http.StatusCreated, "auth-register")}},
			method:     http.MethodPost,
			target:     "/api/v1/auth/register",
			wantStatus: http.StatusCreated,
			wantBody:   "auth-register",
		},
		{
			name:       "auth login",
			deps:       ServerDependencies{Auth: AuthHandlers{Login: routeSliceStubHandler(http.StatusOK, "auth-login")}},
			method:     http.MethodPost,
			target:     "/api/v1/auth/login",
			wantStatus: http.StatusOK,
			wantBody:   "auth-login",
		},
		{
			name:       "auth logout",
			deps:       ServerDependencies{Auth: AuthHandlers{Logout: routeSliceStubHandler(http.StatusNoContent, "")}},
			method:     http.MethodPost,
			target:     "/api/v1/auth/logout",
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "auth me",
			deps:       ServerDependencies{Auth: AuthHandlers{Me: routeSliceStubHandler(http.StatusOK, "auth-me")}},
			method:     http.MethodGet,
			target:     "/api/v1/auth/me",
			wantStatus: http.StatusOK,
			wantBody:   "auth-me",
		},
		{
			name:       "admin overview",
			deps:       ServerDependencies{Admin: AdminHandlers{Overview: routeSliceStubHandler(http.StatusOK, "admin-overview")}},
			method:     http.MethodGet,
			target:     "/api/v1/admin/overview",
			wantStatus: http.StatusOK,
			wantBody:   "admin-overview",
		},
		{
			name:       "admin users",
			deps:       ServerDependencies{Admin: AdminHandlers{Users: routeSliceStubHandler(http.StatusOK, "admin-users")}},
			method:     http.MethodGet,
			target:     "/api/v1/admin/users",
			wantStatus: http.StatusOK,
			wantBody:   "admin-users",
		},
		{
			name:       "admin knowledge points",
			deps:       ServerDependencies{Admin: AdminHandlers{KnowledgePoints: routeSliceStubHandler(http.StatusOK, "admin-knowledge-points")}},
			method:     http.MethodGet,
			target:     "/api/v1/admin/knowledge-points",
			wantStatus: http.StatusOK,
			wantBody:   "admin-knowledge-points",
		},
		{
			name:       "user status",
			deps:       ServerDependencies{Admin: AdminHandlers{SetUserStatus: routeSliceStubHandler(http.StatusOK, "user-status")}},
			method:     http.MethodPatch,
			target:     "/api/v1/users/17/status",
			wantStatus: http.StatusOK,
			wantBody:   "user-status",
		},
		{
			name:       "user access",
			deps:       ServerDependencies{Admin: AdminHandlers{UpdateUserAccess: routeSliceStubHandler(http.StatusOK, "user-access")}},
			method:     http.MethodPatch,
			target:     "/api/v1/users/17/access",
			wantStatus: http.StatusOK,
			wantBody:   "user-access",
		},
		{
			name:       "knowledge point create",
			deps:       ServerDependencies{Admin: AdminHandlers{CreateKnowledgePoint: routeSliceStubHandler(http.StatusCreated, "knowledge-point-create")}},
			method:     http.MethodPost,
			target:     "/api/v1/knowledge-points",
			wantStatus: http.StatusCreated,
			wantBody:   "knowledge-point-create",
		},
		{
			name:       "knowledge point update",
			deps:       ServerDependencies{Admin: AdminHandlers{UpdateKnowledgePoint: routeSliceStubHandler(http.StatusOK, "knowledge-point-update")}},
			method:     http.MethodPatch,
			target:     "/api/v1/knowledge-points/9",
			wantStatus: http.StatusOK,
			wantBody:   "knowledge-point-update",
		},
		{
			name:       "media create",
			deps:       ServerDependencies{Media: MediaHandlers{Create: routeSliceStubHandler(http.StatusCreated, "media-create")}},
			method:     http.MethodPost,
			target:     "/api/v1/media",
			wantStatus: http.StatusCreated,
			wantBody:   "media-create",
		},
		{
			name:       "media get",
			deps:       ServerDependencies{Media: MediaHandlers{Get: routeSliceStubHandler(http.StatusOK, "media-get")}},
			method:     http.MethodGet,
			target:     "/api/v1/media/11",
			wantStatus: http.StatusOK,
			wantBody:   "media-get",
		},
		{
			name:       "media delete",
			deps:       ServerDependencies{Media: MediaHandlers{Delete: routeSliceStubHandler(http.StatusNoContent, "")}},
			method:     http.MethodDelete,
			target:     "/api/v1/media/11",
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "question media link",
			deps:       ServerDependencies{Media: MediaHandlers{LinkQuestion: routeSliceStubHandler(http.StatusCreated, "question-media-link")}},
			method:     http.MethodPost,
			target:     "/api/v1/questions/3/media-links",
			wantStatus: http.StatusCreated,
			wantBody:   "question-media-link",
		},
		{
			name:       "group media link",
			deps:       ServerDependencies{Media: MediaHandlers{LinkGroup: routeSliceStubHandler(http.StatusCreated, "group-media-link")}},
			method:     http.MethodPost,
			target:     "/api/v1/groups/4/media-links",
			wantStatus: http.StatusCreated,
			wantBody:   "group-media-link",
		},
		{
			name:       "option media link",
			deps:       ServerDependencies{Media: MediaHandlers{LinkOption: routeSliceStubHandler(http.StatusCreated, "option-media-link")}},
			method:     http.MethodPost,
			target:     "/api/v1/options/5/media-links",
			wantStatus: http.StatusCreated,
			wantBody:   "option-media-link",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := newRouteSliceServerUnderTest(t, tt.deps)

			rr := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "https://app.example.test"+tt.target, nil)

			handler.ServeHTTP(rr, req)

			if rr.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rr.Code, tt.wantStatus)
			}
			if got := rr.Body.String(); got != tt.wantBody {
				t.Fatalf("body = %q, want %q", got, tt.wantBody)
			}
		})
	}
}

func TestNewServerUsesMethodSpecificRouteRegistrationForSharedPaths(t *testing.T) {
	handler := newRouteSliceServerUnderTest(t, ServerDependencies{
		Reference: ReferenceHandlers{
			KnowledgePoints: routeSliceStubHandler(http.StatusOK, "reference-knowledge-points"),
		},
		Admin: AdminHandlers{
			CreateKnowledgePoint: routeSliceStubHandler(http.StatusCreated, "admin-create-knowledge-point"),
		},
		Media: MediaHandlers{
			Get: routeSliceStubHandler(http.StatusOK, "media-get"),
		},
	})

	t.Run("GET knowledge points stays on reference route", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://app.example.test/api/v1/knowledge-points", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
		}
		if got := rr.Body.String(); got != "reference-knowledge-points" {
			t.Fatalf("body = %q, want %q", got, "reference-knowledge-points")
		}
	})

	t.Run("POST knowledge points stays on admin route", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/knowledge-points", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusCreated {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusCreated)
		}
		if got := rr.Body.String(); got != "admin-create-knowledge-point" {
			t.Fatalf("body = %q, want %q", got, "admin-create-knowledge-point")
		}
	})

	t.Run("unsupported method falls through to api not found", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/media/11", nil)

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusNotFound)
		}
	})
}

func TestBuildAdminAndMediaHandlersKeepValidationTight(t *testing.T) {
	t.Run("set user status rejects invalid path ids before calling service", func(t *testing.T) {
		handler := RequestID(buildAdminHandlers(adminRouteDependencies{
			currentUser: func(*http.Request) (*auth.User, error) {
				return &auth.User{ID: 7, Username: "alice", IsActive: true, Role: "admin"}, nil
			},
			setUserStatus: func(context.Context, auth.User, int64, bool) (*services.UserRecord, error) {
				t.Fatal("setUserStatus should not be called")
				return nil, nil
			},
		}).SetUserStatus)

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPatch, "https://app.example.test/api/v1/users/nope/status", strings.NewReader(`{"isActive":true}`))

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusUnprocessableEntity)
		}
		body := decodeJSONBody(t, rr.Body.Bytes())
		errorBody := mustObject(t, body["error"], "error")
		if got := errorBody["code"]; got != "VALIDATION_ERROR" {
			t.Fatalf("error.code = %#v, want %q", got, "VALIDATION_ERROR")
		}
		if got := errorBody["message"]; got != "Invalid userId" {
			t.Fatalf("error.message = %#v, want %q", got, "Invalid userId")
		}
	})

	t.Run("media create rejects unknown JSON fields", func(t *testing.T) {
		handler := RequestID(buildMediaHandlers(mediaRouteDependencies{
			currentUser: func(*http.Request) (*auth.User, error) {
				return &auth.User{ID: 7, Username: "alice", IsActive: true}, nil
			},
			createMediaAsset: func(context.Context, services.CreateMediaAssetInput) (*services.MediaAsset, error) {
				t.Fatal("createMediaAsset should not be called")
				return nil, nil
			},
		}).Create)

		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://app.example.test/api/v1/media", strings.NewReader(`{"storagePath":"oss://media/1","extra":true}`))

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rr.Code, http.StatusBadRequest)
		}
		body := decodeJSONBody(t, rr.Body.Bytes())
		errorBody := mustObject(t, body["error"], "error")
		if got := errorBody["code"]; got != "INVALID_JSON" {
			t.Fatalf("error.code = %#v, want %q", got, "INVALID_JSON")
		}
	})
}

func newRouteSliceServerUnderTest(t *testing.T, deps ServerDependencies) http.Handler {
	t.Helper()

	distDir := t.TempDir()
	writeServerTestFile(t, distDir, "index.html", "<!doctype html><html><body>placeholder</body></html>")

	deps.CheckPostgres = func(context.Context) error { return nil }
	deps.CheckRedis = func(context.Context) (bool, error) { return true, nil }
	deps.MetricsHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	deps.UptimeSeconds = func() int64 { return 1 }

	return NewServer(ServerConfig{
		NodeEnv:   "test",
		AppOrigin: "https://app.example.test",
		DistDir:   distDir,
	}, deps)
}

func routeSliceStubHandler(status int, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
}
