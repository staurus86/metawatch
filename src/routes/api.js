const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { requireAuth, requireApiKey, hashApiKey } = require('../auth');
const { scanEmitter, isScanRunning } = require('../scan-events');
const { getSchedulerStatus } = require('../scheduler');
const { getQueueStats } = require('../queue');
const { getWorkerStatus } = require('../workers');
const { ipKeyGenerator } = require('express-rate-limit');
const { version: APP_VERSION } = require('../../package.json');

const API_RATE_LIMIT_WINDOW_MS = Math.max(1000, parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '60000', 10) || 60000);
const API_RATE_LIMIT_MAX = Math.max(1, parseInt(process.env.API_RATE_LIMIT_MAX || '100', 10) || 100);

// Rate limit per API key (or IP for cookie/no-key requests)
const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const apiKey = String(req.headers['x-api-key'] || '').trim();
    if (apiKey) {
      // Keep raw API keys out of limiter keys/logging paths.
      return `api:${hashApiKey(apiKey)}`;
    }
    return `ip:${ipKeyGenerator(req.ip)}`;
  },
  message: { error: `Too many requests. Limit: ${API_RATE_LIMIT_MAX} per ${Math.round(API_RATE_LIMIT_WINDOW_MS / 1000)}s per API key or IP.` }
});
router.use(apiLimiter);

// Simple in-memory cache for chart/stats payload
const statsCache = new Map();
const STATS_CACHE_TTL_MS = 60 * 1000;
const STATS_CACHE_MAX_KEYS = 2000;

function pruneStatsCache() {
  const now = Date.now();
  for (const [key, value] of statsCache.entries()) {
    if (!value || (now - value.ts) > STATS_CACHE_TTL_MS * 3) {
      statsCache.delete(key);
    }
  }
  if (statsCache.size <= STATS_CACHE_MAX_KEYS) return;
  const oldest = [...statsCache.entries()]
    .sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0))
    .slice(0, statsCache.size - STATS_CACHE_MAX_KEYS);
  oldest.forEach(([key]) => statsCache.delete(key));
}

