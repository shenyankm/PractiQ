package httpserver

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

func BuildSearchHandlers(pool *pgxpool.Pool, resolve auth.CurrentUserResolver) SearchHandlers {
	return SearchHandlers{
		Kind: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.Search(r.Context(), pool, *user, r.PathValue("kind"), r.URL.Query())
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data.Items, paginationMeta(data.PageInfo))
		}),
	}
}
