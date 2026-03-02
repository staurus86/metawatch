# MetaWatch Project Audit (2026-03-02)

## Scope
- Audit type: codebase audit (routes, workers, migrations, UI, exports).
- Runtime check source: project code and latest repository state.
- Goal: document what is already working, what depends on environment config, and what is still pending.

## Repository Snapshot
- Branch: `master`
- Latest commits:
  - `24e21c1` billing/report gating
  - `6d10edf` reports center + project exports
  - `c7b54c8` styled PDF exports + plan-gated reports
  - `ed80a2f` web/worker runtime split + queue admin stabilization
  - `da29d54` Sprint 9 core (health score, API v2, integrations, headless)

## Runtime Model (important)

### What each flag does
- `ENABLE_WEB`: starts HTTP server.
- `ENABLE_SCHEDULER`: starts cron scheduler in this process.
- `ENABLE_QUEUE_WORKERS`: starts BullMQ workers in this process.
- `REDIS_URL`: enables BullMQ mode (`queue_backend = redis (bullmq)`), otherwise fallback is in-memory queues.

### Why web can show "workers off" while worker is online
- `/api/health` and `/admin/system` show state of the current process only.
- In split deployment, web process usually reports workers off, and worker process reports workers on.
- This is expected if worker runs as a separate Railway service.

## Functional Audit Matrix

| Block | Status | What works now | Evidence |
|---|---|---|---|
| Auth and roles | Implemented | Cookie auth, API key auth, admin role checks, invite flow | `src/auth.js`, `src/routes/admin.js` |
| Plans and subscriptions | Implemented | `plans`/`subscriptions` schema, plan enforcement on URLs/uptime/projects, middleware `req.userPlan` | `src/migrate.js`, `src/plans.js`, `src/routes/urls.js`, `src/routes/uptime.js`, `src/routes/projects.js` |
| Manual plan assignment | Implemented | Admin can set user plan + subscription status manually | `src/routes/admin.js` (`POST /admin/users/:id/plan`), `views/admin.ejs` |
| Billing page | Implemented | Current plan, usage, upgrade flow, plan comparison, report entitlement messaging | `src/routes/billing.js`, `views/billing.ejs` |
| Stripe integration | Env-dependent | Checkout, success/cancel, webhook event handling (`checkout.session.completed`, `customer.subscription.updated/deleted`, `invoice.payment_failed`) | `src/routes/billing.js` |
| Landing page | Implemented | Logged-out users see landing, logged-in redirect to dashboard | `src/routes/landing.js`, `views/landing.ejs` |
| Help center | Implemented | `/help` with RU/EN content sections | `src/routes/help.js`, `views/help.ejs` |
| i18n foundation | Implemented | RU/EN locale loading and middleware | `src/i18n.js`, `locales/en`, `locales/ru` |
| Projects (meta grouping) | Implemented | CRUD projects, limits by plan, grouped/project dashboard mode, project reports | `src/routes/projects.js`, `src/routes/dashboard.js`, `views/projects.ejs` |
| Meta monitoring core | Implemented | Snapshot checks, field diffs, alerts, accept-all and accept-selected | `src/checker.js`, `src/routes/urls.js`, `views/url-detail.ejs` |
| URL health score | Implemented | Score calculation, reasons tooltip, filter unhealthy, sorting | `src/checker.js`, `src/routes/dashboard.js`, `views/dashboard.ejs` |
| Per-field notification override | Implemented | `fields_notification_config` modes (`default/silent/email_only/telegram_only/slack_only/critical_only`) | `src/checker.js`, `src/routes/urls.js`, `views/add-url.ejs`, `views/edit-url.ejs` |
| Uptime monitoring | Implemented | Monitors, incidents, checks, public and internal pages | `src/routes/uptime.js`, `src/uptime-checker.js`, `src/routes/status.js` |
| Public uptime page UX | Implemented | 90-day daily block + 7-day daily block + 24h hourly block + latency insights | `src/routes/status.js`, `views/status.ejs` |
| White-label status pages | Implemented (Agency-gated) | Custom domain, logo URL, primary color, hide powered by | `src/routes/status-pages.js`, `views/status-pages-edit.ejs`, `src/index.js` (host routing) |
| Integrations: Discord | Implemented | URL and uptime Discord webhook alerts + logging | `src/notifier.js`, `src/uptime-checker.js`, `src/routes/urls.js`, `src/routes/uptime.js` |
| Integrations: Slack OAuth | Env-dependent | Connect/disconnect/test + channel selector + Slack notifications | `src/routes/integrations.js`, `src/notifier.js`, `views/integrations.ejs` |
| Integrations: PagerDuty | Implemented | Connect/disconnect/test + trigger/resolve events | `src/routes/integrations.js`, `src/notifier.js`, `src/routes/api-v2.js`, `src/routes/urls.js` |
| API v2 | Implemented | `/api/v2/urls`, `/snapshots`, `/alerts`, `/check`, `/accept-changes`, `/uptime`, `/incidents`, `/stats`, heatmap endpoint | `src/routes/api-v2.js`, `src/routes/api.js` docs section |
| Reports center and exports | Implemented | Dashboard/URL/project/uptime PDF+XLSX and Alerts CSV, plan-based access and range limits | `src/routes/reports.js`, `src/routes/export.js`, `src/report-access.js`, `views/reports.ejs` |
| Scheduled PDF digest | Implemented (plan-gated) | Digest attachments weekly/monthly, plan entitlement check | `src/scheduler.js`, `src/routes/profile.js`, `src/report-access.js` |
| Queue and workers (BullMQ) | Implemented, env-dependent | Redis queue backend, meta/uptime/notification workers, dedup windows and Redis locks, queue stats | `src/queue.js`, `src/workers/*`, `src/routes/admin-queues.js` |
| Queue dashboard | Env-dependent | `/admin/queues` works only when `REDIS_URL` available on that service | `src/routes/admin-queues.js`, `views/admin-queues-unavailable.ejs` |
| Headless JS rendering | Implemented, env-dependent | Per-URL render mode, plan gating (Pro/Agency), fallback warning when disabled | `src/headless-scraper.js`, `src/checker.js`, `src/routes/urls.js`, `views/url-detail.ejs` |
| PWA base | Implemented | Manifest link in layout, service worker and offline page in `public` | `views/layout.ejs`, `public/sw.js`, `public/offline.html` |
| Admin system telemetry | Implemented | `/admin/system` with DB/queue/scheduler/slow query stats | `src/routes/admin.js`, `views/admin-system.ejs` |

