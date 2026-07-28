package httpserver

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"practiq/internal/auth"
)

func BuildAuthHandlers(pool *pgxpool.Pool) AuthHandlers {
	return AuthHandlers{
		Register: auth.Register(auth.HandlerDependencies{
			RegisterUser: func(ctx context.Context, username string, email *string, password string) (*auth.User, error) {
				return auth.RegisterUser(ctx, pool, username, email, password)
			},
			SetSession: auth.SetSession,
		}),
		Login: auth.Login(auth.HandlerDependencies{
			AuthenticateUser: func(ctx context.Context, login string, password string) (*auth.User, error) {
				return auth.AuthenticateUser(ctx, pool, login, password)
			},
			SetSession: auth.SetSession,
		}),
		Logout: auth.Logout(auth.HandlerDependencies{ClearSession: auth.ClearSession}),
		Me:     auth.Me(auth.HandlerDependencies{CurrentUser: auth.CurrentUserFromRequest(pool)}),
		UpdateMe: auth.UpdateMe(auth.HandlerDependencies{
			CurrentUser: auth.CurrentUserFromRequest(pool),
			UpdateUser: func(ctx context.Context, userID int, input auth.UpdateUserInput) (*auth.User, error) {
				return auth.UpdateUser(ctx, pool, userID, input)
			},
		}),
	}
}
