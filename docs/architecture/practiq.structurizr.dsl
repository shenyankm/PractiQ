workspace "PractiQ" "Evidence-backed current-state architecture; evidence index in architecture-understanding.md." {
  model {
    learner = person "Learner / Teacher" "Future user of restored bank, practice, import, and study-group flows."

    revenuecat = softwareSystem "RevenueCat" "Billing entitlement and webhook platform."
    llm = softwareSystem "LLM Providers" "DashScope, DeepSeek, and Moonshot."

    practiq = softwareSystem "PractiQ" "Question-bank platform with a Taro frontend baseline and unified FastAPI backend." {
      client = container "Taro Client" "WeChat Mini Program compile/run baseline while business flows are restored." "Taro 4 / React 18"
      api = container "API Server" "FastAPI REST /api/v1 routes and authenticated import SSE; middleware enforces request limits, security, rate limits, and idempotency." "Python / FastAPI"
      worker = container "Import Worker" "Claims import jobs, resumes LangGraph checkpoints, persists questions/groups, and emits durable events." "Python / asyncio"
      db = container "PostgreSQL" "Authoritative users, membership, sessions, banks, questions, imports, media, practice, and study-group data." "PostgreSQL"
      redis = container "Redis" "Cache-aside, email codes, rate limits, and Idempotency-Key cache." "Redis"
      storage = container "Object Storage" "Local mount for uploaded image assets; metadata lives in PostgreSQL." "local mount"

      api -> db "Reads and writes domain data" "SQL / psycopg async pool"
      api -> redis "Cache, rate limits, idempotency" "RESP"
      worker -> db "Claims jobs and persists questions/events" "SQL"
      api -> storage "Uploads and serves protected image bytes" "local filesystem"
      api -> revenuecat "Syncs entitlements; receives webhooks" "HTTPS / webhook"
      api -> llm "Generates answers and reports" "LangGraph / HTTPS"
      worker -> llm "Runs resumable document parsing" "LangGraph / HTTPS"
    }

    learner -> practiq "Uses the platform"
    practiq -> revenuecat "Syncs membership entitlement" "HTTPS / webhook"
    practiq -> llm "Runs AI workflows" "HTTPS"
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