## What Is Not Fully Implemented (or intentionally optional)

1. Web Push notifications (Phase 2)
- Not implemented in this repository.
- No `web-push` package or push subscription flow found.

2. Automated tests/CI verification
- No test suite/scripts found in `package.json`.
- Deploy safety currently relies on runtime smoke checks.

3. Documentation drift
- `README.md` and `.env.example` do not fully document all newer queue/worker vars (`REDIS_URL`, `ENABLE_WEB`, `ENABLE_QUEUE_WORKERS`, worker concurrency/lock vars, etc.).
- Functionality exists in code, but docs are behind.

## Current Ops Checklist (recommended baseline)

### Mandatory
- `DATABASE_URL`
- `JWT_SECRET`
- `BASE_URL`

### Queue mode (for BullMQ)
- `REDIS_URL`
- Web service: `ENABLE_WEB=true`, `ENABLE_SCHEDULER=true`, `ENABLE_QUEUE_WORKERS=false`
- Worker service: `ENABLE_WEB=false`, `ENABLE_SCHEDULER=false`, `ENABLE_QUEUE_WORKERS=true`

### Optional integrations
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_*`
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`
- Telegram fallback: `TELEGRAM_BOT_TOKEN`
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Headless: `ENABLE_HEADLESS=true` (and environment that can run Chromium/Puppeteer)

## Practical Conclusion
- Product functionality requested in Sprint 8/9 is broadly implemented in code.
- Main remaining risk is operational consistency across services (ENV parity) and lack of automated regression tests.
- If web health still shows `queue_backend: in-memory`, Redis is not active on that web process even if a worker service exists.
