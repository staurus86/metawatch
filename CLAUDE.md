# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev          # start with nodemon auto-reload (dev)
npm start            # start production server
```

Copy `.env.example` to `.env` and fill in `DATABASE_URL` before running.
Set `JWT_SECRET` for persistent auth sessions across restarts.

## Architecture

MetaWatch v2 is a Node.js/Express server-rendered app (EJS) for monitoring website metadata changes.
Features: authentication, multi-channel alerts (email/Telegram/webhook), bulk import, XLSX export, charts, SSE progress, admin panel, reference snapshots, word-level diffs.

### Startup flow (`src/index.js`)
1. `migrate()` — creates/alters all tables (idempotent)
2. `startScheduler()` — loads active URLs from DB, creates one cron job per URL
3. `app.listen()` — starts HTTP server

### Core modules

| File | Responsibility |
|------|---------------|
| `src/db.js` | `pg.Pool` singleton; reads `DATABASE_URL`; SSL auto-detected for Railway |
| `src/migrate.js` | Creates/alters tables: `users`, `invites`, `projects`, `monitored_urls`, `snapshots`, `alerts` |
| `src/auth.js` | JWT cookie auth; `loadUserMiddleware`, `requireAuth`, `requireAdmin`, `requireApiKey` |
| `src/scraper.js` | `scrapeUrl(url, {userAgent, customText})` → axios + cheerio; OG, hreflang, custom text; 3-attempt retry |
| `src/checker.js` | `checkUrl(urlId)` — reference snapshot comparison, ignore numbers, calls notifier |
| `src/scheduler.js` | Cron jobs per URL; Semaphore for max 5 concurrent checks |
| `src/notifier.js` | Unified dispatch: email + Telegram + webhook |
| `src/mailer.js` | `sendAlert()` — silently no-ops if `SMTP_HOST` not set |
| `src/queue.js` | `Semaphore` class + `domainRateLimit` (1s/domain) + `checkSemaphore` (max 5) |
| `src/scan-events.js` | EventEmitter for SSE scan-all progress streaming |

### Auth System
- JWT in HTTP-only cookie `mw_token`, 30-day expiry
- bcryptjs hashing (10 rounds)
- First registered user auto-becomes admin
- API key auth via `X-API-Key` header for `/api/tasks*` endpoints
- Invite-only registration after first user exists

### Reference Value System
- `monitored_urls.reference_snapshot_id` → baseline snapshot for comparison
- On first scan: snapshot saved and set as reference automatically
- "Accept changes" = sets reference_snapshot_id to latest snapshot

### Concurrency
- `checkSemaphore` (max 5): limits concurrent URL checks globally
- `domainRateLimit`: enforces 1s gap between requests to same domain
- Retry: 3 attempts with exponential backoff (1s, 2s, 4s) on network error

### SSE Scan Progress
1. Frontend POST /urls/scan-all → receives `{ok, total}` JSON
2. Frontend opens EventSource to GET /api/scan-stream
3. Backend emits events via `scanEmitter` (EventEmitter)
4. Frontend updates progress bar, closes on `done` event

### New Monitored Fields (v2)
- `hreflang` — JSON array of `{lang, url}` from `<link rel="alternate">` (monitor_hreflang)
- `og_title`, `og_description`, `og_image` — Open Graph tags (monitor_og)
- `custom_text_found` — boolean: is `custom_text` string present (enabled when custom_text is set)

### Check interval → cron expression
- `< 60 min` → `*/N * * * *`
- `1h` → `0 * * * *`
- `Nh (N>1)` → `0 */N * * *`
- `24h` → `0 0 * * *`

### Routes

| Route | Auth | Description |
|-------|------|-------------|
| `GET /login` | none | Login form |
| `POST /login` | none | Authenticate, set JWT cookie |
| `POST /logout` | none | Clear JWT cookie |
| `GET/POST /register` | none | First user registration only |
| `GET/POST /invite/:token` | none | Register via invite link |
| `GET /` | auth | Dashboard (all URLs + charts + alerts) |
| `GET /?tab=problems` | auth | Problem URLs filter |
| `GET/POST /urls/add` | auth | Add new monitored URL |
| `GET/POST /urls/bulk` | auth | Bulk import (text/CSV/XLSX/sitemap) |
| `POST /urls/scan-all` | auth | Trigger background scan-all (JSON response) |
| `POST /urls/accept-all-changes` | auth | Bulk accept all changes |
| `GET /urls/:id?tab=*` | auth | URL detail (Overview/Changes/Snapshots/robots.txt) |
| `POST /urls/:id/toggle` | auth | Pause/resume |
| `POST /urls/:id/check-now` | auth | Manual sync check |
| `POST /urls/:id/accept-changes` | auth | Set current snapshot as reference |
| `POST /urls/:id/delete` | auth | Delete URL + cascade |
| `GET /export/report.xlsx` | auth | All URLs XLSX export |
| `GET /export/url/:id.xlsx` | auth | Single URL history XLSX |
| `GET /admin/users` | admin | User list |
| `POST /admin/invite` | admin | Create invite |
| `POST /admin/users/:id/revoke` | admin | Remove user |
| `GET /profile` | auth | Profile + API key |
| `GET /api/health` | none | Railway health check |
| `GET /api/stats` | auth | Chart data JSON |
| `GET /api/scan-stream` | auth | SSE stream for scan-all progress |
| `GET /api/tasks` | API key | External: list URLs |
| `GET /api/tasks/:id/results` | API key | External: latest snapshot |

### Views (EJS + `express-ejs-layouts`)
- `views/layout.ejs` — main layout (sidebar with user nav, Chart.js CDN, scan modal)
- `views/layout-auth.ejs` — minimal layout for login/register (no sidebar)
- Auth views pass `layout: 'layout-auth'` in render options
- `res.locals.user` set by `loadUserMiddleware` for all templates

### Adding a new monitored field
1. Add column to `snapshots` in `src/migrate.js` (ALTER TABLE ADD COLUMN IF NOT EXISTS)
2. Extract value in `src/scraper.js → scrapeUrl()`
3. Add to `MONITORED_FIELDS` array in `src/checker.js`
4. If needs toggle: add `monitor_*` boolean to `monitored_urls` in `src/migrate.js`
5. Add checkbox to `views/add-url.ejs`
6. Show in `views/url-detail.ejs` Overview tab + Snapshots table

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Recommended | JWT signing secret (random if not set — sessions lost on restart) |
| `SMTP_HOST` | No | Email alerts disabled if absent |
| `SMTP_PORT` | No | Default: 587 |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SMTP_FROM` | No | From address in emails |
| `BASE_URL` | No | Used for email links and invite links |
| `PORT` | No | Default: 3000 |

## Deployment (Railway)

- `railway.json` configures build (Nixpacks) and health check (`/api/health`)
- `Procfile` provides the start command as fallback
- Railway's PostgreSQL plugin injects `DATABASE_URL` automatically
- Migrations run on every startup — safe to run multiple times

## First-Run Setup

1. Start the app with `DATABASE_URL` set
2. Navigate to `/register` — create first account (becomes admin)
3. Go to `/admin/users` to invite additional users
4. Add URLs via `/urls/add` or `/urls/bulk`
5. Configure Telegram/webhook per URL in the Advanced Options section
