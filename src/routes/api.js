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

// GET /api/urls — list all monitored URLs (auth via cookie or API key)
router.get('/urls', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT mu.id, mu.url, mu.is_active, mu.check_interval_minutes,
             ls.status_code, ls.checked_at AS last_checked
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      ORDER BY mu.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — chart data (requires cookie auth)
router.get('/stats', requireAuth, async (req, res) => {
  try {
    // Latest snapshot per URL
    const { rows: latest } = await pool.query(`
      SELECT DISTINCT ON (url_id) url_id, status_code, noindex
      FROM snapshots
      ORDER BY url_id, checked_at DESC
    `);

    const statusCodes = {};
    let indexed = 0, noindex = 0;

    for (const r of latest) {
      const code = String(r.status_code || 0);
      statusCodes[code] = (statusCodes[code] || 0) + 1;
      if (r.noindex) noindex++; else indexed++;
    }

    // Changed vs unchanged (24h alert activity)
    const { rows: changed24h } = await pool.query(
      `SELECT DISTINCT url_id FROM alerts WHERE detected_at > NOW() - INTERVAL '24 hours'`
    );
    const changedSet = new Set(changed24h.map(r => r.url_id));
    const totalUrls = latest.length;
    const changedCount = changedSet.size;
    const unchangedCount = totalUrls - changedCount;

    // Alerts per day for last 30 days
    const { rows: alertsPerDay } = await pool.query(`
      SELECT DATE(detected_at AT TIME ZONE 'UTC') AS date,
             COUNT(*) AS count
      FROM alerts
      WHERE detected_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(detected_at AT TIME ZONE 'UTC')
      ORDER BY date ASC
    `);

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

// GET /api/tasks — list monitored URLs (external API)
router.get('/tasks', requireApiKey, async (req, res) => {
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
      ORDER BY mu.id
    `);
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

module.exports = router;
