# MetaWatch Ops Runbook (Railway)

## 1. Deployment Topology

Recommended production layout:

- Service A (`web`)
  - serves HTTP
  - owns scheduler lock
- Service B (`worker`)
  - runs BullMQ workers only
  - no public HTTP

Both services must use the same:

- `DATABASE_URL`
- `REDIS_URL`
- app source revision

## 2. Environment Profiles

### Web service

```env
ENABLE_WEB=true
ENABLE_SCHEDULER=true
ENABLE_QUEUE_WORKERS=false
```

### Worker service

```env
ENABLE_WEB=false
ENABLE_SCHEDULER=false
ENABLE_QUEUE_WORKERS=true
```

## 3. Health and Diagnostics

Primary checks:

1. `GET /api/health` on web
2. `GET /admin/system` (admin)
3. `GET /admin/queues` (admin, requires Redis mode)

Notes:

- `/api/health` keeps legacy flat fields and also exposes structured blocks under `checks` and `runtime`.
- `/admin/system` uses short-lived in-memory caching; use `/admin/system?refresh=1` for a forced fresh snapshot.

Expected in Redis mode:

- `queue_backend: "redis (bullmq)"`
- queue stats not null
- worker logs show startup lines:
  - `Meta worker started`
  - `Uptime worker started`
  - `Notification worker started`

## 4. Common Misconfigurations

1. `queue_backend` is `in-memory`
- Cause: `REDIS_URL` missing on that process.
- Fix: set `REDIS_URL` on both web and worker services.

2. Web healthy, but jobs are not processed
- Cause: worker service has `ENABLE_QUEUE_WORKERS=false`.
- Fix: set `ENABLE_QUEUE_WORKERS=true` on worker.

3. Duplicate scheduling risk
- Cause: scheduler enabled on worker too.
- Fix: worker must run `ENABLE_SCHEDULER=false`.

4. Queue dashboard shows unavailable page
- Cause: Redis not configured or BullMQ not active in current process.
- Fix: ensure `REDIS_URL` present and deployment uses current build.

## 5. Pre-Deploy Checklist

Run in CI/local before push:

```bash
npm run smoke:code
npm test
```

Optional environment checks:

```bash
npm run doctor:web
npm run doctor:worker
```

Optional DB preflight (requires `DATABASE_URL`):

```bash
npm run db:migrate
npm run db:explain
```

`db:explain` writes `db-explain-report.json` with `EXPLAIN (ANALYZE, BUFFERS)` summaries for top-heavy queries.

## 6. Post-Deploy Checklist

1. Open `/api/health` and confirm DB connected.
2. Open `/admin/system`, confirm scheduler and queue backend.
3. Trigger one manual URL check and one uptime check.
4. Verify `notification_log` receives fresh records.
5. Verify reports export (`/reports`) opens and generates files.
