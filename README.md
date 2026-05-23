# OpenWook - Full-Stack Next.js Application

A complete full-stack application built with Next.js 16, PostgreSQL, and shadcn/ui.

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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
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
