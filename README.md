# OpenWook - Full-Stack Next.js Application

A complete full-stack application built with Next.js 16, PostgreSQL, and shadcn/ui.

## Product Design

The question-bank product design based on `db/schema.sql` is documented in [docs/system-design.md](docs/system-design.md). It covers the REST API surface, frontend pages, core modules, data flows, validation, errors, and implementation roadmap.

## Tech Stack

- **Framework**: Next.js 16.2.6 (App Router)
- **Language**: TypeScript
- **Database**: PostgreSQL (via `pg` driver)
- **UI**: shadcn/ui + Tailwind CSS v4
- **Styling**: CSS Variables + oklch color system

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Set Up Database

Create a `.env.local` file (or modify the existing one):

```env
DATABASE_URL=postgresql://username:password@localhost:5432/openwook
```

Then run the initialization script:

```bash
psql $DATABASE_URL -f scripts/init-db.sql
```

### 3. Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check with DB status |
| GET | `/api/users` | List all users |
| POST | `/api/users` | Create a new user |
| GET | `/api/users/:id` | Get user by ID |
| PUT | `/api/users/:id` | Update user |
| DELETE | `/api/users/:id` | Delete user |

## Project Structure

```
├── app/                    # Next.js App Router
│   ├── api/               # API Routes
│   │   ├── health/        # Health check endpoint
│   │   └── users/         # CRUD user endpoints
│   ├── globals.css        # Global styles + shadcn theme
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Home page
├── components/            # React Components
│   ├── ui/               # shadcn/ui components
│   ├── health-status.tsx # Health check component
│   ├── user-form.tsx     # User creation form
│   ├── user-list.tsx     # User list display
│   └── user-client.tsx   # Client-side wrappers
├── lib/                   # Utilities & Config
│   ├── db.ts             # PostgreSQL connection pool
│   ├── types.ts          # TypeScript interfaces
│   └── utils.ts          # Helper functions (cn)
├── scripts/
│   └── init-db.sql       # Database schema
├── .env.local            # Environment variables
├── next.config.ts        # Next.js configuration
└── components.json       # shadcn/ui configuration
```

## Database Configuration

The database connection uses a singleton pattern with connection pooling:

- **Max connections**: 20
- **Idle timeout**: 30s
- **Connection timeout**: 2s
- **Transactions**: Supported via `transaction()` helper

## Redis, Caching, and Import Workers

OpenWook uses PostgreSQL as the source of truth and Redis as an optional acceleration and coordination layer.

Redis-backed features:

- Short-TTL cache for reference data, user profiles, bank lists/items, question detail, answer keys, and analytics summaries.
- JWT session revocation on logout through `jti` blacklist keys.
- Login/register rate limiting.
- Stable practice-session question queues and duplicate answer submission protection.
- BullMQ import queue for long-running document parsing jobs.
- Redis Pub/Sub + SSE for live import progress events.
- AI result de-duplication cache, bank leaderboard cache, and analytics snapshot cache.

Start Redis locally:

```bash
docker run --name openwook-redis -p 6379:6379 -d redis:7-alpine redis-server --appendonly yes
```

Set environment variables:

```env
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=openwook
IMPORT_WORKER_CONCURRENCY=2
IMPORT_QUEUE_ATTEMPTS=3
AI_CACHE_TTL_SECONDS=86400
LEADERBOARD_CACHE_TTL_SECONDS=60
```

Run the Next.js app and the import worker in separate processes:

```bash
pnpm dev
pnpm worker:imports
```

Production deployments should run the worker as a separate process. A systemd template is provided at `openwook-import-worker.service`.

Health check:

```text
GET /api/health
```

Redis cache failures degrade to PostgreSQL reads. Queue, lock, and live-progress features require `REDIS_URL`.

## Object Storage

OpenWook stores uploaded avatars and import source files through a mounted object-storage directory. PostgreSQL keeps the object URL, while the mounted path is used only by the server to write or read the original file.

Set environment variables:

```env
OBJECT_STORAGE_MOUNT_DIR=/lhcos-data
OSS_PUBLIC_BASE_URL=https://<bucket>.cos.<region>.myqcloud.com
OSS_URL_PREFIX=oss://openwook
AVATAR_MAX_BYTES=5242880
IMPORT_SOURCE_MAX_BYTES=26214400
```

If `OSS_PUBLIC_BASE_URL` is set, user avatars are stored in PostgreSQL as browser-usable HTTPS object URLs. If it is omitted, OpenWook stores `OSS_URL_PREFIX` URLs such as `oss://openwook/avatars/...`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string for cache, rate limits, queue, locks, and SSE |
| `REDIS_KEY_PREFIX` | Optional Redis key namespace prefix |
| `IMPORT_WORKER_CONCURRENCY` | Number of import jobs processed per worker |
| `IMPORT_QUEUE_ATTEMPTS` | BullMQ retry attempts for import jobs |
| `AI_CACHE_TTL_SECONDS` | TTL for repeated AI parse/answer cache entries |
| `LEADERBOARD_CACHE_TTL_SECONDS` | TTL for bank leaderboard cache entries |
| `OBJECT_STORAGE_MOUNT_DIR` | Local mount path for the object-storage bucket |
| `OSS_PUBLIC_BASE_URL` | Public bucket URL used for persisted avatar and source-file URLs |
| `OSS_URL_PREFIX` | Fallback object URL prefix when no public bucket URL is configured |
| `AVATAR_MAX_BYTES` | Max uploaded avatar size in bytes |
| `IMPORT_SOURCE_MAX_BYTES` | Max uploaded TXT/DOCX source size in bytes |
| `NEXT_PUBLIC_APP_URL` | Public app URL |
| `API_SECRET_KEY` | API authentication key |

## Features

- **Server Components**: Data fetching on the server
- **Client Components**: Interactive UI with React hooks
- **API Routes**: RESTful endpoints with proper error handling
- **Type Safety**: Full TypeScript coverage
- **Health Checks**: Real-time system status monitoring
- **Database Pooling**: Efficient connection management
- **CORS Headers**: Configured for API routes
- **shadcn/ui Theme**: Light/dark mode support

## License

MIT