// GET /api/health — Railway health check
router.get('/health', async (req, res) => {
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    const dbLatencyMs = Date.now() - t0;
    const scheduler = getSchedulerStatus();
    const workerStatus = getWorkerStatus();

    const [
      { rows: [webhookRow] },
      { rows: [queueRow] },
      { rows: [lastCheckRow] },
      queueStats
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_webhooks
         FROM webhook_delivery_log`
      ),
      pool.query(`
        SELECT COUNT(*)::int AS pending_checks
        FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT checked_at
          FROM snapshots
          WHERE url_id = mu.id
          ORDER BY checked_at DESC
          LIMIT 1
        ) ls ON true
        WHERE mu.is_active = true
          AND (
            ls.checked_at IS NULL
            OR ls.checked_at < NOW() - make_interval(mins => mu.check_interval_minutes)
          )
      `),
      pool.query(`
        SELECT GREATEST(
          (SELECT MAX(checked_at) FROM snapshots),
          (SELECT MAX(checked_at) FROM uptime_checks)
        ) AS last_check_ran_at
      `),
      getQueueStats().catch(() => null)
    ]);

    const pendingWebhooks = webhookRow?.pending_webhooks || 0;
    const pendingChecks = queueRow?.pending_checks || 0;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      db_connected: true,
      scheduler_running: !!(scheduler.started && scheduler.hasLock),
      queue_backend: scheduler.queueBackend,
      worker_status: workerStatus,
      queue_stats: queueStats,
      last_check_ran_at: lastCheckRow?.last_check_ran_at || null,
      queue_depth: {
        pending_checks: pendingChecks,
        pending_webhooks: pendingWebhooks
      },
      uptime_seconds: Math.round(process.uptime()),
      version: APP_VERSION,
      uptime: process.uptime(),
      db_latency_ms: dbLatencyMs,
      pending_webhooks: pendingWebhooks,
      scheduler
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db_connected: false,
      scheduler_running: false,
      last_check_ran_at: null,
      queue_depth: null,
      uptime_seconds: Math.round(process.uptime()),
      version: APP_VERSION,
      error: err.message
    });
  }
});

// GET /api/urls — list monitored URLs (scoped to user for non-admins)
router.get('/urls', requireAuth, async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const userWhere = isAdmin ? '' : 'WHERE mu.user_id = $1';
  const params = isAdmin ? [] : [req.user.id];
  try {
    const { rows } = await pool.query(`
      SELECT mu.id, mu.url, mu.is_active, mu.check_interval_minutes,
             ls.status_code, ls.checked_at AS last_checked
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      ${userWhere}
      ORDER BY mu.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/url/:id/response-times — last 48 response_time_ms readings
router.get('/url/:id/response-times', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(400).json({ error: 'Invalid ID' });

  const isAdmin = req.user?.role === 'admin';
  try {
    // Ownership check
    const { rows: [owned] } = await pool.query(
      isAdmin
        ? 'SELECT id FROM monitored_urls WHERE id = $1'
        : 'SELECT id FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!owned) return res.status(404).json({ error: 'Not found' });

    const { rows } = await pool.query(`
      SELECT checked_at, response_time_ms
      FROM snapshots
      WHERE url_id = $1 AND response_time_ms IS NOT NULL
      ORDER BY checked_at DESC
      LIMIT 48
    `, [urlId]);

    res.json(rows.reverse()); // oldest first for chart
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/url/:id/change-heatmap — alert changes per day (last 365 days)
router.get('/url/:id/change-heatmap', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(400).json({ error: 'Invalid ID' });

  const isAdmin = req.user?.role === 'admin';
  try {
    const { rows: [owned] } = await pool.query(
      isAdmin
        ? 'SELECT id FROM monitored_urls WHERE id = $1'
        : 'SELECT id FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!owned) return res.status(404).json({ error: 'Not found' });

    const { rows } = await pool.query(
      `SELECT DATE(detected_at AT TIME ZONE 'UTC') AS d, COUNT(*)::int AS cnt
       FROM alerts
       WHERE url_id = $1
         AND detected_at >= NOW() - INTERVAL '365 days'
       GROUP BY DATE(detected_at AT TIME ZONE 'UTC')
       ORDER BY d ASC`,
      [urlId]
    );

    const out = {};
    for (const row of rows) {
      const key = row.d instanceof Date
        ? row.d.toISOString().slice(0, 10)
        : String(row.d || '').slice(0, 10);
      if (key) out[key] = parseInt(row.cnt, 10) || 0;
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — chart data (requires cookie auth)
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const cacheKey = req.user?.role === 'admin' ? 'admin:all' : `user:${req.user.id}`;
    const cached = statsCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < STATS_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const isAdmin = req.user?.role === 'admin';

    const summarySql = isAdmin ? `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code,
          COALESCE(s.noindex, false) AS noindex
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        ORDER BY s.url_id, s.checked_at DESC
      ),
      changed AS (
        SELECT DISTINCT a.url_id
        FROM alerts a
        JOIN monitored_urls mu ON mu.id = a.url_id
        WHERE a.detected_at > NOW() - INTERVAL '24 hours'
      )
      SELECT
        (SELECT COUNT(*)::int FROM monitored_urls) AS total_urls,
        (SELECT ROUND(AVG(health_score)::numeric, 1) FROM monitored_urls) AS avg_health_score,
        (SELECT COUNT(*)::int FROM latest) AS latest_count,
        (SELECT COUNT(*)::int FROM latest WHERE status_code = 0 OR status_code >= 400) AS error_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = true) AS noindex_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = false) AS indexed_count,
        (SELECT COUNT(*)::int
           FROM latest l
           JOIN changed c ON c.url_id = l.url_id
          WHERE l.status_code BETWEEN 1 AND 399) AS changed_count
    ` : `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code,
          COALESCE(s.noindex, false) AS noindex
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        WHERE mu.user_id = $1
        ORDER BY s.url_id, s.checked_at DESC
      ),
      changed AS (
        SELECT DISTINCT a.url_id
        FROM alerts a
        JOIN monitored_urls mu ON mu.id = a.url_id
        WHERE a.detected_at > NOW() - INTERVAL '24 hours'
          AND mu.user_id = $1
      )
      SELECT
        (SELECT COUNT(*)::int FROM monitored_urls WHERE user_id = $1) AS total_urls,
        (SELECT ROUND(AVG(health_score)::numeric, 1) FROM monitored_urls WHERE user_id = $1) AS avg_health_score,
        (SELECT COUNT(*)::int FROM latest) AS latest_count,
        (SELECT COUNT(*)::int FROM latest WHERE status_code = 0 OR status_code >= 400) AS error_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = true) AS noindex_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = false) AS indexed_count,
        (SELECT COUNT(*)::int
           FROM latest l
           JOIN changed c ON c.url_id = l.url_id
          WHERE l.status_code BETWEEN 1 AND 399) AS changed_count
    `;

    const statusSql = isAdmin ? `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        ORDER BY s.url_id, s.checked_at DESC
      )
      SELECT status_code, COUNT(*)::int AS cnt
      FROM latest
      GROUP BY status_code
    ` : `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        WHERE mu.user_id = $1
        ORDER BY s.url_id, s.checked_at DESC
      )
      SELECT status_code, COUNT(*)::int AS cnt
      FROM latest
      GROUP BY status_code
    `;

    const params = isAdmin ? [] : [req.user.id];
    const { rows: [summary] } = await pool.query(summarySql, params);
    const { rows: statusRows } = await pool.query(statusSql, params);

    const statusCodes = {};
    for (const row of statusRows) {
      statusCodes[String(row.status_code)] = parseInt(row.cnt, 10);
    }

    const totalUrls = summary?.total_urls || 0;
    const totalFromLatest = summary?.latest_count || 0;
    const changedCount = summary?.changed_count || 0;
    const unchangedCount = Math.max(0, totalFromLatest - changedCount);
    const errorCount = summary?.error_count || 0;
    const indexed = summary?.indexed_count || 0;
    const noindex = summary?.noindex_count || 0;
    const pendingCount = Math.max(0, totalUrls - totalFromLatest);
    const okCount = Math.max(0, totalUrls - errorCount - changedCount - pendingCount);

    // Alerts per day for last 30 days (scoped to user)
    const alertsParams = isAdmin ? [] : [req.user.id];
    const alertsUserWhere = isAdmin ? '' : 'AND mu.user_id = $1';
    const { rows: alertsPerDay } = await pool.query(`
      SELECT DATE(a.detected_at AT TIME ZONE 'UTC') AS date,
             COUNT(*) AS count
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE a.detected_at > NOW() - INTERVAL '30 days' ${alertsUserWhere}
      GROUP BY DATE(a.detected_at AT TIME ZONE 'UTC')
      ORDER BY date ASC
    `, alertsParams);

    const payload = {
      statusCodes,
      summary: {
        total: totalUrls,
        ok: okCount,
        changed: changedCount,
        error: errorCount,
        pending: pendingCount,
        avg_health_score: summary?.avg_health_score != null ? Number(summary.avg_health_score) : null
      },
      indexability: { indexed, noindex },
      changeStatus: { changed: changedCount, unchanged: unchangedCount },
      alertsPerDay: alertsPerDay.map(r => ({
        date: r.date,
        count: parseInt(r.count, 10)
      }))
    };

    pruneStatsCache();
    statsCache.set(cacheKey, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan-stream — SSE progress stream
router.get('/scan-stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Send current status immediately
  write({ type: 'connected', running: isScanRunning() });

  const onProgress = (data) => write(data);
  const onDone = (data) => {
    write(data);
    cleanup();
    res.end();
  };

  scanEmitter.on('scan-progress', onProgress);
  scanEmitter.on('scan-done', onDone);

  // Keepalive every 20s
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 20000);

  function cleanup() {
    scanEmitter.off('scan-progress', onProgress);
    scanEmitter.off('scan-done', onDone);
    clearInterval(keepalive);
  }

  req.on('close', cleanup);
});

// ─── API Key protected endpoints ─────────────────────────────────────────────

// GET /api/tasks — list monitored URLs (external API, scoped to API key owner)
router.get('/tasks', requireApiKey, async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const userWhere = isAdmin ? '' : 'WHERE mu.user_id = $1';
  const params = isAdmin ? [] : [req.user.id];
  try {
    const { rows } = await pool.query(`
      SELECT mu.id, mu.url, mu.is_active, mu.check_interval_minutes,
             mu.monitor_title, mu.monitor_description, mu.monitor_h1,
             mu.monitor_body, mu.monitor_status_code, mu.monitor_noindex,
             mu.monitor_redirect, mu.monitor_canonical, mu.monitor_robots,
             mu.monitor_hreflang, mu.monitor_og,
             ls.status_code, ls.checked_at AS last_checked,
             COALESCE(ac.cnt, 0)::int AS alert_count_24h
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      ${userWhere}
      ORDER BY mu.id
    `, params);
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/:id/results — latest snapshot
router.get('/tasks/:id/results', requireApiKey, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(400).json({ error: 'Invalid task ID' });

  try {
    const isAdmin = req.user?.role === 'admin';
    const { rows: [urlRecord] } = await pool.query(
      isAdmin
        ? 'SELECT id, url FROM monitored_urls WHERE id = $1'
        : 'SELECT id, url FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!urlRecord) return res.status(404).json({ error: 'Task not found' });

    const { rows: [snapshot] } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );

    const { rows: recentAlerts } = await pool.query(
      `SELECT field_changed, old_value, new_value, detected_at
       FROM alerts WHERE url_id = $1
       ORDER BY detected_at DESC LIMIT 10`,
      [urlId]
    );

    res.json({
      task: urlRecord,
      latest_snapshot: snapshot || null,
      recent_alerts: recentAlerts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Uptime API ───────────────────────────────────────────────────────────────

// GET /api/uptime — list all monitors (cookie auth)
router.get('/uptime', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userWhere = isAdmin ? '' : 'WHERE user_id = $1';
    const params = isAdmin ? [] : [req.user.id];
    const { rows } = await pool.query(
      `SELECT id, name, url, slug, interval_minutes, is_active, is_public, threshold_ms, created_at
       FROM uptime_monitors ${userWhere} ORDER BY created_at ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/uptime/:id/status — current status + last 10 checks
router.get('/uptime/:id/status', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  const isAdmin = req.user?.role === 'admin';
  try {
    const { rows: [monitor] } = await pool.query(
      isAdmin
        ? 'SELECT * FROM uptime_monitors WHERE id = $1'
        : 'SELECT * FROM uptime_monitors WHERE id = $1 AND user_id = $2',
      isAdmin ? [monitorId] : [monitorId, req.user.id]
    );
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    const { rows: checks } = await pool.query(
      'SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 10',
      [monitorId]
    );
    res.json({ monitor, last_checks: checks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/uptime/:id/rt — response time data for Chart.js (last 48 checks)
router.get('/uptime/:id/rt', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  const isAdmin = req.user?.role === 'admin';
  try {
    const { rows: [monitor] } = await pool.query(
      isAdmin
        ? 'SELECT id FROM uptime_monitors WHERE id = $1'
        : 'SELECT id FROM uptime_monitors WHERE id = $1 AND user_id = $2',
      isAdmin ? [monitorId] : [monitorId, req.user.id]
    );
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    const { rows } = await pool.query(
      `SELECT checked_at, response_time_ms, status
       FROM uptime_checks
       WHERE monitor_id = $1 AND response_time_ms IS NOT NULL
       ORDER BY checked_at DESC LIMIT 48`,
      [monitorId]
    );
    res.json(rows.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/uptime/check-domain?domain=example.com — for browser extension
// Auth: X-API-Key header
router.get('/uptime/check-domain', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-API-Key required' });

  try {
    const { rows: [user] } = await pool.query(
      'SELECT id FROM users WHERE api_key = $1 OR api_key_hash = $2',
      [apiKey, hashApiKey(apiKey)]
    );
    if (!user) return res.status(401).json({ error: 'Invalid API key' });

    const domain = (req.query.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!domain) return res.status(400).json({ error: 'domain param required' });

    const { rows: [monitor] } = await pool.query(
      `SELECT um.id, um.name, um.url, um.threshold_ms,
              lc.status, lc.response_time_ms, lc.checked_at AS last_checked_at
       FROM uptime_monitors um
       LEFT JOIN LATERAL (
         SELECT status, response_time_ms, checked_at FROM uptime_checks
         WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
       ) lc ON true
       WHERE um.user_id = $1 AND um.url ILIKE $2
       ORDER BY um.created_at ASC LIMIT 1`,
      [user.id, `%${domain}%`]
    );

    if (!monitor) return res.json({ monitored: false, domain });

    const { rows: [pctRow] } = await pool.query(
      `SELECT ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS pct
       FROM uptime_checks WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '30 days'`,
      [monitor.id]
    );

    res.json({
      monitored: true,
      domain,
      monitor_id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      status: monitor.status || 'unknown',
      response_time_ms: monitor.response_time_ms,
      last_checked_at: monitor.last_checked_at,
      uptime_30d: pctRow?.pct ?? null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/docs — public API documentation page
router.get('/docs', (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const limitWindowSec = Math.round(API_RATE_LIMIT_WINDOW_MS / 1000);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MetaWatch API Docs</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #2d3748; background: #f7fafc; }
    h1 { font-size: 28px; color: #1a202c; margin-bottom: 4px; }
    h2 { font-size: 18px; margin-top: 36px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
    h3 { font-size: 15px; margin-top: 20px; color: #4a5568; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; }
    .get { background: #ebf8ff; color: #2b6cb0; }
    .post { background: #f0fff4; color: #2f855a; }
    .put { background: #fffaf0; color: #b7791f; }
    code, pre { background: #1a202c; color: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    pre { padding: 14px 18px; overflow-x: auto; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
    th { background: #f0f4f8; font-weight: 700; }
    .note { background: #fffaf0; border: 1px solid #fbd38d; border-radius: 6px; padding: 12px 16px; font-size: 13px; }
  </style>
</head>
<body>
  <h1>MetaWatch API</h1>
  <p style="color:#718096">REST API for external access to monitored URLs and uptime data.</p>

  <h2>Authentication</h2>
  <p>Pass your API key in the <code>X-API-Key</code> header on every request.</p>
  <p>Find your API key at <a href="${baseUrl}/profile">${baseUrl}/profile</a>.</p>
  <pre>curl -H "X-API-Key: YOUR_KEY" ${baseUrl}/api/v2/urls</pre>

  <h2>Rate Limits</h2>
  <div class="note">${API_RATE_LIMIT_MAX} requests per ${limitWindowSec}s per API key (or per IP if no API key). Exceeding returns <code>429</code>.</div>

  <h2>API v2 Envelope</h2>
  <p>All <code>/api/v2</code> endpoints use one standard response format.</p>
  <pre>{
  "data": [],
  "meta": { "total": 0, "page": 1, "per_page": 25, "pages": 1 },
  "error": null
}</pre>

  <h2>API v2 Endpoints</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/urls</code></td><td>API Key</td><td>URLs list with filters/sort/pagination</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/urls/:id</code></td><td>API Key</td><td>URL config + latest snapshot</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/urls/:id/snapshots</code></td><td>API Key</td><td>Paginated snapshots for URL</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/urls/:id/alerts</code></td><td>API Key</td><td>Paginated URL alerts with severity/date filters</td></tr>
      <tr><td><span class="badge post">POST</span></td><td><code>/api/v2/urls/:id/check</code></td><td>API Key</td><td>Queue immediate URL check</td></tr>
      <tr><td><span class="badge put">PUT</span></td><td><code>/api/v2/urls/:id/accept-changes</code></td><td>API Key</td><td>Accept pending changes as new reference</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/urls/:id/change-heatmap</code></td><td>API Key</td><td>Change counts by day (last 365 days)</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/uptime</code></td><td>API Key</td><td>All uptime monitors + current stats</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/uptime/:id</code></td><td>API Key</td><td>Monitor details + 1h/24h/7d/30d uptime</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/uptime/:id/incidents</code></td><td>API Key</td><td>Paginated incidents for monitor</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/alerts</code></td><td>API Key</td><td>Cross-URL alerts feed with filters</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/v2/stats</code></td><td>API Key</td><td>Dashboard stats in v2 envelope</td></tr>
    </tbody>
  </table>

  <h2>API v2 Query Params</h2>
  <p><code>/api/v2/urls</code>: <code>page</code>, <code>per_page</code>, <code>q</code>, <code>tag</code>, <code>project_id</code>, <code>status</code> (<code>ok|changed|error|paused</code>), <code>sort</code> (<code>last_checked|health_score|url</code>), <code>dir</code> (<code>asc|desc</code>).</p>
  <p><code>/api/v2/alerts</code>: <code>page</code>, <code>per_page</code>, <code>severity</code>, <code>field</code>, <code>from</code>, <code>to</code>, <code>url_id</code>.</p>
  <p><code>/api/v2/urls/:id/snapshots</code> and <code>/api/v2/urls/:id/alerts</code>: support <code>page</code>, <code>per_page</code>, <code>from</code>, <code>to</code>.</p>

  <h2>API v2 cURL Examples</h2>
  <h3>List URLs</h3>
  <pre>curl -H "X-API-Key: YOUR_KEY" "${baseUrl}/api/v2/urls?page=1&per_page=25&status=changed&sort=health_score&dir=asc"</pre>

  <h3>URL details</h3>
  <pre>curl -H "X-API-Key: YOUR_KEY" ${baseUrl}/api/v2/urls/123</pre>

  <h3>Queue immediate check</h3>
  <pre>curl -X POST -H "X-API-Key: YOUR_KEY" ${baseUrl}/api/v2/urls/123/check</pre>

  <h3>Accept changes</h3>
  <pre>curl -X PUT -H "X-API-Key: YOUR_KEY" ${baseUrl}/api/v2/urls/123/accept-changes</pre>

  <h3>Uptime monitor details</h3>
  <pre>curl -H "X-API-Key: YOUR_KEY" ${baseUrl}/api/v2/uptime/45</pre>

  <h3>Response example</h3>
  <pre>{
  "data": [
    {
      "id": 1,
      "url": "https://example.com",
      "status": "changed",
      "health_score": 82,
      "last_checked": "2026-03-02T08:10:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "per_page": 25, "pages": 1 },
  "error": null
}</pre>

  <h2>Legacy API (v1)</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/health</code></td><td>—</td><td>Health check</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/tasks</code></td><td>API Key</td><td>List monitored URLs</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/tasks/:id/results</code></td><td>API Key</td><td>URL latest results</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/uptime/check-domain?domain=</code></td><td>API Key</td><td>Domain check for extension</td></tr>
      <tr><td><span class="badge get">GET</span></td><td><code>/api/stats</code></td><td>Cookie</td><td>Dashboard chart data</td></tr>
    </tbody>
  </table>

  <h3>Error responses</h3>
  <pre>{ "error": "Unauthorized" }  // 401
{ "error": "Not found" }       // 404
 { "error": "Too many requests..." }  // 429</pre>

  <p style="margin-top:40px;color:#a0aec0;font-size:13px">MetaWatch API docs · <a href="${baseUrl}">Back to dashboard</a></p>
</body>
</html>`);
});

// GET /api/competitor/:id/title-history — Chart.js data for competitor comparison
router.get('/competitor/:id/title-history', requireAuth, async (req, res) => {
  const competitorId = parseInt(req.params.id, 10);
  if (isNaN(competitorId)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const { rows: [comp] } = await pool.query(
      'SELECT * FROM competitor_urls WHERE id = $1 AND user_id = $2',
      [competitorId, req.user.id]
    );
    if (!comp) return res.status(404).json({ error: 'Not found' });

    const { rows: compSnaps } = await pool.query(
      `SELECT checked_at, title FROM competitor_snapshots
       WHERE competitor_url_id = $1 ORDER BY checked_at DESC LIMIT 30`,
      [competitorId]
    );

    const { rows: yourSnaps } = await pool.query(
      `SELECT checked_at, title FROM snapshots
       WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 30`,
      [comp.your_url_id]
    );

    const labels = compSnaps.map(r => {
      const dt = new Date(r.checked_at);
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }).reverse();

    res.json({
      labels,
      yours:  yourSnaps.reverse().map(r => (r.title || '').length),
      theirs: compSnaps.reverse().map(r => (r.title || '').length)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
