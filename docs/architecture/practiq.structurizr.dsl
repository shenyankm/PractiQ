workspace "PractiQ" "Evidence-backed current-state architecture of the PractiQ question-bank app; evidence index in architecture-understanding.md." {
  model {
    learner = person "Learner / Teacher" "Browses question banks, practices, imports documents, manages own content, and may join study groups."

    google = softwareSystem "Google OAuth" "External identity provider. PKCE S256 + nonce; verified google_sub; one-time Redis transaction; collision returns ACCOUNT_LINK_REQUIRED."
    revenuecatSdk = softwareSystem "RevenueCat" "Billing platform. Server-generated revenuecat_app_user_id; v2 Pro/organization entitlement checks; webhook lifecycle sync updates users.membership while trials remain time-based."
    llm = softwareSystem "LLM Providers" "DashScope, DeepSeek, and Moonshot through LangGraph and an OpenAI-compatible client; per-user pgcrypto-encrypted keys; model names configurable, base URLs fixed."

    practiq = softwareSystem "PractiQ" "Question-bank platform: bank/question management, AI-assisted document import, offline-capable practice, media content, tiered membership, and study groups." {
      mobile = container "Mobile App" "Expo React Native client. Expo Router screens; SQLite mirror (practiq-cache.db) at row granularity; offline outbox replayed with Idempotency-Key; RevenueCat SDK; bearer tokens in Secure Store." "React Native / Expo / SQLite"
      api = container "API Server" "FastAPI service. Typed REST /api/v1 routes and authenticated import SSE; middleware enforces request limits, security, rate limits, and idempotency; AI calls run in-process via LangGraph." "Python / FastAPI"
      worker = container "Import Worker" "Separate process (python -m server.worker). Claims import jobs with FOR UPDATE SKIP LOCKED, resumes LangGraph AI checkpoints, persists questions/groups, and emits durable events." "Python / asyncio"
      db = container "PostgreSQL" "Authoritative store: users, membership/trials, auth sessions, banks, questions, imports, LangGraph checkpoints, media, practice answers, and study groups. Schema under db/*/*.sql; triggers maintain stats." "PostgreSQL"
      redis = container "Redis" "Acceleration layer, not system of record: cache-aside, auth rate limits, Google OAuth one-time records, and Idempotency-Key cache." "Redis"
      storage = container "Object Storage" "Local storage mount for uploaded image assets; metadata lives in media_assets. Content-sniffed PNG/JPEG/GIF/WebP up to 10 MiB." "local mount"

      mobile -> api "Calls REST /api/v1 with bearer token and Idempotency-Key" "HTTPS / JSON"
      mobile -> revenuecatSdk "Purchases, restore, Customer Center via RevenueCat SDK" "HTTPS"
      api -> db "Reads and writes domain data" "SQL / psycopg async pool"
      api -> redis "Cache-aside, rate limits, OAuth transactions, idempotency" "RESP"
      worker -> db "Claims jobs, persists questions and events" "SQL"
      api -> storage "Uploads and serves protected image bytes" "local filesystem"
      api -> google "Browser OAuth redirects and token exchange" "HTTPS / OIDC"
      api -> revenuecatSdk "Syncs entitlements; receives lifecycle webhooks" "HTTPS / webhook"
      api -> llm "Parse documents, generate answers, learning reports" "LangGraph / HTTPS"
      worker -> llm "Runs resumable document parsing" "LangGraph / HTTPS"
    }

    learner -> practiq "Uses the app to practice and manage question banks"
    practiq -> google "Verifies Google identity" "HTTPS / OIDC"
    practiq -> revenuecatSdk "Syncs membership entitlement" "HTTPS / webhook"
    practiq -> llm "Runs AI document parsing and answer generation" "LangGraph / HTTPS"
  }

  views {
    systemContext practiq "system-context" {
      include *
      autolayout lr
    }

    container practiq "containers" {
      include *
      autolayout lr
    }

    theme default
  }
}
