package httpserver

import (
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"openwook/internal/api"
	"openwook/internal/services"
)

const publicCacheControl = "public, max-age=0, s-maxage=300, stale-while-revalidate=60"

func BuildReferenceHandlers(pool *pgxpool.Pool) ReferenceHandlers {
	return ReferenceHandlers{
		Subjects: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			data, err := services.ListSubjects(r.Context(), pool)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			w.Header().Set("Cache-Control", publicCacheControl)
			api.OK(w, r, data, nil)
		}),
		QuestionTypes: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			query := r.URL.Query()
			data, err := services.ListQuestionTypes(r.Context(), pool, query.Get("subject"), query.Get("scope"))
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			w.Header().Set("Cache-Control", publicCacheControl)
			api.OK(w, r, data, nil)
		}),
		KnowledgePoints: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			query := r.URL.Query()
			limit, err := queryPageLimit(r, 200)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			var parentID *int64
			if raw := query.Get("parentId"); raw != "" {
				parsed, parseErr := strconv.ParseInt(raw, 10, 64)
				if parseErr != nil || parsed <= 0 {
					api.HandleError(w, r, api.NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid parentId", nil))
					return
				}
				parentID = &parsed
			}
			data, err := services.ListKnowledgePoints(
				r.Context(),
				pool,
				query.Get("subject"),
				parentID,
				query.Get("q"),
				query.Get("cursor"),
				limit,
			)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			w.Header().Set("Cache-Control", publicCacheControl)
			api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
		}),
	}
}
