const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, requireApiKey } = require('../auth');
const { scanEmitter, isScanRunning } = require('../scan-events');

// GET /api/health — Railway health check
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
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

// GET /api/stats — chart data (requires cookie auth)
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userWhere = isAdmin ? '' : 'AND mu.user_id = $1';
    const params = isAdmin ? [] : [req.user.id];

    // Latest snapshot per URL (scoped to user)
    const { rows: latest } = await pool.query(`
      SELECT DISTINCT ON (s.url_id) s.url_id, s.status_code, s.noindex
      FROM snapshots s
      JOIN monitored_urls mu ON mu.id = s.url_id
      WHERE true ${userWhere}
      ORDER BY s.url_id, s.checked_at DESC
    `, params);

    const statusCodes = {};
    let indexed = 0, noindex = 0;

    for (const r of latest) {
      const code = String(r.status_code || 0);
      statusCodes[code] = (statusCodes[code] || 0) + 1;
      if (r.noindex) noindex++; else indexed++;
    }

    // Changed vs unchanged (24h alert activity, scoped to user)
    const { rows: changed24h } = await pool.query(`
      SELECT DISTINCT a.url_id
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE a.detected_at > NOW() - INTERVAL '24 hours' ${userWhere}
    `, params);
    const changedSet = new Set(changed24h.map(r => r.url_id));
    const totalUrls = latest.length;
    const changedCount = changedSet.size;
    const unchangedCount = totalUrls - changedCount;

    // Alerts per day for last 30 days (scoped to user)
    const { rows: alertsPerDay } = await pool.query(`
      SELECT DATE(a.detected_at AT TIME ZONE 'UTC') AS date,
             COUNT(*) AS count
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE a.detected_at > NOW() - INTERVAL '30 days' ${userWhere}
      GROUP BY DATE(a.detected_at AT TIME ZONE 'UTC')
      ORDER BY date ASC
    `, params);

    res.json({
      statusCodes,
      indexability: { indexed, noindex },
      changeStatus: { changed: changedCount, unchanged: unchangedCount },
      alertsPerDay: alertsPerDay.map(r => ({
        date: r.date,
        count: parseInt(r.count, 10)
      }))
    });
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
    const { rows: [urlRecord] } = await pool.query(
      'SELECT id, url FROM monitored_urls WHERE id = $1', [urlId]
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
      'SELECT id FROM users WHERE api_key = $1',
      [apiKey]
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
