package httpserver

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"practiq/internal/api"
	"practiq/internal/auth"
	"practiq/internal/services"
)

func BuildAnalyticsHandlers(pool *pgxpool.Pool, resolve auth.CurrentUserResolver) AnalyticsHandlers {
	return AnalyticsHandlers{
		MeSummary: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetAnalyticsSummary(r.Context(), pool, user)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		MeSnapshot: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetUserStatsSnapshot(r.Context(), pool, user)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Bank: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			bankID, err := parsePathID(r, "bankId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetBankAnalytics(r.Context(), pool, user, bankID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		BankLeaderboard: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			bankID, err := parsePathID(r, "bankId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			limit := 20
			if parsed, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("limit"))); err == nil {
				limit = parsed
			}
			data, err := services.GetBankLeaderboard(r.Context(), pool, user, bankID, limit)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
		Import: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := auth.RequireUser(r, resolve)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			jobID, err := parsePathID(r, "jobId")
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			data, err := services.GetImportAnalytics(r.Context(), pool, user, jobID)
			if err != nil {
				api.HandleError(w, r, err)
				return
			}
			api.OK(w, r, data, nil)
		}),
	}
}
