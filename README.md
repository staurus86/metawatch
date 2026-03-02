# MetaWatch

MetaWatch is a self-hosted monitoring platform for SEO/meta fields and uptime.

## Run locally

```bash
npm install
npm run dev
```

Environment variables are documented in `.env.example`.

## Runtime Modes (Railway)

MetaWatch supports both single-process and split `web + worker` deployments.

- `web` mode: serves HTTP routes, usually holds scheduler lock.
- `worker` mode: processes BullMQ jobs only (no HTTP).

Recommended split setup:

- Web service:
  - `ENABLE_WEB=true`
  - `ENABLE_SCHEDULER=true`
  - `ENABLE_QUEUE_WORKERS=false`
  - `REDIS_URL=<shared redis>`
- Worker service:
  - `ENABLE_WEB=false`
  - `ENABLE_SCHEDULER=false`
  - `ENABLE_QUEUE_WORKERS=true`
  - `REDIS_URL=<shared redis>`

Useful checks:

```bash
npm run doctor:web
npm run doctor:worker
npm run smoke:code
```

## Production hardening flags

Key production flags (see `.env.example` for full list):

- `ENABLE_OUTBOUND_SAFETY=true` blocks private/internal outbound targets (SSRF guard).
- `ENABLE_ALERT_STATE_ENGINE=true` enables cooldown/state-based alert suppression.
- `DEFAULT_ALERT_COOLDOWN_MINUTES=60` controls duplicate alert cooldown.
- `SLOW_QUERY_MS=250` logs slow SQL queries.
- `WEBHOOK_SIGNING_SECRET=` adds `X-MetaWatch-Signature` HMAC header to outgoing webhooks.
- `ENABLE_SCHEDULER=true` controls cron startup (useful for web/worker split).
- `ENABLE_WEB` and `ENABLE_QUEUE_WORKERS` control split runtime roles.
- `REDIS_URL` enables BullMQ queues and `/admin/queues`.
- `API_RATE_LIMIT_WINDOW_MS` and `API_RATE_LIMIT_MAX` tune `/api` rate limiting.
- `ALERT_RETENTION_DAYS`, `NOTIFICATION_LOG_RETENTION_DAYS`, `WEBHOOK_LOG_RETENTION_DAYS` control data retention.

## Reports & Plans

- Reports Center: `/reports`
- Exports: `/export/*` (PDF/XLSX/CSV, plan-gated by `src/report-access.js`)
- Billing and plan usage: `/billing`
- Manual admin plan assignment: `/admin/users`

Detailed docs:

- `PROJECT_AUDIT_2026-03-02.md`
- `OPS_RUNBOOK_RAILWAY.md`
- `PLAN_FEATURE_MATRIX.md`
- `REPORTS_REFERENCE.md`

## Browser Extension

The Chrome extension lives in [`/extension`](./extension) and lets you quickly check if the current domain is monitored in MetaWatch uptime.

### Load unpacked extension (Chrome)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the local `extension` folder from this repository.

### Configure extension

1. Click the extension icon.
2. Click the gear icon to open settings.
3. Fill in:
   - **MetaWatch URL** (your deployed app URL)
   - **API Key**
4. Click **Save Settings**.
5. Optional: click **Test Connection** (checks `/api/health`).

### Where to get API key

Open your MetaWatch profile page:

- `/profile` in your MetaWatch app

Use the generated API key from **Profile & API Key** in extension settings.
