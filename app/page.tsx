import { query } from "@/lib/db";
import type { User } from "@/lib/types";
import { UserFormWrapper, UserListWrapper } from "@/components/user-client";
import { HealthStatus } from "@/components/health-status";

export default async function Home() {
  let users: User[] = [];
  let dbError: string | null = null;

  try {
    const { rows } = await query<User>(
      `SELECT id, name, email, created_at 
       FROM users 
       ORDER BY created_at DESC 
       LIMIT 100`
    );
    users = rows;
  } catch (error) {
    dbError = error instanceof Error ? error.message : "Database error";
    console.error("Failed to fetch users:", error);
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-foreground">
              OpenWook Full-Stack App
            </h1>
            <p className="text-sm text-muted-foreground">
              Next.js 16 + PostgreSQL + shadcn/ui
            </p>
          </div>
          <HealthStatus />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {dbError && (
          <div className="mb-6 rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
            <strong>Database Error:</strong> {dbError}
            <p className="mt-1">
              Please ensure your PostgreSQL database is running and the
              DATABASE_URL in .env.local is correct. Run the SQL setup script to
              create the users table.
            </p>
          </div>
        )}

        <div className="grid gap-8 md:grid-cols-2">
          <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-foreground">
              Create User (Email Verified)
            </h2>
            <UserFormWrapper />
          </section>

          <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-foreground">
              Users ({users.length})
            </h2>
            <UserListWrapper initialUsers={users} />
          </section>
        </div>

        <section className="mt-8 rounded-lg border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            API Endpoints
          </h2>
          <div className="grid gap-4 font-mono text-sm md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-muted-foreground">Health Check:</p>
              <code className="block rounded bg-muted px-3 py-2 text-foreground">
                GET /api/health
              </code>
            </div>
            <div className="space-y-2">
              <p className="text-muted-foreground">List Users:</p>
              <code className="block rounded bg-muted px-3 py-2 text-foreground">
                GET /api/users
              </code>
            </div>
            <div className="space-y-2">
              <p className="text-muted-foreground">Create User:</p>
              <code className="block rounded bg-muted px-3 py-2 text-foreground">
                POST /api/users
              </code>
            </div>
            <div className="space-y-2">
              <p className="text-muted-foreground">Send Email Code:</p>
              <code className="block rounded bg-muted px-3 py-2 text-foreground">
                POST /api/verify-email
              </code>
            </div>
            <div className="space-y-2">
              <p className="text-muted-foreground">Get/Update/Delete User:</p>
              <code className="block rounded bg-muted px-3 py-2 text-foreground">
                GET/PUT/DELETE /api/users/:id
              </code>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
